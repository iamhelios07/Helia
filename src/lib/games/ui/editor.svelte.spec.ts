import '../../../app.css';
import { beforeNavigate, goto } from '$app/navigation';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';

import type { EditorDraft } from '../editor.js';

import { loadAuthoringDraft, saveAuthoringDraft } from '../editor-draft-storage.js';
import { loadEditorLayout } from '../editor-layout.js';
import { loadEditorDraft } from '../editor.js';
import { createGame, createSession, getGameWorkspace, updateGameSettings } from '../repository.js';
import { loadSettingsDraft, storeSettingsDraft } from '../settings-draft.js';
import { getMonacoSource, monacoModel, setMonacoSource } from './editor/monaco-test.js';
import GameEditor from './GameEditor.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn(), beforeNavigate: vi.fn() }));
vi.mock('../editor-draft-storage.js', () => ({
	loadAuthoringDraft: vi.fn(),
	saveAuthoringDraft: vi.fn()
}));
vi.mock('#lib/storage/transport.js', async () => {
	const { memoryStorage } = await import('#lib/testing/memory-storage.js');
	return { storageRequest: vi.fn(memoryStorage()) };
});

const durableDrafts = new Map<string, { version: number; draft: EditorDraft | null }>();
beforeEach(async () => {
	vi.clearAllMocks();
	durableDrafts.clear();
	vi.mocked(loadAuthoringDraft)
		.mockReset()
		.mockImplementation(async (gameId) =>
			structuredClone(durableDrafts.get(gameId) ?? { version: 0, draft: null })
		);
	vi.mocked(saveAuthoringDraft)
		.mockReset()
		.mockImplementation(async (gameId, draft, version) => {
			const previous = durableDrafts.get(gameId) ?? { version: 0, draft: null };
			if (previous.version !== version) {
				throw new Error('다른 편집기에서 초안이 변경되었어요.');
			}
			const next = structuredClone({ version: version + 1, draft });
			durableDrafts.set(gameId, next);
			return next;
		});
	localStorage.clear();
	await page.viewport(1200, 800);
});
afterEach(() => vi.restoreAllMocks());

const nameInput = () => page.getByRole('textbox', { name: '이름', exact: true });
const applyButton = () => page.getByRole('button', { name: '적용', exact: true });
const returnLink = () => page.getByRole('link', { name: '플레이로 돌아가기' });
const heightHandle = () => page.getByRole('slider', { name: '검사 패널 높이 조절' });

it('keeps the editor usable while incomplete code produces repeated diagnostic messages', async () => {
	const game = await createGame();
	render(GameEditor, { gameId: game.id });
	await expect.element(nameInput()).toBeVisible();
	await page.getByRole('button', { name: /main\.ts.*진입점/ }).click();
	await setMonacoSource('main.ts 소스', 'export {};\nhelia.');
	const problems = page.getByRole('tabpanel', { name: '문제', exact: true });
	await expect.element(problems).toHaveTextContent('Identifier expected.');
	await expect.element(applyButton()).toBeDisabled();
	await expect
		.element(page.getByRole('textbox', { name: 'main.ts 소스', exact: true }))
		.toBeVisible();
	await expect.poll(() => getMonacoSource('main.ts 소스')).toBe('export {};\nhelia.');

	// The same parser message at different locations must remain independently navigable.
	await setMonacoSource('main.ts 소스', 'export {};\nhelia.;\nhelia.');
	const repeated = problems.getByRole('button', { name: /Identifier expected\./ });
	await expect.poll(() => repeated.elements().length, { timeout: 20000 }).toBe(2);
	await repeated.nth(1).click();
	const model = await monacoModel('main.ts 소스');
	await expect
		.poll(() => document.querySelector('.source-editor footer')?.textContent)
		.toContain('줄 3, 열 7');
	expect(model.getValue()).toBe('export {};\nhelia.;\nhelia.');

	await setMonacoSource('main.ts 소스', 'export {};');
	await expect.element(problems).toHaveTextContent('문서 형식 검사를 통과했어요.');
	await expect.element(applyButton()).toBeEnabled();
}, 30000);

