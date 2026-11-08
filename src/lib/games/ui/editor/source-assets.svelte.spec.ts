import '../../../../app.css';
import { expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';

import AssetEditor from './AssetEditor.svelte';
import BundleEditor from './BundleEditor.svelte';
import { getMonacoSource, setMonacoSource } from './monaco-test.js';

const stateTypes = 'export type GameState = { gold: number };\n';

it('edits actual script strings and provides generated state diagnostics', async () => {
	let source = JSON.stringify({
		main: {
			language: 'typescript',
			source:
				"helia.defineAction({name:'gain',arguments:{},run({state}) { state.gold++; return state; }});\n"
		}
	});
	const onchange = vi.fn((next: string) => {
		source = next;
		void screen.rerender({ source });
	});
	const screen = render(BundleEditor, { source, kind: 'scripts', stateTypes, onchange });
	await setMonacoSource(
		'main 코드',
		"helia.defineAction({name:'gain',arguments:{},run({state}) { state.gold = 'bad'; return state; }});\n"
	);
	await expect.poll(() => JSON.parse(source).main.source).toContain("state.gold = 'bad'");
	expect(JSON.parse(source).main.source).toContain('\n');
	await expect
		.element(page.getByText("Type 'string' is not assignable to type 'number'.", { exact: false }))
		.toBeVisible();
	await page.getByRole('button', { name: 'GameState.d.ts', exact: true }).click();
	await expect.poll(() => getMonacoSource('생성된 GameState 타입')).toBe(stateTypes);
	await expect
		.element(page.getByRole('textbox', { name: '생성된 GameState 타입' }))
		.toHaveAttribute('readonly');
});

it('adds and renames modules, preserves UI settings and requires a modal for removal', async () => {
	let source = JSON.stringify({
		version: 1,
		entry: 'main.tsx',
		modules: {
			'main.tsx': { language: 'tsx', source: 'export default function initialize() {}\n' }
		},
		chatStyle: { color: '#fff' }
	});
	const screen = render(BundleEditor, {
		source,
		kind: 'ui',
		stateTypes,
		onchange: (next: string) => {
			source = next;
			void screen.rerender({ source });
		}
	});
	await page.getByRole('textbox', { name: '모듈 이름', exact: true }).fill('status.tsx');
	await page.getByRole('button', { name: '추가', exact: true }).click();
	await expect.element(page.getByRole('textbox', { name: 'status.tsx 코드' })).toBeVisible();
	await setMonacoSource('status.tsx 코드', 'export const label = "한 줄\\n다음 줄";\n');
	await page.getByRole('textbox', { name: '모듈 이름', exact: true }).fill('status-panel.tsx');
	await page.getByRole('button', { name: '이름 변경', exact: true }).click();
	await expect
		.poll(() => getMonacoSource('status-panel.tsx 코드'))
		.toBe('export const label = "한 줄\\n다음 줄";\n');
	expect(JSON.parse(source).chatStyle).toEqual({ color: '#fff' });
	await page.getByRole('button', { name: '모듈 삭제', exact: true }).click();
	await expect.element(page.getByRole('dialog', { name: '모듈 삭제' })).toBeVisible();
	await userEvent.keyboard('{Escape}');
	expect(Object.hasOwn(JSON.parse(source).modules, 'status-panel.tsx')).toBe(true);
	await page.getByRole('button', { name: '모듈 삭제', exact: true }).click();
	await page.getByRole('button', { name: '삭제', exact: true }).click();
	await expect
		.poll(() => Object.hasOwn(JSON.parse(source).modules, 'status-panel.tsx'))
		.toBe(false);
});

it('creates UI only by explicit request and leaves invalid JSON untouched', async () => {
	const onchange = vi.fn();
	const screen = render(BundleEditor, { source: 'null', kind: 'ui', stateTypes, onchange });
	expect(onchange).not.toHaveBeenCalled();
	await page.getByRole('button', { name: 'UI 만들기' }).click();
	const created = JSON.parse(onchange.mock.calls[0][0]);
	expect(created.modules[created.entry].source).toContain('registerPanel');
	await screen.rerender({ source: '{unfinished' });
	await expect
		.element(
			page.getByText('JSON 보기에서 문서를 수정하면 코드 편집으로 돌아올 수 있어요.', {
				exact: false
			})
		)
		.toBeVisible();
	expect(onchange).toHaveBeenCalledTimes(1);
});

it('uploads media, previews it, renames it and confirms deletion', async () => {
	let source = '{}';
	const screen = render(AssetEditor, {
		source,
		onchange: (next: string) => {
			source = next;
			void screen.rerender({ source });
		}
	});
	const png = Uint8Array.from(
		atob(
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII='
		),
		(ch) => ch.charCodeAt(0)
	);
	await userEvent.upload(
		page.getByLabelText('파일 추가'),
		new File([png], 'portrait.png', { type: 'image/png' })
	);
	await expect.element(page.getByRole('img', { name: 'portrait.png' })).toBeVisible();
	const id = Object.keys(JSON.parse(source))[0];
	expect(JSON.parse(source)[id].data).toMatch(/^data:image\/png;base64,/);
	await page.getByRole('textbox', { name: '에셋 파일 경로' }).fill('초상화');
	await page.getByRole('textbox', { name: '에셋 파일 경로' }).click();
	await userEvent.keyboard('{Tab}');
	await expect.element(page.getByRole('img', { name: '초상화' })).toBeVisible();
	await page.getByRole('button', { name: '초상화 파일 삭제' }).click();
	await page.getByRole('button', { name: '취소', exact: true }).click();
	expect(Object.keys(JSON.parse(source))).toHaveLength(1);
	await page.getByRole('button', { name: '초상화 파일 삭제' }).click();
	await page.getByRole('button', { name: '삭제', exact: true }).click();
	await expect.poll(() => JSON.parse(source)).toEqual({});
});

it('rejects oversized uploads without altering the resource document', async () => {
	const onchange = vi.fn();
	render(AssetEditor, { source: '{}', onchange });
	await userEvent.upload(
		page.getByLabelText('파일 추가'),
		new File([new Uint8Array(1024 * 1024 + 1)], 'large.png', { type: 'image/png' })
	);
	await expect.element(page.getByText('각 파일은 1 MiB', { exact: false })).toBeVisible();
	expect(onchange).not.toHaveBeenCalled();
});
