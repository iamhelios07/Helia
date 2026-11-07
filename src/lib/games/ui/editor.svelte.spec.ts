import '../../../app.css';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { goto } from '$app/navigation';
import GameEditor from './GameEditor.svelte';
import { createGame, createSession, getGameWorkspace, updateGameSettings } from '../repository.js';
import { loadEditorDraft } from '../editor.js';
import { loadEditorLayout } from '../editor-layout.js';
import { loadSettingsDraft, storeSettingsDraft } from '../settings-draft.js';

vi.mock('$app/navigation', () => ({ goto: vi.fn(), beforeNavigate: vi.fn() }));
vi.mock('#lib/storage/transport.js', async () => {
	const { memoryStorage } = await import('#lib/testing/memory-storage.js');
	return { storageRequest: vi.fn(memoryStorage()) };
});

beforeEach(async () => {
	vi.clearAllMocks();
	localStorage.clear();
	await page.viewport(1200, 800);
});
afterEach(() => vi.restoreAllMocks());

const nameInput = () => page.getByRole('textbox', { name: '이름', exact: true });
const applyButton = () => page.getByRole('button', { name: '적용', exact: true });
const returnLink = () => page.getByRole('link', { name: '플레이로 돌아가기' });
const heightHandle = () => page.getByRole('slider', { name: '검사 패널 높이 조절' });

it('keeps document edits in a local draft until atomic apply, preserving the play session', async () => {
	const game = await createGame();
	const active = await createSession(game.id);
	const before = await getGameWorkspace(game.id);
	render(GameEditor, { gameId: game.id });
	await expect.element(nameInput()).toBeVisible();
	await nameInput().fill('수정한 게임');
	await page.getByRole('textbox', { name: '소개', exact: true }).fill('라이브러리 소개');
	await page.getByRole('tab', { name: /^게임 지침/ }).click();
	await page.getByRole('textbox', { name: '게임 설명', exact: true }).fill('  AI 게임 설명\n');
	await page.getByRole('textbox', { name: '첫 메시지', exact: true }).fill('  시작\n둘째 줄  ');
	await expect.poll(() => loadEditorDraft(game.id)?.documents.instructions).toContain('둘째 줄');
	expect((await getGameWorkspace(game.id))?.game).toEqual(before?.game);
	await page.getByRole('button', { name: '게임 지침 문서 닫기' }).click();
	await page.getByRole('button', { name: /instructions\.json/ }).click();
	await expect
		.element(page.getByRole('textbox', { name: '첫 메시지', exact: true }))
		.toHaveValue('  시작\n둘째 줄  ');
	await applyButton().click();
	await expect.poll(async () => (await getGameWorkspace(game.id))?.game.title).toBe('수정한 게임');
	const saved = await getGameWorkspace(game.id);
	expect(saved?.game.description).toBe('라이브러리 소개');
	expect(saved?.game.settings.description).toBe('  AI 게임 설명\n');
	expect(saved?.game.settings.firstMessage).toBe('  시작\n둘째 줄  ');
	expect(saved?.game.activeSessionId).toBe(active.id);
	expect(saved?.sessions).toHaveLength(before?.sessions.length ?? 0);
	await expect.poll(() => loadEditorDraft(game.id)).toBeNull();
	await returnLink().click();
	expect(goto).toHaveBeenCalledWith(`/games/${game.id}`);
});

it('restores unfinished source across remounts, reports errors, and permits leaving with a saved draft', async () => {
	const game = await createGame();
	const screen = render(GameEditor, { gameId: game.id });
	await expect.element(nameInput()).toBeVisible();
	await page.getByRole('button', { name: /schema\.json/ }).click();
	const source = page.getByRole('textbox', { name: '상태 스키마 소스', exact: true });
	await source.fill('{unfinished');
	await expect.element(applyButton()).toBeDisabled();
	await expect
		.element(page.getByRole('tabpanel', { name: '문제', exact: true }))
		.toHaveTextContent('JSON');
	await expect.poll(() => loadEditorDraft(game.id)?.documents.schema).toBe('{unfinished');
	await screen.unmount();
	render(GameEditor, { gameId: game.id });
	await expect.element(nameInput()).toBeVisible();
	await page.getByRole('button', { name: /schema\.json/ }).click();
	await expect.element(source).toHaveValue('{unfinished');
	await returnLink().click();
	expect(goto).toHaveBeenCalledWith(`/games/${game.id}`);
	expect((await getGameWorkspace(game.id))?.game.schema).toEqual(game.schema);
});

it('retains edits and blocks return when local draft storage fails, then retries', async () => {
	const game = await createGame();
	render(GameEditor, { gameId: game.id });
	await expect.element(nameInput()).toBeVisible();
	const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
		throw new Error('Storage unavailable');
	});
	await nameInput().fill('보존할 초안');
	await returnLink().click();
	await expect.element(page.getByRole('alert')).toBeVisible();
	expect(goto).not.toHaveBeenCalled();
	await expect.element(nameInput()).toHaveValue('보존할 초안');
	storage.mockRestore();
	await page.getByRole('button', { name: '초안 저장 다시 시도' }).click();
	await expect.poll(() => loadEditorDraft(game.id)?.documents.info).toContain('보존할 초안');
	await returnLink().click();
	expect(goto).toHaveBeenCalledWith(`/games/${game.id}`);
	expect((await getGameWorkspace(game.id))?.game.title).toBe(game.title);
});

