import '../../../../app.css';
import { expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';

import LorebookEditor from './LorebookEditor.svelte';

it('creates, renames and deletes folders VS Code-style', async () => {
	let source = $state(
		JSON.stringify({
			version: 1,
			lorebook: [{ name: '항목', folder: '이전폴더', keys: ['k'], content: 'c', always: true }]
		})
	);
	const screen = render(LorebookEditor, {
		get source() {
			return source;
		},
		onchange: (value: string) => {
			source = value;
		}
	});
	// Create folder
	await page.getByRole('button', { name: '새 폴더 만들기' }).click();
	await expect.poll(() => source).toContain('새 폴더');
	await screen.rerender({
		get source() {
			return source;
		}
	});
	// Rename existing folder
	await userEvent.hover(page.getByRole('button', { name: '이전폴더 폴더 펼치기' }));
	await page.getByRole('button', { name: '이전폴더 이름 변경' }).click();
	await page.getByRole('textbox', { name: '폴더 이름 변경' }).fill('새이름');
	await userEvent.keyboard('{Enter}');
	await screen.rerender({
		get source() {
			return source;
		}
	});
	await expect.poll(() => source).toContain('새이름');
	expect(source).not.toContain('이전폴더');
	// Delete folder: entry survives at top level
	await userEvent.hover(page.getByRole('button', { name: '새이름 폴더 펼치기' }));
	await page.getByRole('button', { name: '새이름 삭제 (로어는 최상위로 이동)' }).click();
	await screen.rerender({
		get source() {
			return source;
		}
	});
	await expect.poll(() => source).not.toContain('새이름');
	expect(source).toContain('항목');
}, 30_000);

it('keeps declared empty folders visible and persists them', async () => {
	let source = $state(JSON.stringify({ version: 1, lorebook: [], folders: ['빈 폴더'] }));
	render(LorebookEditor, {
		get source() {
			return source;
		},
		onchange: (value: string) => {
			source = value;
		}
	});
	await expect.poll(() => source).toContain('빈 폴더');
	await page.getByRole('button', { name: '빈 폴더 폴더 펼치기' }).click();
	// Selecting a folder does not remove it; the declared folder persists even with no entries.
	expect(JSON.parse(source).folders).toContain('빈 폴더');
}, 30_000);
