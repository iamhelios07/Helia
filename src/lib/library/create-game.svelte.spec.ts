import { page, userEvent } from 'vitest/browser';
import '../../app.css';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render as renderSvelte } from 'vitest-browser-svelte';
import AppFixture from '../testing/AppFixture.svelte';
import { goto } from '$app/navigation';
import Home from '../../routes/+page.svelte';
import GameWorkspace from '../games/ui/GameWorkspace.svelte';
import {
	listGames,
	createGame,
	getGameWorkspace,
	createSession,
	selectSession,
	updateGameSettings,
	renameSession,
	deleteSession,
	getSessionConversation,
	appendUserMessage
} from '../games/repository.js';
import type { Message, Game, Session, SessionConversation } from '../games/model.js';
import { loadSettingsDraft, storeSettingsDraft } from '../games/settings-draft.js';
import {
	SIDEBAR_WIDTH_STORAGE_KEY,
	SIDEBAR_COLLAPSED_STORAGE_KEY
} from '../app/preferences/sidebar.js';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('../games/repository.js', () => ({
	listGames: vi.fn(),
	createGame: vi.fn(),
	getGameWorkspace: vi.fn(),
	createSession: vi.fn(),
	selectSession: vi.fn(),
	updateGameSettings: vi.fn(),
	renameSession: vi.fn(),
	deleteSession: vi.fn(),
	getSessionConversation: vi.fn(),
	getSessionTimeline: vi.fn(),
	selectSessionBranch: vi.fn(),
	deleteSessionEvent: vi.fn(),
	appendUserMessage: vi.fn()
}));

const game: Game = {
	schemaVersion: 2,
	schema: {
		type: 'object',
		properties: { gold: { type: 'integer' } },
		additionalProperties: false
	},
	initialState: {},
	scripts: {},
	id: 'game-one',
	title: '새 게임',
	genre: '',
	description: '',
	settings: { description: '', firstMessage: '', authorNote: '' },
	activeSessionId: 'session-one',
	createdAt: '2026-11-02T00:00:00.000Z',
	updatedAt: '2026-11-02T00:00:00.000Z'
};
const session: Session = {
	schemaVersion: 1,
	id: 'session-one',
	gameId: game.id,
	title: '새 세션',
	createdAt: game.createdAt,
	updatedAt: game.updatedAt
};
const otherSession: Session = { ...session, id: 'session-two', title: '두 번째 세션' };

function render(component: typeof Home | typeof GameWorkspace, props?: { gameId: string }) {
	return renderSvelte(AppFixture, {
		view: component === Home ? 'home' : 'game',
		gameId: props?.gameId
	});
}

function chatMessage(
	content: string,
	role: Message['role'] = 'user',
	sessionId = session.id
): Message {
	return {
		schemaVersion: 1,
		id: `message-${sessionId}-${role}`,
		gameId: game.id,
		sessionId,
		sequence: 1,
		role,
		content,
		createdAt: game.createdAt
	};
}

beforeEach(async () => {
	vi.resetAllMocks();
	localStorage.clear();
	localStorage.removeItem(SIDEBAR_WIDTH_STORAGE_KEY);
	localStorage.removeItem(SIDEBAR_COLLAPSED_STORAGE_KEY);
	await page.viewport(1200, 800);
	vi.mocked(listGames).mockResolvedValue([]);
	vi.mocked(createGame).mockResolvedValue(game);
	vi.mocked(getGameWorkspace).mockResolvedValue({ game, sessions: [session] });
	vi.mocked(createSession).mockResolvedValue(otherSession);
	vi.mocked(selectSession).mockResolvedValue();
	vi.mocked(updateGameSettings).mockImplementation(async (_id, input) => ({
		...game,
		title: input.title,
		settings: {
			description: input.description,
			firstMessage: input.firstMessage,
			authorNote: input.authorNote
		}
	}));
	vi.mocked(renameSession).mockImplementation(async (_gameId, id, title) => ({
		...(id === otherSession.id ? otherSession : session),
		title
	}));
	vi.mocked(deleteSession).mockResolvedValue({ game, sessions: [session] });
	vi.mocked(getSessionConversation).mockImplementation(async (_gameId, sessionId) => ({
		session: sessionId === otherSession.id ? otherSession : session,
		messages: []
	}));
});

async function openAddDialog() {
	await page.getByRole('button', { name: '게임 추가', exact: true }).first().click();
	await expect.element(page.getByRole('button', { name: '새 게임 만들기' })).toBeEnabled();
}
async function openSettings() {
	await page.getByRole('tab', { name: '게임', exact: true }).click();
}
const sidebar = () => page.getByRole('complementary', { name: '게임 세션' });
const resizer = () => page.getByRole('slider', { name: '사이드바 너비 조절' });
const measuredWidth = () => sidebar().element().getBoundingClientRect().width;

