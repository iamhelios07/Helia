import '../../../../app.css';
import { expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';

import AssetExplorer from './AssetExplorer.svelte';

const portrait = {
	name: 'images/characters/hero.png',
	mime: 'image/png',
	data: 'data:image/png;base64,aGVsbG8='
};

it('opens real files through folder rows and renames folders without changing stable references', async () => {
	let source = JSON.stringify({ portrait });
	const onselect = vi.fn();
	const screen = render(AssetExplorer, {
		source,
		onselect,
		onchange: (next) => {
			source = next;
			void screen.rerender({ source });
		}
	});
	await page.getByRole('button', { name: 'images/characters/hero.png', exact: true }).click();
	expect(onselect).toHaveBeenCalledWith('portrait');
	await page.getByRole('button', { name: 'images 폴더', exact: true }).click();
	await expect
		.element(page.getByRole('button', { name: 'images/characters/hero.png', exact: true }))
		.not.toBeInTheDocument();
	await page.getByRole('button', { name: '에셋 폴더 이름 변경', exact: true }).click();
	await page.getByRole('textbox', { name: '폴더 경로', exact: true }).fill('art');
	await page.getByRole('button', { name: '확인', exact: true }).click();
	await expect.poll(() => JSON.parse(source).portrait.name).toBe('art/characters/hero.png');
	await expect
		.element(page.getByRole('button', { name: 'art/characters/hero.png', exact: true }))
		.toBeVisible();
	await page.getByRole('button', { name: '에셋 폴더 삭제', exact: true }).click();
	await page.getByRole('button', { name: '취소', exact: true }).click();
	expect(JSON.parse(source).portrait).toBeDefined();
	await page.getByRole('button', { name: '에셋 폴더 삭제', exact: true }).click();
	await page.getByRole('button', { name: '삭제', exact: true }).click();
	await expect.poll(() => JSON.parse(source)).toEqual({});
});

it('uploads into a newly created folder and rejects duplicate files without overwriting content', async () => {
	let source = '{}';
	const screen = render(AssetExplorer, {
		source,
		onselect: vi.fn(),
		onchange: (next) => {
			source = next;
			void screen.rerender({ source });
		}
	});
	await page.getByRole('button', { name: '새 에셋 폴더', exact: true }).click();
	await page.getByRole('textbox', { name: '폴더 경로' }).fill('images/portraits');
	await page.getByRole('button', { name: '확인', exact: true }).click();
	const file = new File(['media'], 'hero.png', { type: 'image/png' });
	await userEvent.upload(page.getByLabelText('파일 추가'), file);
	await expect
		.poll(() => Object.values(JSON.parse(source)).map((value) => (value as { name: string }).name))
		.toEqual(['images/portraits/hero.png']);
	const previous = source;
	await userEvent.upload(page.getByLabelText('파일 추가'), file);
	await expect.element(page.getByRole('alert')).toHaveTextContent('같은 경로');
	expect(source).toBe(previous);
});
