import { expect, it } from 'vitest';
import type { CodeProject } from '../../code-project.js';
import { renameCodePath } from './code-files.js';

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
