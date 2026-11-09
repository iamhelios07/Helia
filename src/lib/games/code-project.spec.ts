import { expect, it } from 'vitest';

import { memoryStorage } from '#lib/testing/memory-storage.js';

import {
	compileCodeProject,
	createCodeProject,
	parseCodeProject,
	type CodeProject
} from './code-project.js';
import { editorContent } from './editor.js';
import { createGameRepository } from './repository-core.js';
import { evaluateAction } from './scripting/engine.js';
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
	["export {default as logic} from './missing';", 'main.ts']
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
				language: 'typescript',
				source:
					"helia.defineQuery({name:'read',arguments:{type:'object',properties:{},additionalProperties:false},run({state}){return state.gold;}});"
			}
		},
		ui: { ...compiled.ui!, chatStyle: { color: '#fff' } }
	});
	expect(project.files['main.ts'].source).toContain("import './logic/part-1.ts'");
	expect(project.files['main.ts'].source).toContain("import './ui/start-entry.ts'");
	expect(project.presentation?.chatStyle).toEqual({ color: '#fff' });
	const output = await compileCodeProject(project);
	expect(output.scripts.project.source).toContain('defineQuery');
	expect(output.ui?.chatStyle).toEqual({ color: '#fff' });
});

it('executes entry-level calls and generic registrations without invoking default exports', async () => {
	const input: CodeProject = {
		version: 1,
		entry: 'main.ts',
		files: {
			'main.ts': {
				language: 'typescript',
				source: `import {register} from './actions';\nconst amount=2;\nregister(amount);\nexport default function unused(){throw Error('Do not call default');}`
			},
			'actions.ts': {
				language: 'typescript',
				source: `export function register(amount:number){helia.defineAction<{price:number}>({name:'buy',run({state,args}){state.gold+=amount*args.price;return state;}});}`
			}
		}
	};
	const compiled = await compileCodeProject(input, stateDocument.schema);
	const request = {
		...stateDocument,
		state: { gold: 1 },
		scripts: compiled.scripts,
		action: { name: 'buy', args: { price: 3 } }
	};
	expect((await evaluateAction(request)).state).toEqual({ gold: 7 });
	expect((await evaluateAction(request)).state).toEqual({ gold: 7 });
	await expect(
		evaluateAction({ ...request, action: { name: 'buy', args: { price: '3' } } })
	).rejects.toMatchObject({ code: 'arguments' });
});

it('routes UI side-effect imports out of QuickJS and keeps shared modules in each isolated graph', async () => {
	const input: CodeProject = {
		version: 1,
		entry: 'main.ts',
		files: {
			'main.ts': {
				language: 'typescript',
				source: `import './ui';\nimport {gain} from './shared';\nhelia.defineAction({name:'gain',run({state}){state.gold=gain(state.gold);return state;}});`
			},
			'shared.ts': {
				language: 'typescript',
				source: `export const gain = (value:number)=>value+2;`
			},
			'ui.tsx': {
				language: 'tsx',
				source: `'use ui';\nimport {registerPanel} from '@helia/ui';\nimport {gain} from './shared';\nregisterPanel({id:'status',title:'Status',component:()=> <p>{gain(1)}</p>});\nexport default function unused(){throw Error('Must not initialize default');}`
			}
		}
	};
	const compiled = await compileCodeProject(input);
	expect(compiled.scripts.project.source).not.toContain('registerPanel');
	expect(compiled.ui?.modules).toHaveProperty('shared.ts');
	expect(compiled.ui?.modules).not.toHaveProperty('main.ts');
	expect(compiled.ui?.modules[compiled.ui.entry].source).toBe("import './ui.tsx';");
	expect(
		(
			await evaluateAction({
				...stateDocument,
				state: { gold: 1 },
				scripts: compiled.scripts,
				action: { name: 'gain', args: {} }
			})
		).state
	).toEqual({ gold: 3 });
	await expect(compileGameUI(compiled.ui!, 'top-level')).resolves.toContain('registerPanel');
});