describe('session chat', () => {
	it('shows an authored opening before existing messages after autosave without losing the draft', async () => {
		const existing = chatMessage('이미 진행한 행동');
		const opening = chatMessage('  새로 설정한 첫 장면\n', 'assistant');
		vi.mocked(getSessionConversation)
			.mockResolvedValueOnce({ session: { ...session, messageCount: 1 }, messages: [existing] })
			.mockResolvedValue({
				session: { ...session, messageCount: 2 },
				messages: [opening, { ...existing, sequence: 2 }]
			});
		render(GameWorkspace, { gameId: game.id });
		await expect.element(page.getByRole('article', { name: '플레이어 메시지' })).toBeVisible();
		await page.getByRole('textbox', { name: '메시지', exact: true }).fill('아직 작성 중인 행동');
		await openSettings();
		await page.getByRole('textbox', { name: '첫 메시지', exact: true }).fill(opening.content);
		await expect.element(page.getByRole('article', { name: '게임 메시지' })).toBeVisible();
		expect(
			Array.from(
				page.getByRole('log').element().querySelectorAll('.message-content'),
				(element) => element.textContent
			)
		).toEqual([opening.content, existing.content]);
		await expect
			.element(page.getByRole('textbox', { name: '메시지', exact: true }))
			.toHaveValue('아직 작성 중인 행동');
		expect(getSessionConversation).toHaveBeenCalledTimes(2);
	});

	it('waits for an in-flight send before refreshing an authored opening', async () => {
		let finish!: (value: Awaited<ReturnType<typeof appendUserMessage>>) => void;
		const sent = chatMessage('전송하는 행동');
		const opening = chatMessage('첫 장면', 'assistant');
		vi.mocked(appendUserMessage).mockReturnValue(new Promise((resolve) => (finish = resolve)));
		vi.mocked(getSessionConversation)
			.mockResolvedValueOnce({ session: { ...session, messageCount: 0 }, messages: [] })
			.mockResolvedValue({
				session: { ...session, messageCount: 2 },
				messages: [opening, { ...sent, sequence: 2 }]
			});
		render(GameWorkspace, { gameId: game.id });
		await expect.element(page.getByRole('log')).toBeVisible();
		await page.getByRole('textbox', { name: '메시지', exact: true }).fill(sent.content);
		await page.getByRole('button', { name: '메시지 전송' }).click();
		await openSettings();
		await page.getByRole('textbox', { name: '첫 메시지', exact: true }).fill(opening.content);
		await expect.poll(() => vi.mocked(updateGameSettings).mock.calls.length).toBe(1);
		expect(getSessionConversation).toHaveBeenCalledTimes(1);
		finish({ session: { ...session, messageCount: 1 }, message: sent });
		await expect.element(page.getByRole('article', { name: '게임 메시지' })).toBeVisible();
		await expect
			.element(page.getByRole('textbox', { name: '메시지', exact: true }))
			.toHaveValue('');
		expect(getSessionConversation).toHaveBeenCalledTimes(2);
		await page.getByRole('tab', { name: '세션', exact: true }).click();
		await expect.element(page.getByRole('button', { name: '새 세션', exact: true })).toBeEnabled();
	});

	it('displays the saved opening as text and blocks blank submissions', async () => {
		const opening = '<img src=x onerror=alert(1)>\n*가게 문이 열렸다.*';
		vi.mocked(getSessionConversation).mockResolvedValue({
			session,
			messages: [chatMessage(opening, 'assistant')]
		});
		render(GameWorkspace, { gameId: game.id });
		await expect.element(page.getByRole('article', { name: '게임 메시지' })).toBeVisible();
		expect(page.getByRole('article').element().querySelector('.message-content')?.textContent).toBe(
			opening
		);
		expect(page.getByRole('article').element().querySelector('img')).toBeNull();
		await expect.element(page.getByRole('button', { name: '메시지 전송' })).toBeDisabled();
		await page.getByRole('textbox', { name: '메시지', exact: true }).fill(' \n ');
		await expect.element(page.getByRole('button', { name: '메시지 전송' })).toBeDisabled();
		expect(appendUserMessage).not.toHaveBeenCalled();
	});

	it('waits for a committed send before clearing input and does not invent an AI reply', async () => {
		let finish!: (value: Awaited<ReturnType<typeof appendUserMessage>>) => void;
		vi.mocked(appendUserMessage).mockReturnValue(new Promise((resolve) => (finish = resolve)));
		render(GameWorkspace, { gameId: game.id });
		const input = page.getByRole('textbox', { name: '메시지', exact: true });
		await expect.element(input).toBeVisible();
		await expect.element(page.getByRole('log')).toBeVisible();
		const content = '  망치를 든다.\n작업을 시작한다.  ';
		await input.fill(content);
		await page.getByRole('button', { name: '메시지 전송' }).click();
		await expect.element(input).toHaveValue(content);
		await expect.element(input).toHaveAttribute('readonly');
		await expect.element(page.getByRole('button', { name: '메시지 전송' })).toBeDisabled();
		await expect.element(page.getByRole('button', { name: '새 세션', exact: true })).toBeDisabled();
		expect(appendUserMessage).toHaveBeenCalledExactlyOnceWith(game.id, session.id, content);
		expect(page.getByRole('article').query()).toBeNull();
		finish({ session: { ...session, messageCount: 1 }, message: chatMessage(content) });
		await expect.element(input).toHaveValue('');
		await expect.element(page.getByRole('article', { name: '플레이어 메시지' })).toBeVisible();
		expect(page.getByRole('article').element().querySelector('.message-content')?.textContent).toBe(
			content
		);
		expect(page.getByRole('article', { name: '게임 메시지' }).query()).toBeNull();
	});

	it('keeps the exact draft after storage failure and retries it', async () => {
		const content = '  저장할 행동\n';
		vi.mocked(appendUserMessage)
			.mockRejectedValueOnce(new Error('Storage unavailable'))
			.mockResolvedValue({ session, message: chatMessage(content) });
		render(GameWorkspace, { gameId: game.id });
		await expect.element(page.getByRole('log')).toBeVisible();
		const input = page.getByRole('textbox', { name: '메시지', exact: true });
		await input.fill(content);
		await page.getByRole('button', { name: '메시지 전송' }).click();
		await expect.element(page.getByRole('alert')).toHaveTextContent('메시지를 저장하지 못했어요');
		await expect.element(input).toHaveValue(content);
		expect(page.getByRole('article').query()).toBeNull();
		await page.getByRole('button', { name: '메시지 전송' }).click();
		await expect.element(input).toHaveValue('');
		expect(appendUserMessage).toHaveBeenCalledTimes(2);
	});

	it('keeps histories and unsent drafts separate when switching sessions', async () => {
		vi.mocked(getGameWorkspace).mockResolvedValue({ game, sessions: [session, otherSession] });
		vi.mocked(getSessionConversation).mockImplementation(async (_gameId, id) => ({
			session: id === session.id ? session : otherSession,
			messages: [chatMessage(id === session.id ? '첫 세션 기록' : '둘째 세션 기록', 'user', id)]
		}));
		render(GameWorkspace, { gameId: game.id });
		const input = page.getByRole('textbox', { name: '메시지', exact: true });
		await expect.element(page.getByRole('article')).toHaveTextContent('첫 세션 기록');
		await input.fill('아직 보내지 않은 행동');
		await page.getByRole('button', { name: '두 번째 세션 열기' }).click();
		await expect.element(page.getByRole('article')).toHaveTextContent('둘째 세션 기록');
		await expect.element(input).toHaveValue('');
		await page.getByRole('button', { name: '새 세션 열기' }).click();
		await expect.element(page.getByRole('article')).toHaveTextContent('첫 세션 기록');
		await expect.element(input).toHaveValue('아직 보내지 않은 행동');
	});

	it('ignores a previous session load that finishes after switching sessions', async () => {
		let finish!: (value: SessionConversation) => void;
		vi.mocked(getGameWorkspace).mockResolvedValue({ game, sessions: [session, otherSession] });
		vi.mocked(getSessionConversation)
			.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))
			.mockResolvedValue({
				session: otherSession,
				messages: [chatMessage('둘째 세션', 'user', otherSession.id)]
			});
		render(GameWorkspace, { gameId: game.id });
		await expect.poll(() => vi.mocked(getSessionConversation).mock.calls.length).toBe(1);
		await page.getByRole('button', { name: '두 번째 세션 열기' }).click();
		await expect.element(page.getByRole('article')).toHaveTextContent('둘째 세션');
		finish({ session, messages: [chatMessage('이전 세션')] });
		await expect.element(page.getByRole('article')).toHaveTextContent('둘째 세션');
		await expect
			.element(page.getByRole('heading', { name: otherSession.title, exact: true }))
			.toBeVisible();
	});

	it('supports newline and Korean composition without accidental sends, then sends with Enter', async () => {
		vi.mocked(appendUserMessage).mockImplementation(async (_gameId, _sessionId, content) => ({
			session,
			message: chatMessage(content)
		}));
		render(GameWorkspace, { gameId: game.id });
		await expect.element(page.getByRole('log')).toBeVisible();
		const input = page.getByRole('textbox', { name: '메시지', exact: true });
		await input.fill('안녕');
		input.element().dispatchEvent(
			new KeyboardEvent('keydown', {
				key: 'Enter',
				isComposing: true,
				bubbles: true,
				cancelable: true
			})
		);
		expect(appendUserMessage).not.toHaveBeenCalled();
		await input.click();
		await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
		await expect.element(input).toHaveValue('안녕\n');
		expect(appendUserMessage).not.toHaveBeenCalled();
		await userEvent.keyboard('{Enter}');
		await expect.element(page.getByRole('article')).toHaveTextContent('안녕');
		expect(appendUserMessage).toHaveBeenCalledExactlyOnceWith(game.id, session.id, '안녕\n');
	});

	it('disables sending until a failed history load is successfully retried', async () => {
		vi.mocked(getSessionConversation)
			.mockRejectedValueOnce(new Error('Unreadable'))
			.mockResolvedValue({ session, messages: [] });
		render(GameWorkspace, { gameId: game.id });
		await expect
			.element(page.getByRole('alert'))
			.toHaveTextContent('채팅 기록을 불러오지 못했어요');
		await page.getByRole('textbox', { name: '메시지', exact: true }).fill('기다리는 행동');
		await expect.element(page.getByRole('button', { name: '메시지 전송' })).toBeDisabled();
		await page.getByRole('button', { name: '다시 불러오기', exact: true }).click();
		await expect.element(page.getByRole('button', { name: '메시지 전송' })).toBeEnabled();
		expect(appendUserMessage).not.toHaveBeenCalled();
	});
});