it('preserves the local draft when another screen changes the applied game', async () => {
	const game = await createGame();
	render(GameEditor, { gameId: game.id });
	await expect.element(nameInput()).toBeVisible();
	await nameInput().fill('편집 중인 초안');
	await updateGameSettings(game.id, { title: '다른 화면의 수정', ...game.settings });
	await applyButton().click();
	await expect.element(page.getByRole('alert')).toHaveTextContent('다른 화면에서 게임이 변경');
	await expect.element(nameInput()).toHaveValue('편집 중인 초안');
	expect((await getGameWorkspace(game.id))?.game.title).toBe('다른 화면의 수정');
	expect(loadEditorDraft(game.id)?.documents.info).toContain('편집 중인 초안');
});

it('restores pane sizes, keeps resize bounds usable, and preserves expanded height after collapsing', async () => {
	const game = await createGame();
	// Width-only preferences from before the inspector resizer remain usable.
	localStorage.setItem(
		'helia:editor-layout:' + game.id,
		JSON.stringify({ version: 1, explorerWidth: 240, previewWidth: 300 })
	);
	const screen = render(GameEditor, { gameId: game.id });
	const explorer = page.getByRole('slider', { name: '탐색기 너비 조절' });
	await expect.element(explorer).toHaveAttribute('aria-valuenow', '240');
	explorer.element().focus();
	await userEvent.keyboard('{ArrowRight}');
	await expect.element(explorer).toHaveAttribute('aria-valuenow', '250');
	heightHandle().element().focus();
	await userEvent.keyboard('{ArrowUp}{ArrowUp}');
	await expect.element(heightHandle()).toHaveAttribute('aria-valuenow', '198');
	expect(loadEditorLayout(game.id)).toEqual({
		explorerWidth: 250,
		previewWidth: 300,
		bottomHeight: 198
	});
	await page.getByRole('button', { name: '검사 패널 접기' }).click();
	expect(heightHandle().query()).toBeNull();
	await page.getByRole('button', { name: '검사 패널 펼치기' }).click();
	await expect.element(heightHandle()).toHaveAttribute('aria-valuenow', '198');
	await screen.unmount();
	render(GameEditor, { gameId: game.id });
	await expect.element(heightHandle()).toHaveAttribute('aria-valuenow', '198');
	await expect.element(explorer).toHaveAttribute('aria-valuenow', '250');
	heightHandle().element().focus();
	await userEvent.keyboard('{End}');
	const maximum = heightHandle().element().getAttribute('aria-valuemax');
	await expect.element(heightHandle()).toHaveAttribute('aria-valuenow', maximum!);
	await page.viewport(1200, 450);
	await expect
		.poll(() => Number(heightHandle().element().getAttribute('aria-valuemax')))
		.toBeLessThan(Number(maximum));
	// A small window clamps the displayed size without replacing the user's preference.
	expect(loadEditorLayout(game.id)?.bottomHeight).toBe(Number(maximum));
	expect(
		document.querySelector('.document-workspace')!.getBoundingClientRect().height
	).toBeGreaterThanOrEqual(139);
});

it('edits an independent document in the secondary pane without replacing the main form', async () => {
	const game = await createGame();
	render(GameEditor, { gameId: game.id });
	await expect.element(nameInput()).toBeVisible();
	await page.getByRole('button', { name: '편집기 좌우 분할' }).click();
	await page.getByRole('combobox', { name: '문서', exact: true }).selectOptions('instructions');
	const value = JSON.stringify({ ...game.settings, firstMessage: '보조 편집기의 시작' }, null, 2);
	await page.getByRole('textbox', { name: '보조 게임 지침 소스', exact: true }).fill(value);
	await expect.element(nameInput()).toHaveValue(game.title);
	await expect.poll(() => loadEditorDraft(game.id)?.documents.instructions).toBe(value);
	await page.getByRole('button', { name: '보조 편집기 닫기' }).click();
	await page.getByRole('tab', { name: /^게임 지침/ }).click();
	await expect
		.element(page.getByRole('textbox', { name: '첫 메시지', exact: true }))
		.toHaveValue('보조 편집기의 시작');
	expect((await getGameWorkspace(game.id))?.game.settings.firstMessage).toBe(
		game.settings.firstMessage
	);
});

it('migrates earlier recovered settings into a draft without applying them', async () => {
	const game = await createGame();
	storeSettingsDraft(game.id, {
		title: '복구한 게임',
		description: '복구 설명',
		firstMessage: '복구 시작',
		authorNote: '복구 노트'
	});
	render(GameEditor, { gameId: game.id });
	await expect.element(nameInput()).toHaveValue('복구한 게임');
	await page.getByRole('tab', { name: /^게임 지침/ }).click();
	await expect
		.element(page.getByRole('textbox', { name: '첫 메시지', exact: true }))
		.toHaveValue('복구 시작');
	expect(loadEditorDraft(game.id)?.documents.instructions).toContain('복구 노트');
	expect(loadSettingsDraft(game.id)).toBeNull();
	expect((await getGameWorkspace(game.id))?.game.title).toBe(game.title);
});

it('keeps panels reachable without horizontal overflow on a narrow screen', async () => {
	await page.viewport(320, 640);
	const game = await createGame();
	render(GameEditor, { gameId: game.id });
	await expect.element(nameInput()).toBeVisible();
	expect(page.getByRole('complementary', { name: '게임 탐색기', exact: true }).query()).toBeNull();
	expect(
		page.getByRole('complementary', { name: '초안 미리보기', exact: true }).query()
	).toBeNull();
	await page.getByRole('button', { name: '탐색기', exact: true }).click();
	await expect
		.element(page.getByRole('complementary', { name: '게임 탐색기', exact: true }))
		.toBeVisible();
	await page.getByRole('button', { name: '탐색기', exact: true }).click();
	await page.getByRole('button', { name: '미리보기', exact: true }).click();
	await expect
		.element(page.getByRole('complementary', { name: '초안 미리보기', exact: true }))
		.toBeVisible();
	expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(320);
	await expect.element(returnLink()).toBeVisible();
});