it('edits source files as project tabs, keeps imports on rename, and hides storage manifests', async () => {
	const game = await createGame();
	render(GameEditor, { gameId: game.id });
	await expect.element(nameInput()).toBeVisible();
	await expect
		.element(page.getByRole('button', { name: /scripts\.json|ui\.json|resources\.json/ }))
		.not.toBeInTheDocument();
	await page.getByRole('button', { name: '새 코드 파일', exact: true }).click();
	await page.getByRole('textbox', { name: '프로젝트 상대 경로' }).fill('logic.ts');
	await page.getByRole('button', { name: '확인', exact: true }).click();
	const logic = page.getByRole('textbox', { name: 'logic.ts 소스', exact: true });
	await expect.element(logic).toBeVisible();
	await setMonacoSource(
		'logic.ts 소스',
		'export default function register() {\n  helia.defineQuery({name:"answer", arguments:{}, run:()=>42});\n}\n'
	);
	await page.getByRole('button', { name: '새 코드 파일', exact: true }).click();
	await page.getByRole('textbox', { name: '프로젝트 상대 경로' }).fill('logic.ts');
	await page.getByRole('button', { name: '확인', exact: true }).click();
	await expect
		.element(page.getByRole('main').getByRole('alert'))
		.toHaveTextContent('같은 경로가 이미 있어요.');
	await page.getByRole('button', { name: '취소', exact: true }).click();
	await expect.poll(() => getMonacoSource('logic.ts 소스')).toContain('answer');
	await page.getByRole('button', { name: /main\.ts.*진입점/ }).click();
	await setMonacoSource('main.ts 소스', "export { default as logic } from './logic';");
	await page.getByRole('tab', { name: /logic\.ts/ }).click();
	await expect.element(logic).toHaveValue(expect.stringContaining('answer'));
	await page.getByRole('button', { name: '이름 변경', exact: true }).click();
	await page.getByRole('textbox', { name: '프로젝트 상대 경로' }).fill('logic/queries.ts');
	await page.getByRole('button', { name: '확인', exact: true }).click();
	await expect
		.element(page.getByRole('textbox', { name: 'logic/queries.ts 소스', exact: true }))
		.toBeVisible();
	await page.getByRole('tab', { name: /main\.ts/ }).click();
	await expect
		.poll(() => getMonacoSource('main.ts 소스'))
		.toBe("export { default as logic } from './logic/queries.ts';");
	await expect
		.poll(
			() =>
				JSON.parse(loadEditorDraft(game.id)?.documents.code ?? '{}').files?.['logic/queries.ts']
					?.source
		)
		.toContain('answer');
	await page.getByRole('button', { name: /GameState\.d\.ts.*자동/ }).click();
	await expect
		.element(page.getByRole('textbox', { name: 'GameState.d.ts 소스', exact: true }))
		.toHaveAttribute('readonly');
	await expect
		.element(page.getByRole('button', { name: 'JSON으로 편집', exact: true }))
		.not.toBeInTheDocument();
});

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
	await page.getByRole('button', { name: /state\.json/ }).click();
	await page.getByRole('button', { name: 'JSON으로 편집', exact: true }).click();
	await setMonacoSource('상태 소스', '{unfinished');
	await expect.element(applyButton()).toBeDisabled();
	await expect
		.element(page.getByRole('tabpanel', { name: '문제', exact: true }))
		.toHaveTextContent('JSON');
	await expect.poll(() => durableDrafts.get(game.id)?.draft?.documents.state).toBe('{unfinished');
	await screen.unmount();
	localStorage.clear();
	render(GameEditor, { gameId: game.id });
	await expect.element(nameInput()).toBeVisible();
	await page.getByRole('button', { name: /state\.json/ }).click();
	await page.getByRole('button', { name: 'JSON으로 편집', exact: true }).click();
	await expect.poll(() => getMonacoSource('상태 소스')).toBe('{unfinished');
	await returnLink().click();
	expect(goto).toHaveBeenCalledWith(`/games/${game.id}`);
	expect((await getGameWorkspace(game.id))?.game.schema).toEqual(game.schema);
});