describe('new game creation', () => {
	it('waits for committed creation before navigating without a form or duplicate submission', async () => {
		let finish!: (saved: Game) => void;
		vi.mocked(createGame).mockReturnValue(new Promise((resolve) => (finish = resolve)));
		render(Home);
		await openAddDialog();
		await page.getByRole('button', { name: '새 게임 만들기' }).click();
		await expect.element(page.getByRole('button', { name: '새 게임 만들기' })).toBeDisabled();
		await userEvent.keyboard('{Escape}');
		await expect.element(page.getByRole('dialog')).toBeVisible();
		expect(createGame).toHaveBeenCalledExactlyOnceWith();
		expect(goto).not.toHaveBeenCalled();
		expect(page.getByRole('textbox', { name: '이름', exact: true }).query()).toBeNull();
		finish(game);
		await expect.poll(() => vi.mocked(goto).mock.calls).toEqual([['/games/game-one']]);
	});
	it('keeps the dialog on storage failure and retries', async () => {
		vi.mocked(createGame).mockRejectedValueOnce(new Error('Storage unavailable'));
		render(Home);
		await openAddDialog();
		await page.getByRole('button', { name: '새 게임 만들기' }).click();
		await expect.element(page.getByRole('alert')).toHaveTextContent('게임을 만들지 못했어요');
		expect(goto).not.toHaveBeenCalled();
		await page.getByRole('button', { name: '새 게임 만들기' }).click();
		await expect.poll(() => vi.mocked(goto).mock.calls.length).toBe(1);
	});
	it('retains a committed game after navigation failure without creating it again', async () => {
		vi.mocked(listGames).mockResolvedValue([]);
		vi.mocked(goto).mockRejectedValueOnce(new Error('Navigation failed'));
		render(Home);
		await openAddDialog();
		await page.getByRole('button', { name: '새 게임 만들기' }).click();
		await expect.element(page.getByRole('alert')).toHaveTextContent('게임은 저장되어 있으니');
		await page.getByRole('button', { name: '새 게임 · 제작 중 상세 보기' }).click();
		await expect.poll(() => vi.mocked(goto).mock.calls.length).toBe(2);
		expect(createGame).toHaveBeenCalledTimes(1);
	});
	it('blocks creation after a failed load and recovers on retry', async () => {
		vi.mocked(listGames).mockRejectedValueOnce(new Error('Storage unavailable'));
		render(Home);
		await expect.element(page.getByRole('alert')).toHaveTextContent('불러오지 못했어요');
		await page.getByRole('button', { name: '게임 추가', exact: true }).first().click();
		await expect.element(page.getByRole('button', { name: '새 게임 만들기' })).toBeDisabled();
		await page.getByRole('button', { name: '닫기' }).click();
		await page.getByRole('button', { name: '다시 불러오기' }).click();
		await openAddDialog();
		expect(listGames).toHaveBeenCalledTimes(2);
	});
	it('shows only saved games and opens the selected game', async () => {
		vi.mocked(listGames).mockResolvedValue([game]);
		render(Home);
		await expect
			.element(page.getByRole('button', { name: '새 게임 · 제작 중 상세 보기' }))
			.toBeVisible();
		await expect.element(page.getByLabelText('표시된 게임 수')).toHaveTextContent('1');
		await page.getByRole('button', { name: '새 게임 · 제작 중 상세 보기' }).click();
		expect(goto).toHaveBeenCalledExactlyOnceWith('/games/game-one');
	});
	it('shows an empty library and no sample controls when no games have been saved', async () => {
		render(Home);
		await expect.element(page.getByRole('heading', { name: '게임이 없습니다' })).toBeVisible();
		await expect.element(page.getByLabelText('표시된 게임 수')).toHaveTextContent('0');
		expect(page.getByRole('list', { name: '게임 목록' }).query()).toBeNull();
		expect(page.getByRole('button', { name: /샘플 (숨기기|보기)/ }).query()).toBeNull();
	});
});

