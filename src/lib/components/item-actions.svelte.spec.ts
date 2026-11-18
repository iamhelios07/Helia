import '../../app.css';
import { expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';

import { chooseItemAction } from './item-actions-test.js';
import ItemActions from './ItemActions.svelte';

it('keeps failed renames editable and restores focus when cancelled', async () => {
	const onrenamevalue = vi.fn(() => {
		throw Error('같은 이름이 이미 있어요.');
	});
	render(ItemActions, { name: '기존 이름', onrenamevalue });
	await chooseItemAction('기존 이름', 'rename');
	await page.getByRole('textbox', { name: '이름', exact: true }).fill('중복 이름');
	await page.getByRole('button', { name: '확인', exact: true }).click();
	await expect.element(page.getByRole('alert')).toHaveTextContent('같은 이름이 이미 있어요.');
	await expect.element(page.getByRole('textbox')).toHaveValue('중복 이름');
	await userEvent.keyboard('{Escape}');
	await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
	await expect.element(page.getByRole('button', { name: '기존 이름 작업' })).toHaveFocus();
});

it('cancels deletions and prevents repeat submissions while a confirmed deletion is pending', async () => {
	let finish: () => void = () => {};
	const ondelete = vi.fn(
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			})
	);
	render(ItemActions, { name: '대상 파일', ondelete, deleteMessage: '대상 파일을 삭제할까요?' });
	await chooseItemAction('대상 파일', 'delete');
	await page.getByRole('button', { name: '취소', exact: true }).click();
	expect(ondelete).not.toHaveBeenCalled();
	await chooseItemAction('대상 파일', 'delete');
	await page.getByRole('button', { name: '삭제', exact: true }).click();
	await expect.element(page.getByRole('button', { name: '삭제 중…' })).toBeDisabled();
	await userEvent.keyboard('{Escape}');
	await expect.element(page.getByRole('dialog')).toBeVisible();
	expect(ondelete).toHaveBeenCalledOnce();
	finish();
	await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
});

it('explains protected items and dismisses the actions with Escape', async () => {
	const ondelete = vi.fn();
	render(ItemActions, { name: 'main.ts', ondelete, deleteReason: '진입점이 포함되어 있어요.' });
	await page.getByRole('button', { name: 'main.ts 작업' }).click();
	await expect.element(page.getByRole('button', { name: 'main.ts 삭제' })).toBeDisabled();
	await expect.element(page.getByText('진입점이 포함되어 있어요.')).toBeVisible();
	await userEvent.keyboard('{Escape}');
	await expect
		.poll(() => document.querySelector('[popover]')?.matches(':popover-open'))
		.toBe(false);
	expect(ondelete).not.toHaveBeenCalled();
});
