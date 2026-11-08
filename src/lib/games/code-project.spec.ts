import { expect, it } from 'vitest';
import {
	compileCodeProject,
	createCodeProject,
	parseCodeProject,
	type CodeProject
} from './code-project.js';
import { evaluateAction } from './scripting/engine.js';
import { createGameRepository } from './repository-core.js';
import { memoryStorage } from '#lib/testing/memory-storage.js';
import { editorContent } from './editor.js';
import { compileGameUI } from './ui/runtime/compiler.js';

function fixture(): CodeProject {
	return {
		version: 1,
		entry: 'main.ts',
		files: {
			'main.ts': {
				language: 'typescript',
				source:
					"export { default as logic } from './logic';\nexport { default as ui } from './ui';\n"
			},
			'logic.ts': {
				language: 'typescript',
				source:
					"import { gain } from './shared';\nimport type { GameState } from '@helia/state';\nexport default function register() { helia.defineAction({name:'gain',arguments:{type:'object',properties:{},additionalProperties:false},run({state}:{state:GameState}) {state.gold=gain(state.gold);return state;}}); }"
			},
			'shared.ts': {
				language: 'typescript',
				source: 'export function gain(value:number) {return value+2;}'
			},
			'ui.tsx': {
				language: 'tsx',
				source:
					"import { registerPanel } from '@helia/ui';\nimport { gain } from './shared';\nexport default function start(){return registerPanel({id:'status',title:'Status',component:()=> <span>{gain(1)}</span>});}"
			}
		}
	};
}
const stateDocument = {
	schema: {
		type: 'object' as const,
		properties: { gold: { type: 'integer' as const } },
		required: ['gold'],
		additionalProperties: false as const
	},
	initialState: { gold: 1 }
};

it('builds one entry into isolated reachable graphs and runs imported logic in QuickJS', async () => {
	const project = fixture();
	const compiled = await compileCodeProject(project);
	expect(Object.keys(compiled.ui!.modules)).toEqual(['ui.tsx', 'shared.ts']);
	expect(compiled.scripts.project.source).not.toContain('registerPanel');
	expect(
		(
			await evaluateAction({
				...stateDocument,
				state: stateDocument.initialState,
				scripts: compiled.scripts,
				action: { name: 'gain', args: {} }
			})
		).state
	).toEqual({ gold: 3 });
	expect(project.files['shared.ts'].source).toContain('value:number');
});
it('does not execute creator sources in the host during compilation', async () => {
	const project = fixture();
	project.files['logic.ts'].source =
		'throw new Error("must execute only in sandbox"); export default function register(){}';
	await expect(compileCodeProject(project)).resolves.toHaveProperty('scripts.project');
});

it('resolves directory index imports consistently in project builds and UI execution', async () => {
	const project = fixture();
	project.files['shared/index.ts'] = project.files['shared.ts'];
	delete project.files['shared.ts'];
	const compiled = await compileCodeProject(project);
	expect(compiled.ui?.modules).toHaveProperty('shared/index.ts');
	await expect(compileGameUI(compiled.ui!, 'test')).resolves.toContain('shared/index.ts');
});
it.each([
	["export {default as logic} from '../outside';", 'main.ts'],
	["export {default as logic} from './missing';", 'main.ts'],
	['globalThis.sideEffect=1; export {};', 'main.ts']
])('diagnoses invalid entry definitions with source locations (%s)', async (source, file) => {
	const project = fixture();
	project.files['main.ts'].source = source;
	await expect(compileCodeProject(project)).rejects.toMatchObject({
		file,
		line: 1,
		column: expect.any(Number)
	});
});
it('rejects runtime cross-imports and dynamic imports before any source executes', async () => {
	const project = fixture();
	project.files['logic.ts'].source = "import './ui'; export default function register(){}";
	await expect(compileCodeProject(project)).rejects.toMatchObject({ file: 'ui.tsx' });
	project.files['logic.ts'].source = "export default function register(){ import('./shared'); }";
	await expect(compileCodeProject(project)).rejects.toMatchObject({ file: 'logic.ts' });
});
it('preserves existing scripts, UI modules and presentation when opening them as source files', async () => {
	const compiled = await compileCodeProject(fixture());
	const project = createCodeProject({
		scripts: {
			old: {
				language: 'javascript',
				source:
					"helia.defineQuery({name:'read',arguments:{type:'object',properties:{},additionalProperties:false},run({state}){return state.gold;}});"
			}
		},
		ui: { ...compiled.ui!, chatStyle: { color: '#fff' } }
	});
	expect(project.files['main.ts'].source).toContain('default as logic');
	expect(project.files['main.ts'].source).toContain('default as ui');
	expect(project.presentation?.chatStyle).toEqual({ color: '#fff' });
	const output = await compileCodeProject(project);
	expect(output.scripts.project.source).toContain('defineQuery');
	expect(output.ui?.chatStyle).toEqual({ color: '#fff' });
});
it('applies compiled outputs and their source project atomically to existing sessions', async () => {
	const repo = createGameRepository(memoryStorage());
	const game = await repo.createGame();
	const content = { ...editorContent(game), ...stateDocument, code: fixture() };
	const saved = await repo.applyGameDraft(game.id, { baseContent: editorContent(game), content });
	expect(saved.code).toEqual(fixture());
	expect(saved.ui?.entry).toBe('ui.tsx');
	const history = await repo.getSessionHistory(game.id, game.activeSessionId);
	expect(history.snapshot.code).toEqual(fixture());
	expect(history.snapshot.scripts).toEqual(saved.scripts);
	const bad = fixture();
	bad.files['main.ts'].source = "export {default as logic} from './gone';";
	await expect(
		repo.applyGameDraft(game.id, {
			baseContent: editorContent(saved),
			content: { ...editorContent(saved), code: bad }
		})
	).rejects.toThrow();
	expect((await repo.getGameWorkspace(game.id))?.game.code).toEqual(fixture());
	const empty = {
		version: 1 as const,
		entry: 'main.ts',
		files: {
			'main.ts': { language: 'typescript' as const, source: 'export {};' }
		}
	};
	const cleared = await repo.applyGameDraft(game.id, {
		baseContent: editorContent(saved),
		content: { ...editorContent(saved), code: empty }
	});
	expect(cleared.ui).toBeUndefined();
	expect(cleared.scripts).toEqual({});
	expect((await repo.getSessionHistory(game.id, game.activeSessionId)).snapshot.ui).toBeUndefined();
});
it('validates project paths, empty directories, size and presentation without changing source', () => {
	const project = { ...fixture(), folders: ['components', 'components/empty'] };
	expect(parseCodeProject(project)).toEqual(project);
	expect(() => parseCodeProject({ ...project, entry: '../main.ts' })).toThrow();
	expect(() => parseCodeProject({ ...project, folders: ['logic.ts/child'] })).toThrow();
	expect(() => parseCodeProject({ ...project, presentation: { entry: 'other.ts' } })).toThrow();
});