it('retains edits and blocks return when durable draft storage fails, then retries', async () => {
	const game = await createGame();
	render(GameEditor, { gameId: game.id });
	await expect.element(nameInput()).toBeVisible();
	vi.mocked(saveAuthoringDraft).mockRejectedValueOnce(new Error('Durable storage unavailable'));
	await nameInput().fill('보존할 초안');
	await returnLink().click();
	await expect.element(page.getByRole('main').getByRole('alert')).toBeVisible();
	expect(goto).not.toHaveBeenCalled();
	await expect.element(nameInput()).toHaveValue('보존할 초안');
	await page.getByRole('button', { name: '초안 저장 다시 시도' }).click();
	await expect
		.poll(() => durableDrafts.get(game.id)?.draft?.documents.info)
		.toContain('보존할 초안');
	await returnLink().click();
	expect(goto).toHaveBeenCalledWith(`/games/${game.id}`);
	expect((await getGameWorkspace(game.id))?.game.title).toBe(game.title);
});

it('serializes pending saves and waits for the latest draft before returning to play', async () => {
	const game = await createGame();
	const save = vi.mocked(saveAuthoringDraft);
	const normallySave = save.getMockImplementation()!;
	let release: (() => void) | undefined;
	save.mockImplementationOnce(async (...args) => {
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		return normallySave(...args);
	});
	render(GameEditor, { gameId: game.id });
	await expect.element(nameInput()).toBeVisible();
	await nameInput().fill('먼저 저장할 초안');
	await expect.poll(() => save.mock.calls.length).toBe(1);
	await nameInput().fill('마지막 초안');
	await returnLink().click();
	await expect.element(nameInput()).toBeDisabled();
	expect(goto).not.toHaveBeenCalled();
	release!();
	await expect
		.poll(() => durableDrafts.get(game.id)?.draft?.documents.info)
		.toContain('마지막 초안');
	await expect.poll(() => vi.mocked(goto).mock.calls.length).toBe(1);
	expect(durableDrafts.get(game.id)?.version).toBe(2);
	expect((await getGameWorkspace(game.id))?.game.title).toBe(game.title);
});

it('recovers an unsaved cache after a durable save failure and persists it on reopening', async () => {
	const game = await createGame();
	const save = vi.mocked(saveAuthoringDraft);
	const normallySave = save.getMockImplementation()!;
	save.mockRejectedValue(new Error('Durable storage unavailable'));
	const screen = render(GameEditor, { gameId: game.id });
	await expect.element(nameInput()).toBeVisible();
	await nameInput().fill('저장 실패 후 복구할 내용');
	await returnLink().click();
	await expect
		.element(page.getByRole('main').getByRole('alert'))
		.toHaveTextContent('Durable storage unavailable');
	await screen.unmount();
	// Let the rejected final flush finish before simulating a new process.
	await new Promise((resolve) => setTimeout(resolve, 0));
	save.mockImplementation(normallySave);
	render(GameEditor, { gameId: game.id });
	await expect.element(nameInput()).toHaveValue('저장 실패 후 복구할 내용');
	await expect
		.poll(() => durableDrafts.get(game.id)?.draft?.documents.info)
		.toContain('저장 실패 후 복구할 내용');
	expect((await getGameWorkspace(game.id))?.game.title).toBe(game.title);
});