it('supports a UI-only entry, relative nested roots and generated entry name collisions', async () => {
	const input: CodeProject = {
		version: 1,
		entry: 'screens/main.ts',
		files: {
			'screens/main.ts': {
				language: 'typescript',
				source: `'use ui';\nimport {registerPanel} from '@helia/ui';\nregisterPanel({id:'status',title:'Status',component:()=>null});`
			},
			'helia-ui-entry.ts': { language: 'typescript', source: 'throw Error("unreachable")' }
		}
	};
	const compiled = await compileCodeProject(input);
	expect(compiled.scripts).toEqual({});
	expect(compiled.ui?.entry).toBe('helia-ui-entry-next.ts');
	await expect(compileGameUI(compiled.ui!, 'ui-only')).resolves.toContain('screens/main.ts');
});

it('erases inline type-only imports across domains without adding runtime modules', async () => {
	const input: CodeProject = {
		version: 1,
		entry: 'main.ts',
		files: {
			'main.ts': {
				language: 'typescript',
				source: `import {type Args} from './ui';\nimport './ui';\nhelia.defineAction<Args>({name:'buy',run({state,args}){state.gold+=args.price;return state;}});`
			},
			'ui.ts': {
				language: 'typescript',
				source: `'use ui';\nimport {type Result} from './types';\nexport type Args={price:number};\nexport type {Result};\nimport {registerPanel} from '@helia/ui';\nregisterPanel({id:'test',title:'Test',component:()=>null});`
			},
			'types.ts': {
				language: 'typescript',
				source: `'use logic';\nexport type Result={value:number};\nthrow Error('Type-only dependencies must not execute');`
			}
		}
	};
	const compiled = await compileCodeProject(input, stateDocument.schema);
	expect(compiled.ui?.modules).not.toHaveProperty('types.ts');
	expect(compiled.scripts.project.source).not.toContain('Type-only dependencies');
	await expect(compileGameUI(compiled.ui!, 'type-import')).resolves.toContain('registerPanel');
	expect(
		(
			await evaluateAction({
				...stateDocument,
				state: { gold: 1 },
				scripts: compiled.scripts,
				action: { name: 'buy', args: { price: 2 } }
			})
		).state
	).toEqual({ gold: 3 });
});

it.each([
	["import {value} from './ui'; console.log(value);", "'use ui'; export const value=1;"],
	["import './ui';", "'use ui'; import './logic';"],
	["'use logic'; 'use ui';", "'use ui';"],
	['await Promise.resolve();', "'use ui';"]
])(
	'rejects cross-domain values, contradictory directives and top-level await (%s)',
	async (main, ui) => {
		const input: CodeProject = {
			version: 1,
			entry: 'main.ts',
			files: {
				'main.ts': { language: 'typescript', source: main },
				'ui.ts': { language: 'typescript', source: ui },
				'logic.ts': { language: 'typescript', source: "'use logic'; export const value=1;" }
			}
		};
		await expect(compileCodeProject(input)).rejects.toBeInstanceOf(Error);
	}
);
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

it('migrates saved JavaScript projects to typed files on load', async () => {
	const saved = {
		version: 1,
		entry: 'main.js',
		files: {
			'main.js': {
				language: 'javascript',
				source: "import { gain } from './shared.js';\ngain();"
			},
			'shared.js': {
				language: 'javascript',
				source: 'export function gain() { return 1; }'
			},
			'view.jsx': {
				language: 'jsx',
				source:
					"import { registerPanel } from '@helia/ui';\nregisterPanel({id:'a',title:'A',component:()=> <span/>});"
			}
		}
	};
	const project = parseCodeProject(saved);
	expect(project.entry).toBe('main.ts');
	expect(Object.keys(project.files).sort()).toEqual(['main.ts', 'shared.ts', 'view.tsx']);
	expect(project.files['main.ts'].language).toBe('typescript');
	expect(project.files['view.tsx'].language).toBe('tsx');
	// Extension-qualified imports are rewritten so resolution still finds the typed target.
	expect(project.files['main.ts'].source).toContain("from './shared'");
	expect(await compileCodeProject(project)).toBeTruthy();
});