describe('game settings', () => {
	it('autosaves long authoring text and updates the title only after commit', async () => {
		let finish!: (saved: Game) => void;
		vi.mocked(updateGameSettings).mockReturnValue(new Promise((resolve) => (finish = resolve)));
		render(GameWorkspace, { gameId: game.id });
		await openSettings();
		expect(page.getByRole('button', { name: '저장', exact: true }).query()).toBeNull();
		expect(updateGameSettings).not.toHaveBeenCalled();
		const description = '  ' + '긴 설명 '.repeat(1000) + '\n\n';
		const firstMessage = '  첫 줄\n\n둘째 줄  ';
		const authorNote = '\n  작가 노트  \n';
		await page.getByRole('textbox', { name: '이름', exact: true }).fill('내 게임 이름');
		await page.getByRole('textbox', { name: '설명', exact: true }).fill(description);
		await page.getByRole('textbox', { name: '첫 메시지', exact: true }).fill(firstMessage);
		await page.getByRole('textbox', { name: '작가 노트', exact: true }).fill(authorNote);
		await expect.poll(() => vi.mocked(updateGameSettings).mock.calls.length).toBe(1);
		await expect.element(page.getByRole('textbox', { name: '설명', exact: true })).toBeEnabled();
		await expect.element(page.getByRole('heading', { name: '새 게임' })).toBeVisible();
		expect(updateGameSettings).toHaveBeenCalledExactlyOnceWith(game.id, {
			title: '내 게임 이름',
			description,
			firstMessage,
			authorNote
		});
		finish({ ...game, title: '내 게임 이름', settings: { description, firstMessage, authorNote } });
		await expect.element(page.getByRole('heading', { name: '내 게임 이름' })).toBeVisible();
		expect(page.getByRole('button', { name: '저장', exact: true }).query()).toBeNull();
		expect(loadSettingsDraft(game.id)).toBeNull();
		await expect
			.element(page.getByRole('textbox', { name: '설명', exact: true }))
			.toHaveValue(description);
	});
	it('retains edits across the four icon categories and sidebar tabs', async () => {
		render(GameWorkspace, { gameId: game.id });
		await openSettings();
		await page.getByRole('textbox', { name: '설명', exact: true }).fill('수정한 설명');
		for (const label of ['에셋', '로어북', '고급 설정']) {
			await page.getByRole('tab', { name: label, exact: true }).click();
			await expect
				.element(page.getByRole('tab', { name: label, exact: true }))
				.toHaveAttribute('aria-selected', 'true');
		}
		await userEvent.keyboard('{Home}');
		await expect.element(page.getByRole('tab', { name: '기본 설정', exact: true })).toHaveFocus();
		await page.getByRole('tab', { name: '세션', exact: true }).click();
		await openSettings();
		await expect
			.element(page.getByRole('textbox', { name: '설명', exact: true }))
			.toHaveValue('수정한 설명');
		await expect.poll(() => vi.mocked(updateGameSettings).mock.calls.length).toBe(1);
	});
	it('preserves inputs and the previous header on save failure, then retries', async () => {
		vi.mocked(updateGameSettings).mockRejectedValueOnce(new Error('Write failed'));
		render(GameWorkspace, { gameId: game.id });
		await openSettings();
		await page.getByRole('textbox', { name: '이름', exact: true }).fill('수정한 이름');
		await page.getByRole('textbox', { name: '작가 노트', exact: true }).fill('  유지할 내용\n');
		await expect.element(page.getByRole('alert')).toHaveTextContent('설정을 저장하지 못했어요');
		await expect.element(page.getByRole('heading', { name: '새 게임' })).toBeVisible();
		await expect
			.element(page.getByRole('textbox', { name: '작가 노트', exact: true }))
			.toHaveValue('  유지할 내용\n');
		expect(loadSettingsDraft(game.id)?.authorNote).toBe('  유지할 내용\n');
		await page.getByRole('button', { name: '다시 시도', exact: true }).click();
		await expect.element(page.getByRole('heading', { name: '수정한 이름' })).toBeVisible();
	});

	it('serializes in-flight edits without replacing newer input or blocking session selection', async () => {
		let finish!: (saved: Game) => void;
		vi.mocked(updateGameSettings).mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
		vi.mocked(getGameWorkspace).mockResolvedValue({ game, sessions: [session, otherSession] });
		render(GameWorkspace, { gameId: game.id });
		await openSettings();
		const titleInput = page.getByRole('textbox', { name: '이름', exact: true });
		await titleInput.fill('첫 이름');
		await expect.poll(() => vi.mocked(updateGameSettings).mock.calls.length).toBe(1);
		await titleInput.fill('마지막 이름');
		await page.getByRole('tab', { name: '세션', exact: true }).click();
		await page.getByRole('button', { name: '두 번째 세션 열기', exact: true }).click();
		await expect
			.element(page.getByRole('heading', { name: otherSession.title, exact: true }))
			.toBeVisible();
		finish({ ...game, title: '첫 이름' });
		await expect
			.element(page.getByRole('heading', { name: '마지막 이름', exact: true }))
			.toBeVisible();
		expect(updateGameSettings).toHaveBeenCalledTimes(2);
		await expect
			.element(page.getByRole('button', { name: '두 번째 세션 열기' }))
			.toHaveAttribute('aria-current', 'true');
		await openSettings();
		await expect.element(titleInput).toHaveValue('마지막 이름');
	});

	it('recovers pending edits on mount and clears their backup after saving', async () => {
		storeSettingsDraft(game.id, {
			title: '복구한 이름',
			description: '  유지한 설명\n',
			firstMessage: '',
			authorNote: ''
		});
		render(GameWorkspace, { gameId: game.id });
		await openSettings();
		await expect
			.element(page.getByRole('textbox', { name: '이름', exact: true }))
			.toHaveValue('복구한 이름');
		await expect
			.element(page.getByRole('heading', { name: '복구한 이름', exact: true }))
			.toBeVisible();
		expect(vi.mocked(updateGameSettings).mock.calls[0]?.[1].description).toBe('  유지한 설명\n');
		expect(loadSettingsDraft(game.id)).toBeNull();
	});

	it('waits for Korean composition to finish before autosaving', async () => {
		render(GameWorkspace, { gameId: game.id });
		await openSettings();
		const input = page.getByRole('textbox', { name: '이름', exact: true });
		input.element().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
		await input.fill('한글 조합');
		await new Promise((resolve) => setTimeout(resolve, 450));
		expect(updateGameSettings).not.toHaveBeenCalled();
		input.element().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
		await expect
			.element(page.getByRole('heading', { name: '한글 조합', exact: true }))
			.toBeVisible();
	});

	it('keeps invalid names editable and resumes autosave when corrected', async () => {
		render(GameWorkspace, { gameId: game.id });
		await openSettings();
		const input = page.getByRole('textbox', { name: '이름', exact: true });
		await input.fill(' ');
		await expect.element(page.getByRole('alert')).toHaveTextContent('게임 이름을 입력해주세요');
		expect(updateGameSettings).not.toHaveBeenCalled();
		await input.fill('수정한 이름');
		await expect
			.element(page.getByRole('heading', { name: '수정한 이름', exact: true }))
			.toBeVisible();
	});
});