it('flushes edits before intercepted internal navigation and retains the destination query and hash', async () => {
	const game = await createGame();
	render(GameEditor, { gameId: game.id });
	await expect.element(nameInput()).toBeVisible();
	await nameInput().fill('이동하기 전 보존');
	const callback = vi.mocked(beforeNavigate).mock.lastCall![0];
	const cancel = vi.fn();
	callback({
		cancel,
		type: 'goto',
		shallow: false,
		from: null,
		to: {
			url: new URL('http://localhost/?from=editor#latest'),
			params: {},
			route: { id: '/' },
			scroll: null
		},
		willUnload: false,
		complete: Promise.resolve()
	});
	expect(cancel).toHaveBeenCalledOnce();
	await expect.poll(() => vi.mocked(goto).mock.calls.length).toBe(1);
	expect(goto).toHaveBeenCalledWith('/?from=editor#latest');
	expect(durableDrafts.get(game.id)?.draft?.documents.info).toContain('이동하기 전 보존');
});

it('edits schema and initial values bidirectionally through GUI and canonical JSON', async () => {
	const game = await createGame();
	render(GameEditor, { gameId: game.id });
	await expect.element(nameInput()).toBeVisible();
	await page.getByRole('button', { name: /state\.json/ }).click();
	expect(page.getByRole('button', { name: /schema\.json|initial-state\.json/ }).query()).toBeNull();
	await page.getByRole('textbox', { name: '상태 새 필드 이름', exact: true }).fill('hp');
	await page.getByRole('button', { name: '필드 추가', exact: true }).click();
	await page.getByRole('checkbox', { name: '상태.hp 필수', exact: true }).click();
	await page.getByRole('combobox', { name: '상태.hp 타입', exact: true }).selectOptions('integer');
	await page.getByRole('button', { name: '변경', exact: true }).click();
	await page.getByRole('spinbutton', { name: '상태.hp 초기값', exact: true }).fill('9');
	await expect.poll(() => durableDrafts.get(game.id)?.draft?.documents.state).toContain('9');
	await page.getByRole('button', { name: 'JSON으로 편집', exact: true }).click();
	const parsed = JSON.parse(await getMonacoSource('상태 소스'));
	expect(parsed.schema.properties.hp.type).toBe('integer');
	expect(parsed.schema.required).toContain('hp');
	expect(parsed.initialState.hp).toBe(9);
	parsed.schema.properties.hp.title = '체력';
	parsed.initialState.hp = 12;
	await setMonacoSource('상태 소스', JSON.stringify(parsed, null, 2));
	await page.getByRole('button', { name: 'GUI로 편집', exact: true }).click();
	await page.getByRole('button', { name: '상태.hp 상세 설정', exact: true }).click();
	await expect
		.element(page.getByRole('textbox', { name: '상태.hp 표시 이름', exact: true }))
		.toHaveValue('체력');
	await expect
		.element(page.getByRole('spinbutton', { name: '상태.hp 초기값', exact: true }))
		.toHaveValue(12);
	expect((await getGameWorkspace(game.id))?.game.initialState).toEqual(game.initialState);
});

it('requires modal confirmation to discard and ignores stale cache after the durable draft is cleared', async () => {
	const game = await createGame();
	const screen = render(GameEditor, { gameId: game.id });
	await expect.element(nameInput()).toBeVisible();
	await nameInput().fill('버릴 초안');
	await expect.poll(() => durableDrafts.get(game.id)?.draft?.documents.info).toContain('버릴 초안');
	await page.getByRole('button', { name: '변경 취소', exact: true }).click();
	await expect
		.element(page.getByRole('dialog', { name: '초안 버리기', exact: true }))
		.toBeVisible();
	await page.getByRole('button', { name: '취소', exact: true }).click();
	await expect.element(nameInput()).toHaveValue('버릴 초안');
	const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
		throw new Error('Cache unavailable');
	});
	await page.getByRole('button', { name: '변경 취소', exact: true }).click();
	await page.getByRole('button', { name: '초안 버리기', exact: true }).click();
	await expect.element(nameInput()).toHaveValue(game.title);
	expect(durableDrafts.get(game.id)?.draft).toBeNull();
	expect(loadEditorDraft(game.id)?.documents.info).toContain('버릴 초안');
	remove.mockRestore();
	await screen.unmount();
	render(GameEditor, { gameId: game.id });
	await expect.element(nameInput()).toHaveValue(game.title);
	await expect.element(applyButton()).toBeDisabled();
});

