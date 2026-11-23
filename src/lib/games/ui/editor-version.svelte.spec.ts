import '../../../app.css';
import { beforeNavigate } from '$app/navigation';
import { beforeEach, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';

import { storageRequest } from '#lib/storage/transport.js';
import { memoryStorage } from '#lib/testing/memory-storage.js';

import type { EditorDraft } from '../editor.js';

import { loadAuthoringDraft, saveAuthoringDraft } from '../editor-draft-storage.js';
import { loadEditorDraft } from '../editor.js';
import { createGame, getGameRelease, getGameVersioning, getGameWorkspace } from '../repository.js';
import GameEditor from './GameEditor.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn(), beforeNavigate: vi.fn() }));
vi.mock('../editor-draft-storage.js', () => ({
	loadAuthoringDraft: vi.fn(),
	saveAuthoringDraft: vi.fn()
}));
vi.mock('#lib/storage/transport.js', async () => ({
	storageRequest: vi.fn((await import('#lib/testing/memory-storage.js')).memoryStorage())
}));

const drafts = new Map<string, { version: number; draft: EditorDraft | null }>();
const nameInput = () => page.getByRole('textbox', { name: '이름', exact: true });
const versionInput = () => page.getByRole('textbox', { name: '배포 버전 (SemVer)' });
const finalize = () => page.getByRole('button', { name: '배포본 확정', exact: true });
const apply = () => page.getByRole('button', { name: '적용', exact: true });
const panel = () => page.getByRole('region', { name: '배포 버전', exact: true });

beforeEach(async () => {
	vi.clearAllMocks();
	vi.mocked(storageRequest).mockImplementation(memoryStorage());
	drafts.clear();
	localStorage.clear();
	vi.mocked(loadAuthoringDraft).mockImplementation(async (id) =>
		structuredClone(drafts.get(id) ?? { version: 0, draft: null })
	);
	vi.mocked(saveAuthoringDraft).mockImplementation(async (id, draft, version) => {
		const next = structuredClone({ version: version + 1, draft });
		drafts.set(id, next);
		return next;
	});
	await page.viewport(1200, 900);
});

function delayRelease() {
	const storage = vi.mocked(storageRequest).getMockImplementation()!;
	let finish!: () => void;
	const pending = new Promise<void>((resolve) => {
		finish = resolve;
	});
	vi.mocked(storageRequest).mockImplementation(async (request) => {
		if (request.kind === 'versioning' && request.action === 'release') {
			await pending;
		}
		return storage(request);
	});
	return finish;
}

function attemptNavigation() {
	const cancel = vi.fn();
	vi.mocked(beforeNavigate).mock.lastCall![0]({
		cancel,
		type: 'goto',
		shallow: false,
		from: null,
		to: { url: new URL('http://localhost/'), params: {}, route: { id: '/' }, scroll: null },
		willUnload: false,
		complete: Promise.resolve()
	});
	return cancel;
}

it('releases applied content while retaining the draft, then marks a successful Apply as modified without releasing again', async () => {
	const game = await createGame();
	render(GameEditor, { gameId: game.id });
	await expect.element(finalize()).toBeEnabled();
	await nameInput().fill('미적용 게임 이름');
	await expect.poll(() => drafts.get(game.id)?.draft?.documents.info).toContain('미적용 게임 이름');
	expect((await getGameVersioning(game.id)).releases).toHaveLength(0);
	await versionInput().fill('1.0.0');
	await finalize().click();
	await expect.element(panel()).toHaveTextContent('1.0.0 배포본을 확정했어요.');
	const state = await getGameVersioning(game.id);
	expect(state.currentRelease).not.toBeNull();
	const release = await getGameRelease(game.id, state.currentRelease!.id);
	expect(release.content.title).toBe(game.title);
	await expect.element(nameInput()).toHaveValue('미적용 게임 이름');
	expect(loadEditorDraft(game.id)?.documents.info).toContain('미적용 게임 이름');
	await expect.element(panel()).toHaveTextContent('미적용 초안이 있어요.');
	expect(panel().element().textContent).not.toContain('수정됨');
	await apply().click();
	await expect.element(panel()).toHaveTextContent('수정됨');
	expect(panel().element().textContent).not.toContain('미적용 초안이 있어요.');
	expect((await getGameVersioning(game.id)).releases).toHaveLength(1);
	expect((await getGameWorkspace(game.id))?.game.title).toBe('미적용 게임 이름');
});

it('blocks Apply, keyboard shortcuts, discard and navigation until a release completes even if its panel unmounts', async () => {
	const game = await createGame();
	render(GameEditor, { gameId: game.id });
	await expect.element(finalize()).toBeEnabled();
	await nameInput().fill('보존할 초안');
	await versionInput().fill('1.0.0');
	const finish = delayRelease();
	await finalize().click();
	await expect.element(apply()).toBeDisabled();
	await expect.element(nameInput()).toBeDisabled();
	await expect.element(page.getByRole('button', { name: '변경 취소', exact: true })).toBeDisabled();
	await userEvent.keyboard('{Control>}{Enter}{/Control}');
	expect((await getGameWorkspace(game.id))?.game.title).toBe(game.title);
	expect(attemptNavigation()).toHaveBeenCalledOnce();
	await page.getByRole('button', { name: /instructions\.json/ }).click();
	await expect.element(versionInput()).not.toBeInTheDocument();
	await expect.element(apply()).toBeDisabled();
	expect(attemptNavigation()).toHaveBeenCalledOnce();
	await page.getByRole('tab', { name: /^게임 정보/ }).click();
	await expect.element(panel()).toHaveTextContent('미출시');
	finish();
	await expect.element(apply()).toBeEnabled();
	await expect.element(panel()).toHaveTextContent('1.0.0');
	await expect.element(nameInput()).toHaveValue('보존할 초안');
	expect((await getGameVersioning(game.id)).releases).toHaveLength(1);
	await apply().click();
	await expect.element(panel()).toHaveTextContent('수정됨');
});

it('blocks release during Apply and refreshes the applied status when Apply completes', async () => {
	const game = await createGame();
	render(GameEditor, { gameId: game.id });
	await expect.element(finalize()).toBeEnabled();
	await nameInput().fill('적용 중인 초안');
	const save = vi.mocked(saveAuthoringDraft).getMockImplementation()!;
	let finish!: () => void;
	const pending = new Promise<void>((resolve) => {
		finish = resolve;
	});
	vi.mocked(saveAuthoringDraft).mockImplementation(async (...args) => {
		await pending;
		return save(...args);
	});
	await apply().click();
	await expect.element(finalize()).toBeDisabled();
	await expect.element(versionInput()).toBeDisabled();
	expect((await getGameVersioning(game.id)).releases).toHaveLength(0);
	finish();
	await expect.element(finalize()).toBeEnabled();
	await expect.element(panel()).toHaveTextContent('미출시');
	await expect.element(nameInput()).toHaveValue('적용 중인 초안');
	expect((await getGameVersioning(game.id)).releases).toHaveLength(0);
});