describe('sessions', () => {
	it('creates a new active session', async () => {
		render(GameWorkspace, { gameId: game.id });
		await expect
			.element(page.getByRole('button', { name: '새 세션 열기' }))
			.toHaveAttribute('aria-current', 'true');
		await page.getByRole('button', { name: '새 세션', exact: true }).click();
		await expect.element(page.getByRole('heading', { name: otherSession.title })).toBeVisible();
		expect(createSession).toHaveBeenCalledExactlyOnceWith(game.id);
	});
	it('retains selection on a failed switch and retries', async () => {
		vi.mocked(getGameWorkspace).mockResolvedValue({ game, sessions: [session, otherSession] });
		vi.mocked(selectSession).mockRejectedValueOnce(new Error('Write failed'));
		render(GameWorkspace, { gameId: game.id });
		await page.getByRole('button', { name: otherSession.title + ' 열기' }).click();
		await expect.element(page.getByRole('alert')).toHaveTextContent('세션을 전환하지 못했어요');
		await expect
			.element(page.getByRole('heading', { name: session.title, exact: true }))
			.toBeVisible();
		await page.getByRole('button', { name: otherSession.title + ' 열기' }).click();
		await expect.element(page.getByRole('heading', { name: otherSession.title })).toBeVisible();
	});
	it('keeps existing sessions after a failed creation', async () => {
		vi.mocked(createSession).mockRejectedValueOnce(new Error('Write failed'));
		render(GameWorkspace, { gameId: game.id });
		await page.getByRole('button', { name: '새 세션', exact: true }).click();
		await expect.element(page.getByRole('alert')).toHaveTextContent('새 세션을 저장하지 못했어요');
		await expect
			.element(page.getByRole('button', { name: '새 세션 열기' }))
			.toHaveAttribute('aria-current', 'true');
	});
	it('supports sidebar tab keyboard navigation', async () => {
		render(GameWorkspace, { gameId: game.id });
		await openSettings();
		expect(page.getByRole('navigation', { name: '세션 목록' }).query()).toBeNull();
		await userEvent.keyboard('{ArrowLeft}');
		await expect.element(page.getByRole('tab', { name: '세션', exact: true })).toHaveFocus();
		await expect.element(page.getByRole('navigation', { name: '세션 목록' })).toBeVisible();
	});
	it('retries failed workspace loading and handles a missing game', async () => {
		vi.mocked(getGameWorkspace)
			.mockRejectedValueOnce(new Error('Read failed'))
			.mockResolvedValueOnce(null);
		render(GameWorkspace, { gameId: 'missing' });
		await expect.element(page.getByRole('alert')).toHaveTextContent('게임을 불러오지 못했어요');
		await page.getByRole('button', { name: '다시 불러오기' }).click();
		await expect
			.element(page.getByRole('heading', { name: '게임을 찾을 수 없어요' }))
			.toBeVisible();
	});
	it('renames inline and updates the active session heading after commit', async () => {
		render(GameWorkspace, { gameId: game.id });
		await page.getByRole('button', { name: '새 세션 이름 수정' }).click();
		await expect.element(page.getByRole('textbox', { name: '세션 이름' })).toHaveFocus();
		await page.getByRole('textbox', { name: '세션 이름' }).fill('  첫 번째 모험  ');
		await userEvent.keyboard('{Enter}');
		await expect.element(page.getByRole('heading', { name: '첫 번째 모험' })).toBeVisible();
		expect(renameSession).toHaveBeenCalledExactlyOnceWith(game.id, session.id, '첫 번째 모험');
	});
	it('rejects blank names, preserves failed edits, and supports cancelling', async () => {
		vi.mocked(renameSession).mockRejectedValueOnce(new Error('Write failed'));
		render(GameWorkspace, { gameId: game.id });
		await page.getByRole('button', { name: '새 세션 이름 수정' }).click();
		await page.getByRole('textbox', { name: '세션 이름' }).fill(' ');
		await userEvent.keyboard('{Enter}');
		await expect.element(page.getByRole('alert')).toHaveTextContent('세션 이름을 입력해주세요');
		expect(renameSession).not.toHaveBeenCalled();
		await page.getByRole('textbox', { name: '세션 이름' }).fill('유지할 이름');
		await userEvent.keyboard('{Enter}');
		await expect
			.element(page.getByRole('alert'))
			.toHaveTextContent('세션 이름을 저장하지 못했어요');
		await expect
			.element(page.getByRole('textbox', { name: '세션 이름' }))
			.toHaveValue('유지할 이름');
		await userEvent.keyboard('{Escape}');
		await expect.element(page.getByRole('button', { name: '새 세션 열기' })).toBeVisible();
	});
	it('requires confirmation before deleting and can cancel', async () => {
		render(GameWorkspace, { gameId: game.id });
		await page.getByRole('button', { name: '새 세션 삭제' }).click();
		await expect.element(page.getByRole('dialog', { name: '세션 삭제' })).toBeVisible();
		expect(deleteSession).not.toHaveBeenCalled();
		await page.getByRole('button', { name: '취소', exact: true }).click();
		expect(deleteSession).not.toHaveBeenCalled();
		await expect.element(page.getByRole('button', { name: '새 세션 열기' })).toBeVisible();
	});
	it('deletes the active session and displays the replacement selection', async () => {
		vi.mocked(getGameWorkspace).mockResolvedValue({
			game: { ...game, activeSessionId: otherSession.id },
			sessions: [session, otherSession]
		});
		render(GameWorkspace, { gameId: game.id });
		await page.getByRole('button', { name: otherSession.title + ' 삭제' }).click();
		await page.getByRole('dialog').getByRole('button', { name: '삭제', exact: true }).click();
		await expect.element(page.getByRole('heading', { name: '새 세션', exact: true })).toBeVisible();
		expect(page.getByRole('button', { name: otherSession.title + ' 열기' }).query()).toBeNull();
		expect(deleteSession).toHaveBeenCalledExactlyOnceWith(game.id, otherSession.id);
	});
	it('preserves sessions when deletion fails and can retry', async () => {
		vi.mocked(deleteSession).mockRejectedValueOnce(new Error('Write failed'));
		render(GameWorkspace, { gameId: game.id });
		await page.getByRole('button', { name: '새 세션 삭제' }).click();
		await page.getByRole('dialog').getByRole('button', { name: '삭제', exact: true }).click();
		await expect.element(page.getByRole('alert')).toHaveTextContent('세션을 삭제하지 못했어요');
		await page.getByRole('dialog').getByRole('button', { name: '삭제', exact: true }).click();
		await expect.poll(() => vi.mocked(deleteSession).mock.calls.length).toBe(2);
		await expect.element(page.getByRole('button', { name: '새 세션 열기' })).toBeVisible();
	});
});

