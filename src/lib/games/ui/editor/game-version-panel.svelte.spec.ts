import '../../../../app.css';
import { tick } from 'svelte';
import { beforeEach, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';

import { memoryStorage } from '#lib/testing/memory-storage.js';

import type { CreateGameReleaseResult, GameVersioning } from '../../versioning.js';

import { createGameRepository } from '../../repository-core.js';
import { createGameRelease, getGameVersioning } from '../../repository.js';
import GameVersionPanel from './GameVersionPanel.svelte';

vi.mock('../../repository.js', () => ({
	getGameVersioning: vi.fn(),
	createGameRelease: vi.fn()
}));
vi.mock('#lib/storage/transport.js', async () => ({
	storageRequest: (await import('#lib/testing/memory-storage.js')).memoryStorage()
}));

const { createGame } = createGameRepository(memoryStorage());

const initial = (): GameVersioning => ({
	originalGameId: 'original',
	contentHash: 'applied-hash',
	currentRelease: null,
	releases: [],
	modified: false
});
const released = (version = '1.0.0'): GameVersioning => {
	const release = {
		id: 'release',
		originalGameId: 'original',
		contentVersion: version,
		contentHash: 'applied-hash',
		createdAt: '2026-11-23T00:00:00.000Z'
	};
	return { ...initial(), currentRelease: release, releases: [release] };
};
const conflict = (): CreateGameReleaseResult => ({
	kind: 'conflict',
	contentVersion: '1.0.0',
	existingHashes: ['other-hash'],
	incomingHash: 'confirmed-incoming-hash'
});
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const input = () => page.getByRole('textbox', { name: '배포 버전 (SemVer)' });
const finalize = () => page.getByRole('button', { name: '배포본 확정', exact: true });
const panel = () => page.getByRole('region', { name: '배포 버전', exact: true });
const dialog = () => page.getByRole('dialog', { name: '버전 충돌', exact: true });
const reload = () => page.getByRole('button', { name: '버전 정보 다시 불러오기' });

beforeEach(() => {
	vi.mocked(getGameVersioning).mockReset().mockResolvedValue(initial());
	vi.mocked(createGameRelease)
		.mockReset()
		.mockResolvedValue({ kind: 'released', state: released() });
});

async function mount() {
	const game = await createGame();
	const onpending = vi.fn();
	const view = render(GameVersionPanel, { game, unapplied: false, onpending });
	await expect.element(finalize()).toBeEnabled();
	return { game, onpending, view };
}
async function openConflict() {
	vi.mocked(createGameRelease).mockResolvedValueOnce(conflict());
	await input().fill('1.0.0');
	await finalize().click();
	await expect.element(dialog()).toBeVisible();
}

it('starts unreleased and freezes only explicitly requested applied content with a hash precondition', async () => {
	const { game, onpending } = await mount();
	await expect.element(panel()).toHaveTextContent('미출시');
	expect(createGameRelease).not.toHaveBeenCalled();
	await input().fill('1.0.0');
	await finalize().click();
	await expect.element(panel()).toHaveTextContent('1.0.0 배포본을 확정했어요.');
	expect(createGameRelease).toHaveBeenCalledExactlyOnceWith(game.id, '1.0.0', {
		expectedContentHash: 'applied-hash'
	});
	expect(onpending.mock.calls).toEqual([[true], [false]]);
	await page.getByText('배포 이력 (1)', { exact: true }).click();
	await page.getByText('콘텐츠 식별값', { exact: true }).click();
	await expect.element(panel()).toHaveTextContent('applied-hash');
});

it('keeps unapplied drafts separate from applied modifications and reloads after Apply replaces the game', async () => {
	vi.mocked(getGameVersioning).mockResolvedValue(released());
	const { game, view } = await mount();
	await view.rerender({ unapplied: true });
	await expect.element(panel()).toHaveTextContent('미적용 초안이 있어요.');
	expect(panel().element().textContent).not.toContain('수정됨');
	expect(createGameRelease).not.toHaveBeenCalled();
	vi.mocked(getGameVersioning).mockResolvedValue({
		...released(),
		modified: true,
		contentHash: 'new-applied'
	});
	await view.rerender({ game: { ...game, title: '적용된 새 제목' }, unapplied: false });
	await expect.element(panel()).toHaveTextContent('수정됨');
	expect(panel().element().textContent).not.toContain('미적용 초안이 있어요.');
	expect(createGameRelease).not.toHaveBeenCalled();
});

it('releases the existing applied content while clearly retaining unapplied edits', async () => {
	const { game, view } = await mount();
	await view.rerender({ unapplied: true });
	await expect.element(panel()).toHaveTextContent('기존 적용된 콘텐츠만 포함돼요.');
	await input().fill('1.1.0-beta.1');
	vi.mocked(createGameRelease).mockResolvedValue({
		kind: 'released',
		state: released('1.1.0-beta.1')
	});
	await finalize().click();
	await expect.element(panel()).toHaveTextContent('1.1.0-beta.1 배포본을 확정했어요.');
	await expect.element(panel()).toHaveTextContent('미적용 초안이 있어요.');
	expect(createGameRelease).toHaveBeenCalledWith(game.id, '1.1.0-beta.1', {
		expectedContentHash: 'applied-hash'
	});
});

it('rejects invalid SemVer and recovers from backend failure without false success or stale retries', async () => {
	const { onpending } = await mount();
	await input().fill('01.0.0');
	await finalize().click();
	await expect.element(page.getByRole('alert')).toHaveTextContent('SemVer 형식');
	expect(createGameRelease).not.toHaveBeenCalled();
	vi.mocked(createGameRelease).mockRejectedValueOnce(new Error('backend unavailable'));
	await input().fill('1.0.0');
	await finalize().click();
	await expect.element(page.getByRole('alert')).toHaveTextContent('버전 정보를 다시 불러온 뒤');
	await expect.element(finalize()).toBeDisabled();
	expect(panel().element().textContent).not.toContain('배포본을 확정했어요.');
	expect(onpending).toHaveBeenLastCalledWith(false);
	await reload().click();
	await expect.element(input()).toHaveValue('1.0.0');
	await finalize().click();
	await expect.element(panel()).toHaveTextContent('1.0.0 배포본을 확정했어요.');
});

it('retries failed status loads', async () => {
	vi.mocked(getGameVersioning).mockRejectedValueOnce(new Error('offline'));
	const game = await createGame();
	render(GameVersionPanel, { game, unapplied: false, onpending: vi.fn() });
	await expect.element(page.getByRole('alert')).toHaveTextContent('버전 정보를 불러오지 못했어요.');
	await reload().click();
	await expect.element(finalize()).toBeEnabled();
	await expect.element(panel()).toHaveTextContent('미출시');
});

it('changes a conflicting version with focus restored and performs a fresh conflict check', async () => {
	const { game } = await mount();
	await openConflict();
	await expect.element(dialog()).toHaveTextContent('1.0.0');
	await page.getByRole('button', { name: '버전 변경', exact: true }).click();
	await expect.element(input()).toHaveFocus();
	await input().fill('1.0.1');
	await finalize().click();
	expect(createGameRelease).toHaveBeenLastCalledWith(game.id, '1.0.1', {
		expectedContentHash: 'applied-hash'
	});
});

it('cancels a conflict or presses Escape without making another write and restores focus', async () => {
	await mount();
	await openConflict();
	await page.getByRole('button', { name: '취소', exact: true }).click();
	await expect.element(dialog()).not.toBeInTheDocument();
	await expect.element(finalize()).toHaveFocus();
	expect(createGameRelease).toHaveBeenCalledTimes(1);
	await openConflict();
	await userEvent.keyboard('{Escape}');
	await expect.element(dialog()).not.toBeInTheDocument();
	expect(createGameRelease).toHaveBeenCalledTimes(2);
});

it('ignores only the confirmed version and incoming hash and prevents repeated actions while pending', async () => {
	const { game, onpending } = await mount();
	await openConflict();
	const request = deferred<CreateGameReleaseResult>();
	vi.mocked(createGameRelease).mockReturnValueOnce(request.promise);
	await page.getByRole('button', { name: '무시하고 계속하기' }).click();
	await expect.element(page.getByRole('button', { name: '취소', exact: true })).toBeDisabled();
	await userEvent.keyboard('{Escape}');
	await expect.element(dialog()).toBeVisible();
	expect(createGameRelease).toHaveBeenLastCalledWith(game.id, '1.0.0', {
		ignoreConflict: true,
		expectedContentHash: 'confirmed-incoming-hash'
	});
	expect(createGameRelease).toHaveBeenCalledTimes(2);
	expect(onpending).toHaveBeenLastCalledWith(true);
	request.resolve({ kind: 'released', state: released() });
	await expect.element(dialog()).not.toBeInTheDocument();
	await expect.element(finalize()).toBeEnabled();
	expect(onpending).toHaveBeenLastCalledWith(false);
});

it('clears a failed override and reloads fresh content before allowing another release', async () => {
	const { game } = await mount();
	await openConflict();
	vi.mocked(createGameRelease).mockRejectedValueOnce(new Error('content changed'));
	await page.getByRole('button', { name: '무시하고 계속하기' }).click();
	await expect.element(dialog()).not.toBeInTheDocument();
	await expect.element(page.getByRole('alert')).toBeVisible();
	vi.mocked(getGameVersioning).mockResolvedValue({ ...initial(), contentHash: 'fresh-hash' });
	await reload().click();
	await expect.element(input()).toHaveValue('1.0.0');
	await finalize().click();
	expect(createGameRelease).toHaveBeenLastCalledWith(game.id, '1.0.0', {
		expectedContentHash: 'fresh-hash'
	});
});

it('disables releases for an editor operation and guards the form during its own pending request', async () => {
	const { view } = await mount();
	await input().fill('1.0.0');
	await view.rerender({ disabled: true });
	await expect.element(input()).toBeDisabled();
	await expect.element(finalize()).toBeDisabled();
	expect(createGameRelease).not.toHaveBeenCalled();
	await view.rerender({ disabled: false });
	const request = deferred<CreateGameReleaseResult>();
	vi.mocked(createGameRelease).mockReturnValueOnce(request.promise);
	await finalize().click();
	await expect.element(input()).toBeDisabled();
	await expect.element(panel().getByRole('button', { name: '확정 중…' })).toBeDisabled();
	request.resolve({ kind: 'released', state: released() });
	await expect.element(finalize()).toBeEnabled();
});

it('ignores stale status results after switching games', async () => {
	const oldLoad = deferred<GameVersioning>();
	vi.mocked(getGameVersioning).mockReturnValueOnce(oldLoad.promise);
	const game = await createGame();
	const view = render(GameVersionPanel, { game, unapplied: false, onpending: vi.fn() });
	await expect.poll(() => vi.mocked(getGameVersioning).mock.calls.length).toBe(1);
	const next = await createGame();
	await view.rerender({ game: next });
	await expect.element(finalize()).toBeEnabled();
	oldLoad.resolve(released('9.0.0'));
	await oldLoad.promise;
	await tick();
	await expect.element(panel()).toHaveTextContent('미출시');
	expect(panel().element().textContent).not.toContain('9.0.0');
});

it('ignores stale release results after navigation and releases the pending guard after unmount', async () => {
	const { view, onpending } = await mount();
	await input().fill('1.0.0');
	const request = deferred<CreateGameReleaseResult>();
	vi.mocked(createGameRelease).mockReturnValueOnce(request.promise);
	await finalize().click();
	await view.rerender({ game: await createGame() });
	await expect.element(input()).toHaveValue('');
	request.resolve({ kind: 'released', state: released('9.0.0') });
	await expect.element(finalize()).toBeEnabled();
	await expect.element(panel()).toHaveTextContent('미출시');
	expect(panel().element().textContent).not.toContain('9.0.0');
	const second = deferred<CreateGameReleaseResult>();
	vi.mocked(createGameRelease).mockReturnValueOnce(second.promise);
	await input().fill('1.0.0');
	await finalize().click();
	await view.unmount();
	expect(onpending).toHaveBeenLastCalledWith(true);
	second.resolve({ kind: 'released', state: released() });
	await expect.poll(() => onpending.mock.lastCall).toEqual([false]);
});