it('keeps the runtime playground mounted across preview visibility and mode changes', async () => {
	const game = await createGame();
	render(GameEditor, { gameId: game.id });
	await expect.element(nameInput()).toBeVisible();
	const playground = document.querySelector('.playground');
	expect(playground).not.toBeNull();
	await page.getByRole('button', { name: '테스트 플레이', exact: true }).click();
	expect(document.querySelector('.playground')).toBe(playground);
	await page.getByRole('button', { name: '미리보기', exact: true }).click();
	await expect
		.element(
			page.getByRole('complementary', { name: '초안 미리보기', exact: true, includeHidden: true })
		)
		.not.toBeVisible();
	expect(document.querySelector('.playground')).toBe(playground);
	await page.getByRole('button', { name: '미리보기', exact: true }).click();
	await page.getByRole('button', { name: '실행 미리보기', exact: true }).click();
	expect(document.querySelector('.playground')).toBe(playground);
});

it('preserves the local draft when another screen changes the applied game', async () => {
	const game = await createGame();
	render(GameEditor, { gameId: game.id });
	await expect.element(nameInput()).toBeVisible();
	await nameInput().fill('편집 중인 초안');
	await updateGameSettings(game.id, { title: '다른 화면의 수정', ...game.settings });
	await applyButton().click();
	await expect
		.element(page.getByRole('main').getByRole('alert'))
		.toHaveTextContent('다른 화면에서 게임이 변경');
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

it('scrolls the state GUI above the inspector even when the inspector is enlarged', async () => {
	const game = await createGame();
	render(GameEditor, { gameId: game.id });
	await expect.element(nameInput()).toBeVisible();
	await page.getByRole('button', { name: /state\.json/ }).click();
	for (const height of [500, 400]) {
		await page.viewport(1200, height);
		heightHandle().element().focus();
		await userEvent.keyboard('{End}');
		const editor = document.querySelector<HTMLElement>('.state-editor')!;
		await expect.poll(() => editor.clientHeight).toBeGreaterThan(0);
		expect(getComputedStyle(editor).overflowY).toBe('auto');
		expect(editor.scrollHeight).toBeGreaterThan(editor.clientHeight);
		const inspector = page.getByRole('region', { name: '편집기 검사', exact: true }).element();
		expect(editor.getBoundingClientRect().bottom).toBeLessThanOrEqual(
			inspector.getBoundingClientRect().top
		);
		editor.scrollTop = editor.scrollHeight;
		await expect.poll(() => editor.scrollTop).toBeGreaterThan(0);
		const lastSection = editor.querySelector('section:last-of-type')!;
		expect(lastSection.getBoundingClientRect().bottom).toBeLessThanOrEqual(
			editor.getBoundingClientRect().bottom
		);
	}
});

it('edits an independent document in the secondary pane without replacing the main form', async () => {
	const game = await createGame();
	render(GameEditor, { gameId: game.id });
	await expect.element(nameInput()).toBeVisible();
	await page.getByRole('button', { name: '편집기 좌우 분할' }).click();
	await page.getByRole('combobox', { name: '문서', exact: true }).selectOptions('instructions');
	const value = JSON.stringify({ ...game.settings, firstMessage: '보조 편집기의 시작' }, null, 2);
	await setMonacoSource('보조 게임 지침 소스', value);
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

it('stretches the document pane across the available editor width on every tab', async () => {
	const game = await createGame();
	render(GameEditor, { gameId: game.id });
	await expect.element(nameInput()).toBeVisible();
	const panes = () => document.querySelector<HTMLElement>('.document-panes')!;
	const documentPane = () => document.querySelector<HTMLElement>('#editor-document')!;
	const fillsPanes = () => {
		expect(panes().getBoundingClientRect().width).toBeGreaterThan(600);
		expect(documentPane().getBoundingClientRect().width).toBeCloseTo(
			panes().getBoundingClientRect().width,
			0
		);
	};
	fillsPanes();
	// A narrow pane would clamp the fieldset far below its 700px max-width.
	expect(nameInput().element().getBoundingClientRect().width).toBeGreaterThan(500);
	await page.getByRole('button', { name: /state\.json/ }).click();
	await expect.poll(() => !!document.querySelector('.state-editor')).toBe(true);
	fillsPanes();
	await page.getByRole('tab', { name: /^게임 지침/ }).click();
	await expect.element(page.getByRole('textbox', { name: '첫 메시지', exact: true })).toBeVisible();
	fillsPanes();
	await page.getByRole('button', { name: '편집기 좌우 분할' }).click();
	await expect
		.poll(() => documentPane().getBoundingClientRect().width)
		.toBeCloseTo(panes().getBoundingClientRect().width / 2, -1);
});

it('keeps panels reachable without horizontal overflow on a narrow screen', async () => {
	await page.viewport(320, 640);
	const game = await createGame();
	render(GameEditor, { gameId: game.id });
	await expect.element(nameInput()).toBeVisible();
	expect(page.getByRole('complementary', { name: '게임 탐색기', exact: true }).query()).toBeNull();
	expect(
		page
			.getByRole('complementary', { name: '초안 미리보기', exact: true, includeHidden: true })
			.query()
	).not.toBeNull();
	await expect
		.element(
			page.getByRole('complementary', { name: '초안 미리보기', exact: true, includeHidden: true })
		)
		.not.toBeVisible();
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

it('opens the declaration tab from a helia definition and marks it read-only', async () => {
	const game = await createGame();
	render(GameEditor, { gameId: game.id });
	await expect.element(nameInput()).toBeVisible();
	await page.getByRole('button', { name: /main\.ts.*진입점/ }).click();
	await expect
		.element(page.getByRole('textbox', { name: 'main.ts 소스', exact: true }))
		.toBeVisible();
	const source = "helia.defineAction({name:'buy',run({state}){return state;}});";
	await setMonacoSource('main.ts 소스', source);
	const model = await monacoModel('main.ts 소스');
	const { getTypeScriptWorker } =
		await import('monaco-editor/languages/features/typescript/register.js');
	// The worker resolves helia to the shipped declaration file, not to a string in memory.
	await expect
		.poll(async () => {
			const proxy = await (await getTypeScriptWorker())(model.uri);
			const at = source.indexOf('defineAction') + 2;
			const definitions = await proxy.getDefinitionAtPosition(model.uri.toString(), at);
			return definitions?.[0]?.fileName;
		})
		.toMatch(/\.helia\/runtime\.d\.ts$/);
	// The declaration opens as a read-only code tab with the shipped content.
	await page.getByRole('button', { name: /runtime\.d\.ts/ }).click();
	const tab = page.getByRole('textbox', { name: '.helia/runtime.d.ts 소스', exact: true });
	await expect.element(tab).toBeVisible();
	await expect.element(tab).toHaveAttribute('readonly');
	await expect
		.poll(() => document.querySelector('.document-breadcrumb')?.textContent)
		.toContain('.helia/runtime.d.ts');
	expect(await getMonacoSource('.helia/runtime.d.ts 소스')).toContain('interface HeliaRuntime');
	expect(
		document.querySelector('.document-workspace')!.getBoundingClientRect().width
	).toBeGreaterThan(600);
});
