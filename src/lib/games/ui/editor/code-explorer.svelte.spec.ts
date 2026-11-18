import '../../../../app.css';
import { expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

import { chooseItemAction } from '#lib/components/item-actions-test.js';

import CodeExplorer from './CodeExplorer.svelte';

it('renames and removes the targeted folder while another file is active', async () => {
	let source = $state(
		JSON.stringify({
			version: 1,
			entry: 'main.ts',
			files: {
				'main.ts': { language: 'typescript', source: "import './logic/value';" },
				'logic/value.ts': { language: 'typescript', source: 'export const value = 1;' }
			},
			folders: ['logic/empty']
		})
	);
	const onmove = vi.fn();
	const onremove = vi.fn();
	render(CodeExplorer, {
		get source() {
			return source;
		},
		active: 'main.ts',
		onselect: vi.fn(),
		onchange: (next) => {
			source = next;
		},
		onmove,
		onremove
	});
	await chooseItemAction('logic', 'rename');
	await page.getByRole('textbox', { name: '이름', exact: true }).fill('runtime');
	await page.getByRole('button', { name: '확인', exact: true }).click();
	await expect
		.element(page.getByRole('dialog', { name: '이름 변경', exact: true }))
		.not.toBeInTheDocument();
	await expect
		.poll(() => JSON.parse(source).files['main.ts'].source)
		.toBe("import './runtime/value.ts';");
	expect(onmove).toHaveBeenCalledWith('logic', 'runtime');
	await chooseItemAction('runtime', 'delete');
	await expect.element(page.getByRole('dialog')).toHaveTextContent('runtime');
	await page.getByRole('button', { name: '취소', exact: true }).click();
	expect(onremove).not.toHaveBeenCalled();
	await chooseItemAction('runtime', 'delete');
	await page.getByRole('button', { name: '삭제', exact: true }).click();
	await expect.poll(() => Object.keys(JSON.parse(source).files)).toEqual(['main.ts']);
	expect(onremove).toHaveBeenCalledWith(['runtime/value.ts']);
});

it('sets the entry through a shared menu action and updates deletion protection', async () => {
	let source = $state(
		JSON.stringify({
			version: 1,
			entry: 'main.ts',
			files: {
				'main.ts': { language: 'typescript', source: 'export {};' },
				'helper.ts': { language: 'typescript', source: 'export {};' }
			}
		})
	);
	render(CodeExplorer, {
		get source() {
			return source;
		},
		active: 'main.ts',
		onselect: vi.fn(),
		onmove: vi.fn(),
		onremove: vi.fn(),
		onchange: (next) => {
			source = next;
		}
	});
	await page.getByRole('button', { name: 'helper.ts 작업', exact: true }).click();
	const action = page.getByRole('button', { name: 'helper.ts 진입점 지정', exact: true });
	await expect.element(action).toHaveTextContent('진입점 지정');
	await action.click();
	await expect.poll(() => JSON.parse(source).entry).toBe('helper.ts');
	await expect.element(action).not.toBeInTheDocument();
	await page.getByRole('button', { name: 'helper.ts 작업', exact: true }).click();
	await expect
		.element(page.getByRole('button', { name: 'helper.ts 삭제', exact: true }))
		.toBeDisabled();
});