describe('sidebar layout', () => {
	it('keeps the far-left rail while collapsing, preserves drafts, and restores saved width', async () => {
		localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, '430');
		render(GameWorkspace, { gameId: game.id });
		await expect.poll(measuredWidth).toBe(430);
		await openSettings();
		expect(measuredWidth()).toBe(430);
		await page.getByRole('textbox', { name: '설명', exact: true }).fill('접어도 유지할 내용');
		await page.getByRole('button', { name: '사이드바 접기' }).click();
		expect(sidebar().query()).toBeNull();
		expect(resizer().query()).toBeNull();
		await expect
			.element(page.getByRole('complementary', { name: '사이드바', exact: true }))
			.toBeVisible();
		await expect.element(page.getByRole('button', { name: '사이드바 펼치기' })).toHaveFocus();
		expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe('430');
		expect(localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe('true');
		await userEvent.keyboard('{Enter}');
		await expect.poll(measuredWidth).toBe(430);
		await expect
			.element(page.getByRole('textbox', { name: '설명', exact: true }))
			.toHaveValue('접어도 유지할 내용');
	});
	it('restores collapsed state after remount', async () => {
		localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, '470');
		const rendered = render(GameWorkspace, { gameId: game.id });
		await page.getByRole('button', { name: '사이드바 접기' }).click();
		await rendered.unmount();
		render(GameWorkspace, { gameId: game.id });
		await page.getByRole('button', { name: '사이드바 펼치기' }).click();
		await expect.poll(measuredWidth).toBe(470);
	});
	it('keeps keyboard resizing and the width consistent across tabs and remounts', async () => {
		localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, '390');
		const rendered = render(GameWorkspace, { gameId: game.id });
		await expect.poll(measuredWidth).toBe(390);
		await openSettings();
		expect(measuredWidth()).toBe(390);
		resizer().element().focus();
		await userEvent.keyboard('{ArrowRight}');
		await expect.poll(measuredWidth).toBe(400);
		expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe('400');
		await page.getByRole('tab', { name: '세션', exact: true }).click();
		expect(measuredWidth()).toBe(400);
		await rendered.unmount();
		render(GameWorkspace, { gameId: game.id });
		await expect.poll(measuredWidth).toBe(400);
	});
	it('clamps display width without changing the preference and keeps the mobile toggle reachable', async () => {
		localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, '720');
		render(GameWorkspace, { gameId: game.id });
		await expect.poll(measuredWidth).toBe(720);
		await page.viewport(700, 800);
		await expect.poll(measuredWidth).toBeLessThan(720);
		expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe('720');
		await page.viewport(390, 844);
		await openSettings();
		const mobileWidth = measuredWidth();
		await page.getByRole('tab', { name: '세션', exact: true }).click();
		expect(measuredWidth()).toBe(mobileWidth);
		await page.getByRole('button', { name: '사이드바 접기' }).click();
		await expect.element(page.getByRole('button', { name: '사이드바 펼치기' })).toBeVisible();
		await expect
			.element(page.getByRole('complementary', { name: '사이드바', exact: true }))
			.toBeVisible();
		await page.getByRole('button', { name: '사이드바 펼치기' }).click();
		await page.viewport(1200, 800);
		await expect.poll(measuredWidth).toBe(720);
		expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe('720');
	});
	it('supports keyboard bounds', async () => {
		render(GameWorkspace, { gameId: game.id });
		await expect.element(resizer()).toBeVisible();
		resizer().element().focus();
		await userEvent.keyboard('{Home}');
		await expect.element(resizer()).toHaveAttribute('aria-valuenow', '220');
		await userEvent.keyboard('{ArrowLeft}');
		expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe('220');
		await userEvent.keyboard('{End}');
		const max = resizer().element().getAttribute('aria-valuemax');
		expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe(max);
	});
	it('captures pointer drags and restores selection after release, cancel, and unmount', async () => {
		const rendered = render(GameWorkspace, { gameId: game.id });
		await expect.element(resizer()).toBeVisible();
		const element = resizer().element();
		const capture = vi.spyOn(element, 'setPointerCapture').mockImplementation(() => {});
		const priorSelect = document.body.style.userSelect;
		const priorCursor = document.body.style.cursor;
		element.dispatchEvent(
			new PointerEvent('pointerdown', { bubbles: true, pointerId: 7, isPrimary: true, button: 2 })
		);
		expect(capture).not.toHaveBeenCalled();
		element.dispatchEvent(
			new PointerEvent('pointerdown', {
				bubbles: true,
				pointerId: 7,
				isPrimary: true,
				button: 0,
				clientX: 320
			})
		);
		element.dispatchEvent(
			new PointerEvent('pointermove', { bubbles: true, pointerId: 7, clientX: 380 })
		);
		await expect.element(resizer()).toHaveAttribute('aria-valuenow', '380');
		expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBeNull();
		element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7 }));
		expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe('380');
		expect(document.body.style.userSelect).toBe(priorSelect);
		element.dispatchEvent(
			new PointerEvent('pointerdown', { bubbles: true, pointerId: 8, isPrimary: true, button: 0 })
		);
		element.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 8 }));
		expect(document.body.style.cursor).toBe(priorCursor);
		element.dispatchEvent(
			new PointerEvent('pointerdown', { bubbles: true, pointerId: 9, isPrimary: true, button: 0 })
		);
		await rendered.unmount();
		expect(document.body.style.userSelect).toBe(priorSelect);
		expect(document.body.style.cursor).toBe(priorCursor);
		capture.mockRestore();
	});
});
