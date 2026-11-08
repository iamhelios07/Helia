import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { createSubscriber } from 'svelte/reactivity';

import {
	DEFAULT_SIDEBAR_WIDTH,
	MIN_SIDEBAR_WIDTH,
	loadSidebarWidth,
	saveSidebarWidth,
	loadSidebarCollapsed,
	saveSidebarCollapsed
} from '#lib/app/preferences/sidebar.js';
import { configureAppSidebar } from '#lib/app/sidebar.svelte.js';
import { isSessionBusy, subscribeSessionActivity } from '#lib/games/ai/activity.js';
import { toLibraryGame, type LibraryGame } from '#lib/library/library-games.js';

import { validateSessionTitle, type Game, type Session, type GameMetadata } from '../model.js';
import {
	getGameWorkspace,
	createSession,
	selectSession,
	updateGame,
	renameSession,
	deleteSession,
	listGames,
	createGame
} from '../repository.js';

interface GameWorkspaceControllerOptions {
	gameId: string;
}

export class GameWorkspaceController {
	constructor(private readonly options: () => GameWorkspaceControllerOptions) {
		configureAppSidebar(() => ({
			games: this.railGames.length ? this.railGames : undefined,
			activeGameId: this.gameId,
			busy: this.busy || this.creatingGame,
			onhome: () => {
				void goto(resolve('/'));
			},
			onadd: () => {
				void this.addGameFromRail();
			},
			onselect: (selected) => {
				void this.navigateToGame(selected.id);
			}
		}));
	}
	get gameId() {
		return this.options().gameId;
	}
	game = $state.raw<Game | null>(null);
	sessions = $state.raw<Session[]>([]);
	loading = $state(true);
	loadError = $state('');
	missing = $state(false);
	sessionBusy = $state(false);
	chatSaving = $state(false);
	uiSaving = $state(false);
	chatDrafts = $state<Record<string, string>>({});
	sessionActivity = $derived.by(() => {
		const sessionId = this.game?.activeSessionId;
		const currentGameId = this.gameId;
		const subscribe = createSubscriber((update) =>
			sessionId ? subscribeSessionActivity(currentGameId, sessionId, update) : undefined
		);
		return () => {
			subscribe();
			return sessionId ? isSessionBusy(currentGameId, sessionId) : false;
		};
	});
	busy = $derived(this.sessionBusy || this.chatSaving || this.uiSaving || this.sessionActivity());
	actionError = $state('');
	renamingSessionId = $state<string | null>(null);
	sessionName = $state('');
	renameError = $state('');
	deletingSession = $state<Session | null>(null);
	deleteError = $state('');
	railGames = $state.raw<LibraryGame[]>([]);
	creatingGame = $state(false);
	selectedTab = $state<'sessions' | 'game'>('sessions');
	activeSession = $derived(
		this.sessions.find((session) => session.id === this.game?.activeSessionId)
	);
	preferredWidth = $state(DEFAULT_SIDEBAR_WIDTH);
	sidebarCollapsed = $state(false);
	layoutWidth = $state(0);
	resizing = $state(false);
	maxSidebarWidth = $derived(
		Math.max(MIN_SIDEBAR_WIDTH, (this.layoutWidth || DEFAULT_SIDEBAR_WIDTH + 280) - 280)
	);
	displayedWidth = $derived(
		Math.min(this.maxSidebarWidth, Math.max(MIN_SIDEBAR_WIDTH, this.preferredWidth))
	);
	drag: {
		pointerId: number;
		target: HTMLElement;
		startX: number;
		startWidth: number;
		previousUserSelect: string;
		previousCursor: string;
	} | null = null;
	clampWidth = (width: number) => {
		return Math.round(Math.max(MIN_SIDEBAR_WIDTH, Math.min(this.maxSidebarWidth, width)));
	};
	toggleSidebar = () => {
		this.finishResize();
		this.sidebarCollapsed = !this.sidebarCollapsed;
		saveSidebarCollapsed(this.sidebarCollapsed);
	};
	startResize = (event: PointerEvent) => {
		if (!event.isPrimary || event.button !== 0 || this.drag) {
			return;
		}
		event.preventDefault();
		const target = event.currentTarget as HTMLElement;
		target.setPointerCapture(event.pointerId);
		this.drag = {
			pointerId: event.pointerId,
			target,
			startX: event.clientX,
			startWidth: this.displayedWidth,
			previousUserSelect: document.body.style.userSelect,
			previousCursor: document.body.style.cursor
		};
		document.body.style.userSelect = 'none';
		document.body.style.cursor = 'col-resize';
		this.resizing = true;
	};
	resize = (event: PointerEvent) => {
		if (!this.drag || event.pointerId !== this.drag.pointerId) {
			return;
		}
		this.preferredWidth = this.clampWidth(this.drag.startWidth + event.clientX - this.drag.startX);
	};
	finishResize = (event?: PointerEvent) => {
		if (!this.drag || (event && event.pointerId !== this.drag.pointerId)) {
			return;
		}
		const previous = this.drag;
		this.drag = null;
		this.resizing = false;
		document.body.style.userSelect = previous.previousUserSelect;
		document.body.style.cursor = previous.previousCursor;
		if (previous.target.hasPointerCapture(previous.pointerId)) {
			previous.target.releasePointerCapture(previous.pointerId);
		}
		saveSidebarWidth(this.preferredWidth);
	};
	resizeWithKeyboard = (event: KeyboardEvent) => {
		if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
			return;
		}
		event.preventDefault();
		const step = event.shiftKey ? 50 : 10;
		if (event.key === 'Home') {
			this.preferredWidth = MIN_SIDEBAR_WIDTH;
		} else if (event.key === 'End') {
			this.preferredWidth = this.maxSidebarWidth;
		} else {
			this.preferredWidth = this.clampWidth(
				this.displayedWidth + (event.key === 'ArrowRight' ? step : -step)
			);
		}
		saveSidebarWidth(this.preferredWidth);
	};
	loadWorkspace = async () => {
		this.loading = true;
		this.loadError = '';
		this.missing = false;
		try {
			const workspace = await getGameWorkspace(this.gameId);
			if (!workspace) {
				this.missing = true;
				return;
			}
			this.game = workspace.game;
			this.sessions = workspace.sessions;
			this.railGames = [toLibraryGame(this.game)];
			void this.loadRailGames();
		} catch {
			this.loadError = '게임을 불러오지 못했어요. 다시 시도해주세요.';
		} finally {
			this.loading = false;
		}
	};
	loadRailGames = async () => {
		try {
			this.railGames = (await listGames()).map(toLibraryGame);
		} catch {
			// Keep the current game's shortcut available if the library cannot be read.
		}
	};
	navigateToGame = async (id: string) => {
		if (this.busy || this.creatingGame) {
			return;
		}
		try {
			await goto(resolve('/games/[id]', { id }));
		} catch {
			this.actionError = '게임 화면을 열지 못했어요. 다시 시도해주세요.';
		}
	};
	addGameFromRail = async () => {
		if (this.busy || this.creatingGame) {
			return;
		}
		this.creatingGame = true;
		let created: Game | null = null;
		try {
			created = await createGame();
			this.railGames = [toLibraryGame(created), ...this.railGames];
			await goto(resolve('/games/[id]', { id: created.id }));
		} catch {
			this.actionError = created
				? '게임은 저장되었지만 화면을 열지 못했어요. 왼쪽 목록에서 다시 열어주세요.'
				: '게임을 추가하지 못했어요. 다시 시도해주세요.';
		} finally {
			this.creatingGame = false;
		}
	};
	addSession = async () => {
		if (!this.game || this.busy) {
			return;
		}
		this.sessionBusy = true;
		this.actionError = '';
		try {
			const session = await createSession(this.game.id);
			this.sessions = [session, ...this.sessions];
			this.game = { ...this.game, activeSessionId: session.id, updatedAt: session.updatedAt };
		} catch {
			this.actionError = '새 세션을 저장하지 못했어요. 다시 시도해주세요.';
		} finally {
			this.sessionBusy = false;
		}
	};
	changeSession = async (sessionId: string) => {
		if (!this.game || this.busy || sessionId === this.game.activeSessionId) {
			return;
		}
		this.sessionBusy = true;
		this.actionError = '';
		try {
			await selectSession(this.game.id, sessionId);
			this.game = { ...this.game, activeSessionId: sessionId };
		} catch {
			this.actionError = '세션을 전환하지 못했어요. 다시 시도해주세요.';
		} finally {
			this.sessionBusy = false;
		}
	};
	startRename = (session: Session) => {
		this.renamingSessionId = session.id;
		this.sessionName = session.title;
		this.renameError = '';
	};
	focusSessionName = (input: HTMLInputElement) => {
		input.focus();
		input.select();
	};
	saveSessionName = async (event: SubmitEvent) => {
		event.preventDefault();
		if (!this.game || !this.renamingSessionId || this.busy) {
			return;
		}
		this.renameError = '';
		let title: string;
		try {
			title = validateSessionTitle(this.sessionName);
		} catch (error) {
			this.renameError = error instanceof Error ? error.message : '세션 이름을 확인해주세요.';
			return;
		}
		this.sessionBusy = true;
		try {
			const updated = await renameSession(this.game.id, this.renamingSessionId, title);
			this.sessions = this.sessions.map((session) =>
				session.id === updated.id ? updated : session
			);
			this.renamingSessionId = null;
		} catch {
			this.renameError = '세션 이름을 저장하지 못했어요. 다시 시도해주세요.';
		} finally {
			this.sessionBusy = false;
		}
	};
	requestDelete = (session: Session) => {
		this.renamingSessionId = null;
		this.renameError = '';
		this.deleteError = '';
		this.deletingSession = session;
	};
	openDeleteDialog = (dialog: HTMLDialogElement) => {
		dialog.showModal();
		return () => dialog.close();
	};
	confirmDelete = async () => {
		if (!this.game || !this.deletingSession || this.busy) {
			return;
		}
		const deletingSessionId = this.deletingSession.id;
		this.sessionBusy = true;
		this.deleteError = '';
		try {
			const workspace = await deleteSession(this.game.id, this.deletingSession.id);
			this.game = workspace.game;
			this.sessions = workspace.sessions;
			this.deletingSession = null;
			delete this.chatDrafts[deletingSessionId];
		} catch {
			this.deleteError = '세션을 삭제하지 못했어요. 다시 시도해주세요.';
		} finally {
			this.sessionBusy = false;
		}
	};
	saveSettings = async (input: GameMetadata): Promise<Game> => {
		if (!this.game) {
			throw new Error('Game is unavailable');
		}
		const updated = await updateGame(this.game.id, input);
		this.game = {
			...this.game,
			title: updated.title,
			genre: updated.genre,
			description: updated.description,
			updatedAt: updated.updatedAt > this.game.updatedAt ? updated.updatedAt : this.game.updatedAt
		};
		const current = toLibraryGame(this.game);
		this.railGames = this.railGames.map((item) => (item.id === updated.id ? current : item));
		return updated;
	};
	moveTab = (event: KeyboardEvent) => {
		if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
			return;
		}
		event.preventDefault();
		if (event.key === 'Home') {
			this.selectedTab = 'sessions';
		} else if (event.key === 'End') {
			this.selectedTab = 'game';
		} else {
			this.selectedTab = this.selectedTab === 'sessions' ? 'game' : 'sessions';
		}
		(event.currentTarget as HTMLElement).parentElement
			?.querySelector<HTMLButtonElement>(`[data-tab="${this.selectedTab}"]`)
			?.focus();
	};
	mount = () => {
		this.preferredWidth = loadSidebarWidth();
		this.sidebarCollapsed = loadSidebarCollapsed();
		void this.loadWorkspace();
		return () => this.finishResize();
	};
}
