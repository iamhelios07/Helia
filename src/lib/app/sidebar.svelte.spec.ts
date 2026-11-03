import '../../app.css';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { goto } from '$app/navigation';
import AppFixture from '../testing/AppFixture.svelte';
import { AppSidebarController, type AppSidebarOptions } from './sidebar.svelte.js';
import {
	listGames,
	getGameWorkspace,
	getSessionConversation,
	createGame,
	updateGameSettings
} from '#lib/games/repository.js';
import type { Game, Session } from '#lib/games/model.js';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('#lib/games/repository.js', () => ({
	listGames: vi.fn(),
	createGame: vi.fn(),
	getGameWorkspace: vi.fn(),
	getSessionConversation: vi.fn(),
	createSession: vi.fn(),
	selectSession: vi.fn(),
	updateGameSettings: vi.fn(),
	renameSession: vi.fn(),
	deleteSession: vi.fn(),
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
	title: '게임 하나',
	genre: '',
	description: '',
	settings: { description: '', firstMessage: '', authorNote: '' },
	activeSessionId: 'session-one',
	createdAt: '2026-11-02T00:00:00.000Z',
	updatedAt: '2026-11-02T00:00:00.000Z'
};
const session: Session = {
	schemaVersion: 1,
	id: game.activeSessionId,
	gameId: game.id,
	title: '새 세션',
	createdAt: game.createdAt,
	updatedAt: game.updatedAt
};

beforeEach(async () => {
	vi.resetAllMocks();
	localStorage.clear();
	await page.viewport(1200, 800);
	vi.mocked(listGames).mockResolvedValue([game]);
	vi.mocked(getGameWorkspace).mockResolvedValue({ game, sessions: [session] });
	vi.mocked(getSessionConversation).mockResolvedValue({ session, messages: [] });
	vi.mocked(createGame).mockResolvedValue({ ...game, id: 'created-game' });
	vi.mocked(updateGameSettings).mockImplementation(async (_id, input) => ({
		...game,
		title: input.title,
		settings: {
			description: input.description,
			firstMessage: input.firstMessage,
			authorNote: input.authorNote
		}
	}));
});

const rail = () => page.getByRole('complementary', { name: '사이드바', exact: true });
const contentLeft = () => document.querySelector('.app-content')!.getBoundingClientRect().left;

describe('persistent application sidebar', () => {
	it('retains the same menu and game shortcut nodes across home/game navigation', async () => {
		const screen = render(AppFixture, { view: 'home' });
		await expect
			.element(page.getByRole('button', { name: `${game.title} 상세 보기`, exact: true }))
			.toBeVisible();
		const menu = rail().element();
		const shortcut = page
			.getByRole('button', { name: `${game.title} 상세 보기`, exact: true })
			.element();
		expect(contentLeft()).toBe(72);
		await screen.rerender({ view: 'game', gameId: game.id });
		await expect
			.element(page.getByRole('heading', { name: game.title, exact: true }))
			.toBeVisible();
		expect(rail().element()).toBe(menu);
		expect(
			page.getByRole('button', { name: `${game.title} 상세 보기`, exact: true }).element()
		).toBe(shortcut);
		await expect
			.element(page.getByRole('button', { name: `${game.title} 상세 보기`, exact: true }))
			.toHaveAttribute('aria-current', 'page');
		expect(document.querySelectorAll('aside[aria-label="사이드바"]').length).toBe(1);
		await page.getByRole('button', { name: '내 게임', exact: true }).click();
		expect(goto).toHaveBeenCalledExactlyOnceWith('/');
		await screen.rerender({ view: 'home' });
		expect(rail().element()).toBe(menu);
		await page.getByRole('button', { name: '게임 추가', exact: true }).first().click();
		await expect
			.element(page.getByRole('dialog', { name: '게임 추가', exact: true }))
			.toBeVisible();
	});

	it('hides and restores the existing rail together with its space, including nested requests', async () => {
		render(AppFixture, { view: 'sidebar' });
		const menu = rail().element();
		expect(contentLeft()).toBe(72);
		await page.getByRole('button', { name: '첫 숨김', exact: true }).click();
		expect(rail().query()).toBeNull();
		expect(document.contains(menu)).toBe(true);
		expect(contentLeft()).toBe(0);
		await page.getByRole('button', { name: '두 번째 숨김', exact: true }).click();
		await page.getByRole('button', { name: '첫 복원', exact: true }).click();
		expect(rail().query()).toBeNull();
		await page.getByRole('button', { name: '두 번째 복원', exact: true }).click();
		expect(rail().element()).toBe(menu);
		expect(contentLeft()).toBe(72);
	});

	it('automatically restores a page hide on navigation and uses the mobile width', async () => {
		await page.viewport(390, 844);
		const screen = render(AppFixture, { view: 'sidebar' });
		expect(contentLeft()).toBe(60);
		await page.getByRole('button', { name: '첫 숨김', exact: true }).click();
		expect(contentLeft()).toBe(0);
		await screen.rerender({ view: 'game', gameId: game.id });
		await expect.element(rail()).toBeVisible();
		expect(contentLeft()).toBe(60);
		expect(rail().element().getBoundingClientRect().height).toBe(844);
	});

	it('updates shortcuts after autosave and keeps the game-screen add action working', async () => {
		render(AppFixture, { view: 'game', gameId: game.id });
		await page.getByRole('tab', { name: '게임', exact: true }).click();
		await page.getByRole('textbox', { name: '이름', exact: true }).fill('바꾼 이름');
		await expect
			.element(page.getByRole('button', { name: '바꾼 이름 상세 보기', exact: true }))
			.toBeVisible();
		await page.getByRole('button', { name: '게임 추가', exact: true }).click();
		await expect.poll(() => vi.mocked(goto).mock.calls).toEqual([['/games/created-game']]);
	});

	it('isolates controller instances and ignores cleanup from an older page', () => {
		const first = new AppSidebarController();
		const second = new AppSidebarController();
		const options: AppSidebarOptions = {
			games: [],
			activeGameId: null,
			busy: false,
			onhome() {},
			onadd() {},
			onselect() {}
		};
		const releaseOld = first.configure(() => options);
		const latest = { ...options, activeGameId: game.id };
		const releaseNew = first.configure(() => latest);
		releaseOld();
		expect(first.options).toBe(latest);
		const restore = first.hide();
		expect(first.visible).toBe(false);
		expect(second.visible).toBe(true);
		restore();
		restore();
		releaseNew();
		expect(first.visible).toBe(true);
		expect(first.options).toBeNull();
	});
});
