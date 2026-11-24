import '../../../../app.css';
import { beforeEach, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

import { UNLOCK_CONFIRMATION } from '../../edit-lock.js';
import { unlockGame } from '../../repository.js';
import GameEditLock from './GameEditLock.svelte';

vi.mock('../../repository.js', () => ({ unlockGame: vi.fn() }));
beforeEach(() => {
	vi.resetAllMocks();
	localStorage.clear();
});

it('cancels without writing, confirms once and refreshes only after success', async () => {
	const refreshed = vi.fn(async () => {});
	render(GameEditLock, { gameId: 'locked', onunlocked: refreshed });
	await page.getByRole('button', { name: '편집 잠금 해제', exact: true }).click();
	await expect.element(page.getByRole('dialog')).toHaveTextContent(UNLOCK_CONFIRMATION);
	await page.getByRole('button', { name: '취소', exact: true }).click();
	expect(unlockGame).not.toHaveBeenCalled();
	await page.getByRole('button', { name: '편집 잠금 해제', exact: true }).click();
	await page.getByRole('button', { name: '잠금 해제', exact: true }).click();
	expect(unlockGame).toHaveBeenCalledExactlyOnceWith('locked');
	expect(refreshed).toHaveBeenCalledOnce();
});

it('keeps the confirmation available after a failed unlock', async () => {
	vi.mocked(unlockGame).mockRejectedValueOnce(Error('offline'));
	const refreshed = vi.fn(async () => {});
	render(GameEditLock, { gameId: 'locked', onunlocked: refreshed });
	await page.getByRole('button', { name: '편집 잠금 해제', exact: true }).click();
	await page.getByRole('button', { name: '잠금 해제', exact: true }).click();
	await expect.element(page.getByRole('alert')).toHaveTextContent('편집 잠금을 해제하지 못했어요.');
	expect(refreshed).not.toHaveBeenCalled();
	await expect.element(page.getByRole('button', { name: '잠금 해제', exact: true })).toBeEnabled();
});
