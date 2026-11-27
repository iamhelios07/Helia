import '../../../app.css';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

import {
	isNetworkGrantRemembered,
	listNetworkGrants,
	NETWORK_GRANTS_KEY,
	rememberNetworkGrant
} from '#lib/games/network/grants.js';

import SettingsDialog from './SettingsDialog.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('#lib/app/settings/repository.js', () => ({
	saveAISettings: vi.fn(),
	loadAISettings: async () => ({ version: 1, providers: [], models: [], defaultModelId: null })
}));
vi.mock('./credentials.js', () => ({
	getCredentialStatus: vi.fn(async () => ({})),
	saveCredential: vi.fn(),
	deleteCredential: vi.fn(),
	fetchProviderModels: vi.fn(),
	saveServiceAccountCredential: vi.fn(),
	verifyProviderCredential: vi.fn()
}));
vi.mock('#lib/games/repository.js', () => ({
	listGames: vi.fn(async () => [
		{ id: 'game-a', title: '별의 항해' },
		{ id: 'game-b', title: '낡은 모험', trashedAt: '2026-01-01T00:00:00.000Z' }
	])
}));

beforeEach(async () => {
	localStorage.clear();
	await page.viewport(1280, 900);
});
afterEach(() => vi.restoreAllMocks());

async function openNetwork() {
	render(SettingsDialog, { onclose: vi.fn() });
	await page
		.getByRole('navigation', { name: '설정 메뉴' })
		.getByRole('button', { name: '외부 연결', exact: true })
		.click();
}
it('shows remembered grants with the game title and cancels them one by one', async () => {
	const game = { id: 'game-a', title: '별의 항해' };
	rememberNetworkGrant(game.id, 'https://api.example');
	rememberNetworkGrant(game.id, 'https://other.example');
	rememberNetworkGrant('game-b', 'https://api.example');
	rememberNetworkGrant('missing-game', 'https://api.example');
	await openNetwork();
	const list = page.getByRole('list', { name: '허용한 외부 주소 목록' });
	await expect.element(list.getByRole('listitem')).toHaveLength(4);
	await expect.element(list.getByText('(휴지통)')).toBeInTheDocument();
	await expect.element(list.getByText('찾을 수 없는 게임')).toBeInTheDocument();
	await page.getByRole('button', { name: `${game.title}의 https://api.example 허용 취소` }).click();
	await expect.element(page.getByRole('status')).toHaveTextContent('허용을 취소했어요');
	await expect.element(list.getByRole('listitem')).toHaveLength(3);
	expect(isNetworkGrantRemembered(game.id, 'https://api.example')).toBe(false);
	expect(isNetworkGrantRemembered(game.id, 'https://other.example')).toBe(true);
	expect(listNetworkGrants()).toHaveLength(3);
});
it('lists a grant remembered in the same tab while the panel stays open', async () => {
	await openNetwork();
	await expect.element(page.getByText('다시 묻지 않기로 한 주소가 없어요.')).toBeInTheDocument();
	rememberNetworkGrant('game-a', 'https://api.example');
	const list = page.getByRole('list', { name: '허용한 외부 주소 목록' });
	await expect.element(list.getByRole('listitem')).toHaveLength(1);
	await expect.element(list.getByText('별의 항해')).toBeInTheDocument();
	await expect.element(list.getByText('https://api.example')).toBeInTheDocument();
});
it('explains when nothing is remembered', async () => {
	await openNetwork();
	await expect.element(page.getByText('다시 묻지 않기로 한 주소가 없어요.')).toBeInTheDocument();
});
it('moves focus to the next row, then the previous row, then the heading when cancelling a grant', async () => {
	rememberNetworkGrant('game-a', 'https://api.example');
	rememberNetworkGrant('game-a', 'https://other.example');
	rememberNetworkGrant('missing-game', 'https://api.example');
	await openNetwork();
	const list = page.getByRole('list', { name: '허용한 외부 주소 목록' });
	const api = page.getByRole('button', { name: '별의 항해의 https://api.example 허용 취소' });
	const other = page.getByRole('button', { name: '별의 항해의 https://other.example 허용 취소' });
	const missing = page.getByRole('button', {
		name: '찾을 수 없는 게임의 https://api.example 허용 취소'
	});
	await api.click();
	await expect.element(other).toHaveFocus();
	await missing.click();
	await expect.element(other).toHaveFocus();
	await other.click();
	await expect.element(page.getByText('다시 묻지 않기로 한 주소가 없어요.')).toBeInTheDocument();
	await expect
		.element(page.getByRole('heading', { name: '다시 묻지 않기로 한 주소' }))
		.toHaveFocus();
	expect(list.query()).toBeNull();
});
it('reports a failed cancellation and keeps the grant listed', async () => {
	rememberNetworkGrant('missing-game', 'https://api.example');
	await openNetwork();
	vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
		throw new Error('full');
	});
	await page.getByRole('button', { name: /허용 취소$/ }).click();
	await expect.element(page.getByRole('alert')).toHaveTextContent('허용을 취소하지 못했어요');
	await expect.element(page.getByRole('listitem')).toHaveLength(1);
});
it('keeps focus on the cancel button when the cancellation could not be saved', async () => {
	rememberNetworkGrant('game-a', 'https://api.example');
	rememberNetworkGrant('game-a', 'https://other.example');
	await openNetwork();
	vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
		throw new Error('full');
	});
	const api = page.getByRole('button', { name: '별의 항해의 https://api.example 허용 취소' });
	await api.click();
	await expect.element(page.getByRole('alert')).toHaveTextContent('https://api.example');
	const list = page.getByRole('list', { name: '허용한 외부 주소 목록' });
	await expect.element(list.getByRole('listitem')).toHaveLength(2);
	await expect.element(api).toHaveFocus();
	expect(isNetworkGrantRemembered('game-a', 'https://api.example')).toBe(true);
});
it('re-reads the saved grants instead of keeping the stale list after a failed cancellation', async () => {
	rememberNetworkGrant('game-a', 'https://api.example');
	rememberNetworkGrant('game-a', 'https://other.example');
	await openNetwork();
	const list = page.getByRole('list', { name: '허용한 외부 주소 목록' });
	await expect.element(list.getByRole('listitem')).toHaveLength(2);
	// Another tab removed one grant while this panel still shows both rows.
	localStorage.setItem(
		NETWORK_GRANTS_KEY,
		JSON.stringify({ version: 1, grants: { 'game-a': ['https://api.example'] } })
	);
	vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
		throw new Error('full');
	});
	await page.getByRole('button', { name: '별의 항해의 https://api.example 허용 취소' }).click();
	await expect.element(page.getByRole('alert')).toHaveTextContent('허용을 취소하지 못했어요');
	await expect.element(list.getByRole('listitem')).toHaveLength(1);
	expect(listNetworkGrants()).toEqual([{ gameId: 'game-a', origin: 'https://api.example' }]);
});
