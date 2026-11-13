import '../../../../app.css';
import { expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

import LorebookEditor from './LorebookEditor.svelte';

it('reorders entries via drag and drop', async () => {
	let source = $state(
		JSON.stringify({
			version: 1,
			lorebook: [
				{ id: 'a', name: '첫째', keys: ['k1'], content: 'c1', order: 2 },
				{ id: 'b', name: '둘째', keys: ['k2'], content: 'c2', order: 1 }
			]
		})
	);
	render(LorebookEditor, {
		get source() {
			return source;
		},
		onchange: (value: string) => {
			source = value;
		}
	});
	const rows = () => [...document.querySelectorAll('[role=listitem]')];
	await expect.element(page.getByText('첫째')).toBeVisible();
	// Simulate the drag lifecycle: dragstart on the first row, drop on the second.
	const dragEvent = (type: string) =>
		new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() });
	rows()[0].dispatchEvent(dragEvent('dragstart'));
	rows()[1].dispatchEvent(dragEvent('drop'));
	await expect.poll(() => JSON.parse(source).lorebook[0].name).toBe('둘째');
	expect(JSON.parse(source).lorebook[0].order).toBeGreaterThan(
		JSON.parse(source).lorebook[1].order
	);
}, 30_000);

it('moves an entry between folders by dropping on a target in another folder', async () => {
	let source = $state(
		JSON.stringify({
			version: 1,
			lorebook: [
				{ id: 'root', name: '바깥', keys: ['r'], content: 'c', always: true },
				{ id: 'inside', name: '안', folder: '폴더', keys: ['f'], content: 'c', always: true }
			]
		})
	);
	render(LorebookEditor, {
		get source() {
			return source;
		},
		onchange: (value: string) => {
			source = value;
		}
	});
	const rows = () => [...document.querySelectorAll('[role=listitem]')];
	await expect.element(page.getByText('바깥')).toBeVisible();
	await page.getByRole('button', { name: '폴더 폴더 펼치기' }).click();
	rows()[0].dispatchEvent(
		new DragEvent('dragstart', {
			bubbles: true,
			cancelable: true,
			dataTransfer: new DataTransfer()
		})
	);
	rows()[1].dispatchEvent(
		new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() })
	);
	await expect.poll(() => JSON.parse(source).lorebook[0].folder).toBe('폴더');
}, 30_000);
