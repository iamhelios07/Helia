import { expect, it } from 'vitest';

import type { CodeProject } from '../../code-project.js';

import { codeDropPath, codeFolders, renameCodePath } from './code-files.js';

it('moves a directory while preserving internal and external module references and unrelated strings', async () => {
	const project: CodeProject = {
		version: 1,
		entry: 'main.ts',
		folders: ['logic', 'logic/empty'],
		files: {
			'main.ts': {
				language: 'typescript',
				source:
					"export { default as logic } from './logic/index';\nconst text = `from './logic/index'`;"
			},
			'logic/index.ts': {
				language: 'typescript',
				source: "import { value } from '../shared';\nexport default () => value;"
			},
			'shared.ts': { language: 'typescript', source: 'export const value = 42;' }
		}
	};
	const moved = await renameCodePath(project, 'logic', 'code/runtime');
	expect(moved.files['main.ts'].source).toContain("from './code/runtime/index.ts'");
	expect(moved.files['main.ts'].source).toContain("`from './logic/index'`");
	expect(moved.files['code/runtime/index.ts'].source).toContain("from '../../shared.ts'");
	expect(moved.folders).toEqual(['code/runtime', 'code/runtime/empty']);
	expect(project.files['logic/index.ts']).toBeDefined();
});

function project(): CodeProject {
	return {
		version: 1,
		entry: 'main.ts',
		folders: ['logic/empty', 'target'],
		files: {
			'main.ts': {
				language: 'typescript',
				source:
					"import './logic/value'; const load = () => import('./logic/value'); type Value = import('./logic/value').Value;"
			},
			'logic/value.ts': {
				language: 'typescript',
				source: 'export type Value = number; export const value = 1;'
			},
			'style.css': { language: 'css', source: '.card { color: gold; }' }
		}
	};
}

it('moves files into folders and back to root, preserving imports, entry points and emptied folders', async () => {
	const before = project();
	const nextPath = codeDropPath(before, 'main.ts', 'target')!;
	const moved = await renameCodePath(before, 'main.ts', nextPath);
	expect(moved.entry).toBe('target/main.ts');
	expect(moved.files[moved.entry].source).toContain("import '../logic/value.ts'");
	expect(moved.files[moved.entry].source).toContain("import('../logic/value.ts')");
	expect(moved.files['style.css']).toEqual(before.files['style.css']);
	const restored = await renameCodePath(moved, moved.entry, codeDropPath(moved, moved.entry, '')!);
	expect(restored.entry).toBe('main.ts');
	expect(codeFolders(restored)).toContain('target');
	expect(before.entry).toBe('main.ts');
});

it('updates dynamic and type imports when a referenced folder moves and keeps nested empty folders visible', async () => {
	const before = project();
	expect(codeFolders(before)).toEqual(['logic', 'logic/empty', 'target']);
	const after = await renameCodePath(before, 'logic', codeDropPath(before, 'logic', 'target')!);
	expect(codeFolders(after)).toEqual(['target', 'target/logic', 'target/logic/empty']);
	expect(after.files['main.ts'].source).toContain("import('./target/logic/value.ts')");
	expect(after.files['main.ts'].source).toContain(
		"type Value = import('./target/logic/value.ts').Value"
	);
});

it('rejects collisions, folder cycles, missing paths and stylesheet moves without changing the project', async () => {
	const before = project();
	before.files['target/value.ts'] = { language: 'typescript', source: 'export {};' };
	const snapshot = JSON.stringify(before);
	expect(() => codeDropPath(before, 'logic/value.ts', 'target')).toThrow('같은 경로');
	expect(() => codeDropPath(before, 'logic', 'logic/empty')).toThrow('하위 폴더');
	expect(() => codeDropPath(before, 'logic', 'logic')).toThrow('자기 자신');
	expect(() => codeDropPath(before, 'main.ts', 'missing')).toThrow('대상 코드 폴더');
	expect(() => codeDropPath(before, 'missing.ts', '')).toThrow('이동할 코드 경로');
	expect(codeDropPath(before, 'main.ts', '')).toBeNull();
	await expect(renameCodePath(before, 'style.css', 'target/style.css')).rejects.toThrow(
		'style.css'
	);
	await expect(renameCodePath(before, 'logic', 'main.ts/logic')).rejects.toThrow('겹쳐요');
	expect(JSON.stringify(before)).toBe(snapshot);
});

it('preserves an emptied implicit source folder without materializing every occupied folder', async () => {
	const before = { ...project(), folders: ['target'] };
	const moved = await renameCodePath(before, 'logic/value.ts', 'value.ts');
	expect(codeFolders(moved)).toContain('logic');
	expect(moved.folders).toContain('logic');
	const many: CodeProject = {
		version: 1,
		entry: 'main.ts',
		folders: ['target'],
		files: { 'main.ts': { language: 'typescript', source: 'export {};' } }
	};
	for (let i = 0; i < 63; i++) {
		many.files[`group${i}/deep/leaf/module.ts`] = { language: 'typescript', source: 'export {};' };
	}
	const result = await renameCodePath(many, 'main.ts', 'target/main.ts');
	expect(result.entry).toBe('target/main.ts');
	expect(result.folders).toEqual(['target']);
});
