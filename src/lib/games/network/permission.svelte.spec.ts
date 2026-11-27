import '../../../app.css';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';

import { isNetworkGrantRemembered, NETWORK_GRANTS_KEY } from './grants.js';
import { requestNetworkPermission } from './permission.js';

const origin = 'https://api.example';
beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

it('remembers only when the checkbox is checked and the player allows', async () => {
	const result = requestNetworkPermission(origin, new AbortController().signal, 'game-1');
	const dialog = page.getByRole('dialog', { name: '외부 연결 허용' });
	await expect.element(dialog).toBeInTheDocument();
	const checkbox = dialog.getByRole('checkbox', { name: '이 주소에 대해 다시 묻지 않기' });
	await expect.element(checkbox).not.toBeChecked();
	await checkbox.click();
	await dialog.getByRole('button', { name: '허용' }).click();
	await expect(result).resolves.toBe(true);
	expect(isNetworkGrantRemembered('game-1', origin)).toBe(true);
	// The same game and origin no longer shows a dialog.
	await expect(
		requestNetworkPermission(origin, new AbortController().signal, 'game-1')
	).resolves.toBe(true);
	await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
});
it('does not remember an unchecked allow or a checked denial', async () => {
	let result = requestNetworkPermission(origin, new AbortController().signal, 'game-1');
	let dialog = page.getByRole('dialog', { name: '외부 연결 허용' });
	await dialog.getByRole('button', { name: '허용' }).click();
	await expect(result).resolves.toBe(true);
	result = requestNetworkPermission(origin, new AbortController().signal, 'game-1');
	dialog = page.getByRole('dialog', { name: '외부 연결 허용' });
	await dialog.getByRole('checkbox', { name: '이 주소에 대해 다시 묻지 않기' }).click();
	await dialog.getByRole('button', { name: '취소' }).click();
	await expect(result).resolves.toBe(false);
	expect(localStorage.getItem(NETWORK_GRANTS_KEY)).toBeNull();
});
it('keeps the shorter wording when the game is unknown, so nothing can be remembered', async () => {
	const result = requestNetworkPermission(origin, new AbortController().signal);
	const dialog = page.getByRole('dialog', { name: '외부 연결 허용' });
	await expect.element(dialog).toHaveTextContent('이번 작업이 끝날 때까지 허용합니다.');
	await expect.element(dialog.getByRole('checkbox')).not.toBeInTheDocument();
	await expect.element(dialog).not.toHaveTextContent('다시 묻지 않기');
	await dialog.getByRole('button', { name: '취소' }).click();
	await expect(result).resolves.toBe(false);
});
it('asks again for a different game', async () => {
	localStorage.clear();
	const first = requestNetworkPermission(origin, new AbortController().signal, 'game-1');
	let dialog = page.getByRole('dialog', { name: '외부 연결 허용' });
	await dialog.getByRole('checkbox').click();
	await dialog.getByRole('button', { name: '허용' }).click();
	await first;
	const second = requestNetworkPermission(origin, new AbortController().signal, 'game-2');
	dialog = page.getByRole('dialog', { name: '외부 연결 허용' });
	await expect.element(dialog).toBeInTheDocument();
	await dialog.getByRole('button', { name: '취소' }).click();
	await expect(second).resolves.toBe(false);
});
it('allows the request and says the address could not be remembered when storage rejects it', async () => {
	vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
		throw new Error('full');
	});
	const result = requestNetworkPermission(origin, new AbortController().signal, 'game-1');
	const dialog = page.getByRole('dialog', { name: '외부 연결 허용' });
	await dialog.getByRole('checkbox', { name: '이 주소에 대해 다시 묻지 않기' }).click();
	await dialog.getByRole('button', { name: '허용' }).click();
	await expect(result).resolves.toBe(true);
	const notice = page.getByRole('alert');
	await expect.element(notice).toHaveTextContent('주소를 기억하지 못했어요');
	await expect.element(notice).toHaveTextContent('다음에 다시 물어볼게요');
	await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
	expect(isNetworkGrantRemembered('game-1', origin)).toBe(false);
	await page.getByRole('button', { name: '알림 닫기' }).click();
	await expect.element(notice).not.toBeInTheDocument();
});
it('says nothing when the player allows without remembering', async () => {
	const result = requestNetworkPermission(origin, new AbortController().signal, 'game-1');
	const dialog = page.getByRole('dialog', { name: '외부 연결 허용' });
	await dialog.getByRole('button', { name: '허용' }).click();
	await expect(result).resolves.toBe(true);
	await expect.element(page.getByRole('alert')).not.toBeInTheDocument();
});
