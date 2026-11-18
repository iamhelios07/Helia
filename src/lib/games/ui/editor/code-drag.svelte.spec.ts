import '../../../../app.css';
import { tick } from 'svelte';
import { expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

import type { CodeProject } from '../../code-project.js';

import CodeExplorer from './CodeExplorer.svelte';

function project(): CodeProject {
	return {
		version: 1,
		entry: 'main.ts',
		folders: ['logic/empty', 'target'],
		files: {
			'main.ts': { language: 'typescript', source: "import './logic/value';" },
			'logic/value.ts': { language: 'typescript', source: 'export const value = 1;' },
			'style.css': { language: 'css', source: '' }
		}
	};
}
function mount(initial = project()) {
	const state = $state({
		source: JSON.stringify(initial),
		active: null as string | null,
		disabled: false
	});
	const onmove = vi.fn();
	render(CodeExplorer, {
		get source() {
			return state.source;
		},
		get active() {
			return state.active;
		},
		get disabled() {
			return state.disabled;
		},
		onselect: (path) => (state.active = path || null),
		onchange: (source) => (state.source = source),
		onmove,
		onremove: vi.fn()
	});
	return { state, onmove };
}
function event(type: string) {
	return new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() });
}
async function start(path: string) {
	const row = page.getByTitle(path, { exact: true }).element();
	row.dispatchEvent(event('dragstart'));
	await tick();
	return row;
}
function drop(target: Element) {
	const over = event('dragover');
	target.dispatchEvent(over);
	target.dispatchEvent(event('drop'));
	return over.defaultPrevented;
}

it('moves a file into a collapsed folder and back to root while keeping the entry and import paths current', async () => {
	const { state, onmove } = mount();
	const target = page.getByTitle('target', { exact: true }).element();
	target.parentElement?.removeAttribute('open');
	await start('main.ts');
	expect(drop(target)).toBe(true);
	await expect
		.poll(() => JSON.parse(state.source).entry, { timeout: 10000 })
		.toBe('target/main.ts');
	await expect.element(page.getByTitle('target/main.ts', { exact: true })).toBeVisible();
	await expect
		.poll(() => JSON.parse(state.source).files['target/main.ts'].source)
		.toContain('../logic/value.ts');
	expect(onmove).toHaveBeenCalledWith('main.ts', 'target/main.ts');
	await start('target/main.ts');
	expect(drop(page.getByRole('group', { name: '코드 루트로 이동' }).element())).toBe(true);
	await expect.poll(() => JSON.parse(state.source).entry).toBe('main.ts');
	await expect.poll(() => JSON.parse(state.source).folders).toContain('target');
});

it('moves a whole folder including nested empty folders and can move into another file’s parent', async () => {
	const { state } = mount();
	await start('logic');
	drop(page.getByTitle('target', { exact: true }).element());
	await expect
		.poll(() => JSON.parse(state.source).files['target/logic/value.ts'], { timeout: 10000 })
		.toBeDefined();
	await expect.element(page.getByTitle('target/logic/empty', { exact: true })).toBeVisible();
	await expect
		.poll(() => JSON.parse(state.source).files['main.ts'].source)
		.toContain('./target/logic/value.ts');
	await start('main.ts');
	drop(page.getByTitle('target/logic/value.ts', { exact: true }).element());
	await expect.poll(() => JSON.parse(state.source).entry).toBe('target/logic/main.ts');
});

it('rejects cycles and name collisions and leaves generated definitions and style.css fixed', async () => {
	const initial = project();
	initial.files['target/value.ts'] = { language: 'typescript', source: 'export {};' };
	const { state, onmove } = mount(initial);
	const snapshot = state.source;
	await start('logic');
	expect(drop(page.getByTitle('logic/empty', { exact: true }).element())).toBe(false);
	await start('logic/value.ts');
	expect(drop(page.getByTitle('target', { exact: true }).element())).toBe(false);
	expect(state.source).toBe(snapshot);
	expect(onmove).not.toHaveBeenCalled();
	await expect
		.element(page.getByTitle('style.css', { exact: true }))
		.toHaveAttribute('draggable', 'false');
	expect(
		page
			.getByRole('group', { name: '자동 생성 파일' })
			.element()
			.querySelector('[draggable="true"]')
	).toBeNull();
});

it('ignores external drags, respects editor locks and clears cancelled drag feedback', async () => {
	const { state, onmove } = mount();
	const target = page.getByTitle('target', { exact: true }).element();
	expect(drop(target)).toBe(false);
	const row = await start('logic/value.ts');
	target.dispatchEvent(event('dragover'));
	await tick();
	expect(target.classList.contains('drop-target')).toBe(true);
	row.dispatchEvent(event('dragend'));
	await tick();
	expect(target.classList.contains('drop-target')).toBe(false);
	state.disabled = true;
	await tick();
	await expect
		.element(page.getByTitle('main.ts', { exact: true }))
		.toHaveAttribute('draggable', 'false');
	await start('main.ts');
	expect(drop(target)).toBe(false);
	expect(onmove).not.toHaveBeenCalled();
});

it('does not overwrite source edited while the asynchronous move is preparing', async () => {
	const { state, onmove } = mount();
	await start('main.ts');
	drop(page.getByTitle('target', { exact: true }).element());
	const changed = project();
	changed.files['main.ts'].source += '\n// newer edit';
	state.source = JSON.stringify(changed);
	await expect.element(page.getByRole('alert')).toHaveTextContent('이동 중 코드가 변경되었어요');
	expect(JSON.parse(state.source).files['main.ts'].source).toContain('// newer edit');
	expect(onmove).not.toHaveBeenCalled();
});
