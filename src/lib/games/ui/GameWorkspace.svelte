<script lang="ts">
	import { onMount } from 'svelte';
	import { createSubscriber } from 'svelte/reactivity';
	import { isSessionBusy, subscribeSessionActivity } from '#lib/games/ai/activity.js';
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import Icon from '#lib/components/Icon.svelte';
	import { configureAppSidebar } from '#lib/app/sidebar.svelte.js';
	import { toLibraryGame, type LibraryGame } from '#lib/library/library-games.js';
	import GameSettingsPanel from './GameSettingsPanel.svelte';
	import SessionChat from './SessionChat.svelte';
	import GameWorkbench from './GameWorkbench.svelte';
	import type { GameUI } from './runtime/model.js';
	import {
		getGameWorkspace,
		createSession,
		selectSession,
		updateGameSettings,
		renameSession,
		deleteSession,
		listGames,
		createGame
	} from '../repository.js';
	import {
		SESSION_TITLE_MAX_LENGTH,
		validateSessionTitle,
		type Game,
		type Session,
		type UpdateGameSettings
	} from '../model.js';
	import {
		DEFAULT_SIDEBAR_WIDTH,
		MIN_SIDEBAR_WIDTH,
		loadSidebarWidth,
		saveSidebarWidth,
		loadSidebarCollapsed,
		saveSidebarCollapsed
	} from '#lib/app/preferences/sidebar.js';

	let { gameId }: { gameId: string } = $props();
	let game = $state.raw<Game | null>(null);
	let sessions = $state.raw<Session[]>([]);
	let loading = $state(true);
	let loadError = $state('');
	let missing = $state(false);
	let sessionBusy = $state(false);
	let chatSaving = $state(false);
	let uiSaving = $state(false);
	let chatDrafts = $state<Record<string, string>>({});
	let conversationRevision = $state(0);
	let refreshOpeningAfterSend = false;
	let sessionActivity = $derived.by(() => {
		const sessionId = game?.activeSessionId;
		const currentGameId = gameId;
		const subscribe = createSubscriber((update) =>
			sessionId ? subscribeSessionActivity(currentGameId, sessionId, update) : undefined
		);
		return () => {
			subscribe();
			return sessionId ? isSessionBusy(currentGameId, sessionId) : false;
		};
	});
	let busy = $derived(sessionBusy || chatSaving || uiSaving || sessionActivity());
	let actionError = $state('');
	let renamingSessionId = $state<string | null>(null);
	let sessionName = $state('');
	let renameError = $state('');
	let deletingSession = $state<Session | null>(null);
	let deleteError = $state('');
	let railGames = $state.raw<LibraryGame[]>([]);
	let creatingGame = $state(false);
	let selectedTab = $state<'sessions' | 'game'>('sessions');
	let activeSession = $derived(sessions.find((session) => session.id === game?.activeSessionId));
	let preferredWidth = $state(DEFAULT_SIDEBAR_WIDTH);
	let sidebarCollapsed = $state(false);
	let layoutWidth = $state(0);
	let resizing = $state(false);
	let maxSidebarWidth = $derived(
		Math.max(MIN_SIDEBAR_WIDTH, (layoutWidth || DEFAULT_SIDEBAR_WIDTH + 280) - 280)
	);
	let displayedWidth = $derived(
		Math.min(maxSidebarWidth, Math.max(MIN_SIDEBAR_WIDTH, preferredWidth))
	);
	let drag: {
		pointerId: number;
		target: HTMLElement;
		startX: number;
		startWidth: number;
		previousUserSelect: string;
		previousCursor: string;
	} | null = null;
	configureAppSidebar(() => ({
		games: railGames.length ? railGames : undefined,
		activeGameId: gameId,
		busy: busy || creatingGame,
		onhome: () => {
			void goto(resolve('/'));
		},
		onadd: () => {
			void addGameFromRail();
		},
		onselect: (selected) => {
			void navigateToGame(selected.id);
		}
	}));

	onMount(() => {
		preferredWidth = loadSidebarWidth();
		sidebarCollapsed = loadSidebarCollapsed();
		void loadWorkspace();
		return () => finishResize();
	});

	function clampWidth(width: number) {
		return Math.round(Math.max(MIN_SIDEBAR_WIDTH, Math.min(maxSidebarWidth, width)));
	}

	function toggleSidebar() {
		finishResize();
		sidebarCollapsed = !sidebarCollapsed;
		saveSidebarCollapsed(sidebarCollapsed);
	}

	function startResize(event: PointerEvent) {
		if (!event.isPrimary || event.button !== 0 || drag) return;
		event.preventDefault();
		const target = event.currentTarget as HTMLElement;
		target.setPointerCapture(event.pointerId);
		drag = {
			pointerId: event.pointerId,
			target,
			startX: event.clientX,
			startWidth: displayedWidth,
			previousUserSelect: document.body.style.userSelect,
			previousCursor: document.body.style.cursor
		};
		document.body.style.userSelect = 'none';
		document.body.style.cursor = 'col-resize';
		resizing = true;
	}

	function resize(event: PointerEvent) {
		if (!drag || event.pointerId !== drag.pointerId) return;
		preferredWidth = clampWidth(drag.startWidth + event.clientX - drag.startX);
	}

	function finishResize(event?: PointerEvent) {
		if (!drag || (event && event.pointerId !== drag.pointerId)) return;
		const previous = drag;
		drag = null;
		resizing = false;
		document.body.style.userSelect = previous.previousUserSelect;
		document.body.style.cursor = previous.previousCursor;
		if (previous.target.hasPointerCapture(previous.pointerId))
			previous.target.releasePointerCapture(previous.pointerId);
		saveSidebarWidth(preferredWidth);
	}

	function resizeWithKeyboard(event: KeyboardEvent) {
		if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
		event.preventDefault();
		const step = event.shiftKey ? 50 : 10;
		preferredWidth =
			event.key === 'Home'
				? MIN_SIDEBAR_WIDTH
				: event.key === 'End'
					? maxSidebarWidth
					: clampWidth(displayedWidth + (event.key === 'ArrowRight' ? step : -step));
		saveSidebarWidth(preferredWidth);
	}

	async function loadWorkspace() {
		loading = true;
		loadError = '';
		missing = false;
		try {
			const workspace = await getGameWorkspace(gameId);
			if (!workspace) {
				missing = true;
				return;
			}
			game = workspace.game;
			sessions = workspace.sessions;
			railGames = [toLibraryGame(game)];
			void loadRailGames();
		} catch {
			loadError = '게임을 불러오지 못했어요. 다시 시도해주세요.';
		} finally {
			loading = false;
		}
	}

	async function loadRailGames() {
		try {
			railGames = (await listGames()).map(toLibraryGame);
		} catch {
			// Keep the current game's shortcut available if the library cannot be read.
		}
	}

	async function navigateToGame(id: string) {
		if (busy || creatingGame) return;
		try {
			await goto(resolve('/games/[id]', { id }));
		} catch {
			actionError = '게임 화면을 열지 못했어요. 다시 시도해주세요.';
		}
	}

	async function addGameFromRail() {
		if (busy || creatingGame) return;
		creatingGame = true;
		let created: Game | null = null;
		try {
			created = await createGame();
			railGames = [toLibraryGame(created), ...railGames];
			await goto(resolve('/games/[id]', { id: created.id }));
		} catch {
			actionError = created
				? '게임은 저장되었지만 화면을 열지 못했어요. 왼쪽 목록에서 다시 열어주세요.'
				: '게임을 추가하지 못했어요. 다시 시도해주세요.';
		} finally {
			creatingGame = false;
		}
	}

	async function addSession() {
		if (!game || busy) return;
		sessionBusy = true;
		actionError = '';
		try {
			const session = await createSession(game.id);
			sessions = [session, ...sessions];
			game = { ...game, activeSessionId: session.id, updatedAt: session.updatedAt };
		} catch {
			actionError = '새 세션을 저장하지 못했어요. 다시 시도해주세요.';
		} finally {
			sessionBusy = false;
		}
	}

	async function changeSession(sessionId: string) {
		if (!game || busy || sessionId === game.activeSessionId) return;
		sessionBusy = true;
		actionError = '';
		try {
			await selectSession(game.id, sessionId);
			game = { ...game, activeSessionId: sessionId };
		} catch {
			actionError = '세션을 전환하지 못했어요. 다시 시도해주세요.';
		} finally {
			sessionBusy = false;
		}
	}

	function startRename(session: Session) {
		renamingSessionId = session.id;
		sessionName = session.title;
		renameError = '';
	}

	function focusSessionName(input: HTMLInputElement) {
		input.focus();
		input.select();
	}

	async function saveSessionName(event: SubmitEvent) {
		event.preventDefault();
		if (!game || !renamingSessionId || busy) return;
		renameError = '';
		let title: string;
		try {
			title = validateSessionTitle(sessionName);
		} catch (error) {
			renameError = error instanceof Error ? error.message : '세션 이름을 확인해주세요.';
			return;
		}
		sessionBusy = true;
		try {
			const updated = await renameSession(game.id, renamingSessionId, title);
			sessions = sessions.map((session) => (session.id === updated.id ? updated : session));
			renamingSessionId = null;
		} catch {
			renameError = '세션 이름을 저장하지 못했어요. 다시 시도해주세요.';
		} finally {
			sessionBusy = false;
		}
	}

	function requestDelete(session: Session) {
		renamingSessionId = null;
		renameError = '';
		deleteError = '';
		deletingSession = session;
	}

	function openDeleteDialog(dialog: HTMLDialogElement) {
		dialog.showModal();
		return () => dialog.close();
	}

	async function confirmDelete() {
		if (!game || !deletingSession || busy) return;
		const deletingSessionId = deletingSession.id;
		sessionBusy = true;
		deleteError = '';
		try {
			const workspace = await deleteSession(game.id, deletingSession.id);
			game = workspace.game;
			sessions = workspace.sessions;
			deletingSession = null;
			delete chatDrafts[deletingSessionId];
		} catch {
			deleteError = '세션을 삭제하지 못했어요. 다시 시도해주세요.';
		} finally {
			sessionBusy = false;
		}
	}

	async function saveSettings(input: UpdateGameSettings): Promise<Game> {
		if (!game) throw new Error('Game is unavailable');
		const updated = await updateGameSettings(game.id, input);
		const openingChanged = game.settings.firstMessage !== updated.settings.firstMessage;
		game = {
			...game,
			title: updated.title,
			settings: updated.settings,
			updatedAt: updated.updatedAt > game.updatedAt ? updated.updatedAt : game.updatedAt
		};
		if (openingChanged) {
			if (chatSaving) refreshOpeningAfterSend = true;
			else conversationRevision += 1;
		}
		const current = toLibraryGame(game);
		railGames = railGames.map((item) => (item.id === updated.id ? current : item));
		return updated;
	}

	function moveTab(event: KeyboardEvent) {
		if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
		event.preventDefault();
		selectedTab =
			event.key === 'Home'
				? 'sessions'
				: event.key === 'End'
					? 'game'
					: selectedTab === 'sessions'
						? 'game'
						: 'sessions';
		(event.currentTarget as HTMLElement).parentElement
			?.querySelector<HTMLButtonElement>(`[data-tab="${selectedTab}"]`)
			?.focus();
	}
</script>

<svelte:head><title>{game?.title ?? '게임'} · Helia</title></svelte:head>

<div class="workspace">
	<header>
		<a class="home-link" href={resolve('/')} aria-label="내 게임"
			><Icon name="sun" size={24} /><span>내 게임</span></a
		>
		{#if game}
			<div class="game-heading">
				<h1>{game.title}</h1>
				<span class="badge">제작 중</span>
			</div>
		{/if}
	</header>

	{#if loading}
		<main class="status"><p role="status">게임을 불러오는 중…</p></main>
	{:else if loadError}
		<main class="status">
			<p role="alert">{loadError}</p>
			<button type="button" onclick={loadWorkspace}>다시 불러오기</button>
		</main>
	{:else if missing}
		<main class="status">
			<h1>게임을 찾을 수 없어요</h1>
			<a href={resolve('/')}>내 게임으로 돌아가기</a>
		</main>
	{:else if game}
		<div
			class={['game-layout', { resizing, 'sidebar-collapsed': sidebarCollapsed }]}
			bind:clientWidth={layoutWidth}
			style:--sidebar-width={`${displayedWidth}px`}
		>
			<aside
				id="workspace-sidebar"
				class="sessions-panel"
				aria-label="게임 세션"
				hidden={sidebarCollapsed}
			>
				<div class="panel-tabs" role="tablist" aria-label="사이드바 보기">
					<button
						id="sessions-tab"
						onkeydown={moveTab}
						data-tab="sessions"
						class={{ selected: selectedTab === 'sessions' }}
						type="button"
						role="tab"
						aria-selected={selectedTab === 'sessions'}
						aria-controls="sessions-panel"
						tabindex={selectedTab === 'sessions' ? 0 : -1}
						onclick={() => (selectedTab = 'sessions')}>세션</button
					>
					<button
						id="game-tab"
						onkeydown={moveTab}
						data-tab="game"
						class={{ selected: selectedTab === 'game' }}
						type="button"
						role="tab"
						aria-selected={selectedTab === 'game'}
						aria-controls="game-panel"
						tabindex={selectedTab === 'game' ? 0 : -1}
						onclick={() => (selectedTab = 'game')}>게임</button
					>
				</div>
				<div
					id="sessions-panel"
					role="tabpanel"
					aria-labelledby="sessions-tab"
					tabindex="0"
					hidden={selectedTab !== 'sessions'}
				>
					<button class="new-session" type="button" disabled={busy} onclick={addSession}
						><Icon name="plus" size={17} /><span>새 세션</span></button
					>
					<nav aria-label="세션 목록" aria-busy={busy}>
						{#each sessions as session (session.id)}
							<div class={['session-row', { active: session.id === game.activeSessionId }]}>
								{#if renamingSessionId === session.id}
									<form class="session-rename" onsubmit={saveSessionName}>
										<span class="session-prefix" aria-hidden="true">#</span>
										<input
											{@attach focusSessionName}
											aria-label="세션 이름"
											bind:value={sessionName}
											maxlength={SESSION_TITLE_MAX_LENGTH}
											disabled={busy}
											aria-describedby={renameError ? 'session-rename-error' : undefined}
											onkeydown={(event) => {
												if (event.key === 'Escape' && !busy) {
													event.preventDefault();
													renamingSessionId = null;
													renameError = '';
												}
											}}
										/>
										<button
											class="session-action"
											type="submit"
											aria-label="이름 저장"
											disabled={busy}><Icon name="check" size={16} /></button
										>
										<button
											class="session-action"
											type="button"
											aria-label="이름 수정 취소"
											disabled={busy}
											onclick={() => {
												renamingSessionId = null;
												renameError = '';
											}}><Icon name="close" size={16} /></button
										>
									</form>
								{:else}
									<button
										class="session"
										type="button"
										aria-current={session.id === game.activeSessionId ? 'true' : undefined}
										disabled={busy}
										aria-label={`${session.title} 열기`}
										onclick={() => changeSession(session.id)}
									>
										<span class="session-prefix" aria-hidden="true">#</span><strong
											>{session.title}</strong
										>
									</button>
									<button
										class="session-action"
										type="button"
										aria-label={`${session.title} 이름 수정`}
										title="이름 수정"
										disabled={busy}
										onclick={() => startRename(session)}><Icon name="pencil" size={16} /></button
									>
									<button
										class="session-action"
										type="button"
										aria-label={`${session.title} 삭제`}
										title="삭제"
										disabled={busy}
										onclick={() => requestDelete(session)}><Icon name="trash" size={16} /></button
									>
								{/if}
							</div>
						{/each}
					</nav>
					{#if renameError}<p class="session-error" id="session-rename-error" role="alert">
							{renameError}
						</p>{/if}
				</div>
				<div
					class="game-panel"
					id="game-panel"
					role="tabpanel"
					aria-labelledby="game-tab"
					tabindex="0"
					hidden={selectedTab !== 'game'}
				>
					<GameSettingsPanel {game} onsave={saveSettings} />
				</div>
			</aside>
			<div
				class="resize-handle"
				role="slider"
				hidden={sidebarCollapsed}
				tabindex="0"
				aria-label="사이드바 너비 조절"
				aria-orientation="horizontal"
				aria-controls="workspace-sidebar"
				aria-valuemin={MIN_SIDEBAR_WIDTH}
				aria-valuemax={Math.round(maxSidebarWidth)}
				aria-valuenow={Math.round(displayedWidth)}
				onpointerdown={startResize}
				onpointermove={resize}
				onpointerup={finishResize}
				onpointercancel={finishResize}
				onlostpointercapture={finishResize}
				onkeydown={resizeWithKeyboard}
			></div>
			<button
				class="sidebar-toggle"
				type="button"
				aria-label={sidebarCollapsed ? '사이드바 펼치기' : '사이드바 접기'}
				aria-controls="workspace-sidebar"
				aria-expanded={!sidebarCollapsed}
				onclick={toggleSidebar}
				><Icon name={sidebarCollapsed ? 'arrow-right' : 'arrow-left'} size={20} /></button
			>
			<main class={['session-workspace', { 'has-game-ui': !!game.ui }]} aria-label="현재 세션">
				{#if actionError}<p class="action-error" role="alert">{actionError}</p>{/if}
				{#if activeSession}
					{@const currentSessionId = activeSession.id}
					{@const currentGame = game}
					<div class="session-heading">
						<Icon name="chat" size={18} />
						<h2>{activeSession.title}</h2>
					</div>
					{#snippet chat(theme?: GameUI['chatStyle'])}
						{#key `${currentSessionId}:${conversationRevision}`}
							<SessionChat
								gameId={currentGame.id}
								sessionId={currentSessionId}
								gameTitle={currentGame.title}
								blocked={sessionBusy || uiSaving}
								chatStyle={theme}
								bind:draft={
									() => chatDrafts[currentSessionId] ?? '',
									(value) => (chatDrafts[currentSessionId] = value)
								}
								onsessionupdate={(updated) => {
									sessions = sessions.map((session) =>
										session.id === updated.id ? updated : session
									);
								}}
								onsavingchange={(saving) => {
									chatSaving = saving;
									if (!saving && refreshOpeningAfterSend) {
										refreshOpeningAfterSend = false;
										conversationRevision += 1;
									}
								}}
							/>
						{/key}
					{/snippet}
					{#if game.ui}
						{#key currentSessionId}
							<GameWorkbench
								gameId={game.id}
								sessionId={currentSessionId}
								ui={game.ui}
								blocked={sessionBusy || chatSaving}
								onsavingchange={(saving) => (uiSaving = saving)}
							>
								{#snippet children(theme)}{@render chat(theme)}{/snippet}
							</GameWorkbench>
						{/key}
					{:else}
						{@render chat()}
					{/if}
				{/if}
			</main>
		</div>
	{/if}
</div>

{#if deletingSession}
	<dialog
		class="delete-dialog"
		{@attach openDeleteDialog}
		aria-labelledby="delete-session-heading"
		oncancel={(event) => {
			if (busy) event.preventDefault();
		}}
		onclose={() => {
			if (!busy) deletingSession = null;
		}}
	>
		<h2 id="delete-session-heading">세션 삭제</h2>
		<p class="delete-title">{deletingSession.title}</p>
		{#if deleteError}<p class="session-error" role="alert">{deleteError}</p>{/if}
		<div class="dialog-actions">
			<button type="button" disabled={busy} onclick={() => (deletingSession = null)}>취소</button>
			<button type="button" disabled={busy} onclick={confirmDelete}
				>{busy ? '삭제 중…' : '삭제'}</button
			>
		</div>
	</dialog>
{/if}

<style>
	.session-row {
		display: flex;
		min-width: 0;
		align-items: center;
		gap: 2px;
		padding-right: 4px;
		border: 1px solid transparent;
		border-radius: 6px;
	}
	.session-action {
		width: 28px;
		min-height: 28px;
		flex-shrink: 0;
		padding: 4px;
		border: 0;
		background: transparent;
		color: var(--text-muted);
	}
	.session-rename {
		display: flex;
		min-width: 0;
		flex: 1;
		align-items: center;
		gap: 4px;
		padding: 3px 0 3px 10px;
	}
	.session-rename input {
		width: 100%;
		min-width: 0;
		padding: 5px;
		border: 1px solid var(--border-strong);
		border-radius: 4px;
		background: var(--background);
		color: var(--text-strong);
		font: inherit;
		font-size: 12px;
	}
	.session-error {
		color: var(--text-strong);
		font-size: 12px;
		line-height: 1.7;
	}
	.delete-dialog {
		width: min(360px, calc(100vw - 32px));
		padding: 24px;
		border: 1px solid var(--border-strong);
		border-radius: 10px;
		background: var(--background);
		color: var(--text);
	}
	.delete-dialog::backdrop {
		background: #0009;
	}
	.delete-title {
		overflow-wrap: anywhere;
		font-size: 14px;
	}
	.dialog-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 24px;
	}
	.workspace {
		display: flex;
		height: 100dvh;
		flex-direction: column;
		overflow: hidden;
		background: var(--background);
	}
	header {
		display: flex;
		flex-shrink: 0;
		min-height: 78px;
		align-items: center;
		gap: 28px;
		padding: 18px 26px;
		border-bottom: 1px solid var(--border-strong);
		background: var(--surface);
	}
	a {
		color: var(--text);
		text-decoration: none;
	}
	a:hover {
		color: var(--text-strong);
	}
	.home-link {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		gap: 10px;
		font-size: 12px;
	}
	.game-heading {
		display: flex;
		min-width: 0;
		flex: 1;
		align-items: center;
		gap: 12px;
	}
	h1 {
		margin: 0;
		overflow-wrap: anywhere;
		color: var(--text-strong);
		font-size: 18px;
		font-weight: 550;
	}
	.badge {
		flex-shrink: 0;
		padding: 4px 7px;
		border: 1px solid var(--border);
		border-radius: 5px;
		color: var(--text-muted);
		font-size: 10px;
	}
	button {
		display: inline-flex;
		min-height: 36px;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: 8px 12px;
		border: 1px solid var(--border-strong);
		border-radius: 7px;
		background: var(--surface);
		color: var(--text);
		font-size: 12px;
	}
	button:hover:not(:disabled) {
		background: var(--surface-hover);
		color: var(--text-strong);
	}
	button:disabled {
		opacity: 0.6;
	}
	.game-layout {
		position: relative;
		display: grid;
		min-height: 0;
		flex: 1;
		grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
		grid-template-rows: minmax(0, 1fr);
	}
	.game-layout.sidebar-collapsed {
		grid-template-columns: minmax(0, 1fr);
	}
	.sidebar-toggle {
		position: absolute;
		z-index: 3;
		top: 16px;
		left: var(--sidebar-width);
		width: 42px;
		height: 40px;
		padding: 0;
		border-left: 0;
		border-radius: 0 6px 6px 0;
	}
	.sidebar-collapsed .sidebar-toggle {
		left: 0;
	}
	.resize-handle {
		position: absolute;
		z-index: 2;
		top: 0;
		bottom: 0;
		left: calc(var(--sidebar-width) - 4px);
		width: 8px;
		cursor: col-resize;
		touch-action: none;
	}
	.resize-handle::after {
		position: absolute;
		top: 0;
		bottom: 0;
		left: 3px;
		width: 2px;
		background: transparent;
		content: '';
	}
	.resize-handle:hover::after,
	.resize-handle:focus-visible::after,
	.resizing .resize-handle::after {
		background: var(--text-muted);
	}
	.sessions-panel {
		min-width: 0;
		min-height: 0;
		overflow-y: auto;
		padding: 16px 14px;
		border-right: 1px solid var(--border);
		background: var(--surface);
	}
	.panel-tabs {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 3px;
		margin-bottom: 16px;
		padding: 3px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--background);
	}
	.panel-tabs button {
		min-height: 32px;
		border-color: transparent;
		background: transparent;
		color: var(--text-muted);
	}
	.panel-tabs button.selected {
		border-color: var(--border);
		background: var(--surface-active);
		color: var(--text-strong);
	}
	h2 {
		margin: 0;
		color: var(--text-strong);
		font-size: 13px;
		font-weight: 550;
	}
	.new-session {
		width: 100%;
		margin-bottom: 12px;
	}
	nav {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}
	.session {
		min-width: 0;
		flex: 1;
		justify-content: flex-start;
		min-height: 36px;
		gap: 10px;
		padding: 9px 12px;
		border-color: transparent;
		background: transparent;
		text-align: left;
	}
	.session-row.active {
		border-color: var(--border-strong);
		background: var(--surface-active);
		color: var(--text-strong);
	}
	.session-prefix {
		flex-shrink: 0;
		color: var(--text-muted);
		font-size: 16px;
	}
	.session strong {
		overflow: hidden;
		font-size: 12px;
		font-weight: 500;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.session-workspace {
		display: flex;
		min-width: 0;
		min-height: 0;
		flex-direction: column;
		padding: 28px 24px 20px 64px;
	}
	.session-heading {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-shrink: 0;
		padding-bottom: 16px;
		border-bottom: 1px solid var(--border);
		color: var(--text-muted);
	}
	.session-workspace.has-game-ui {
		padding: 0 0 0 36px;
	}
	.has-game-ui .session-heading {
		padding: 7px 12px;
		font-size: 12px;
	}
	.session-heading h2 {
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.status p {
		color: var(--text-muted);
		font-size: 12px;
		line-height: 1.8;
	}
	.status {
		padding: 60px 28px;
		text-align: center;
	}
	.action-error {
		padding: 12px;
		border: 1px solid var(--border-strong);
		border-radius: 7px;
		color: var(--text-strong);
		font-size: 12px;
		line-height: 1.8;
	}
	@media (max-width: 640px) {
		header {
			gap: 14px;
			flex-wrap: wrap;
			padding: 16px;
		}
		.home-link span {
			display: none;
		}
		.game-heading {
			gap: 8px;
		}
		h1 {
			font-size: 16px;
		}
		.game-layout {
			grid-template-columns: minmax(0, 1fr);
			grid-template-rows: minmax(0, auto) minmax(0, 1fr);
		}
		.game-layout.sidebar-collapsed {
			grid-template-rows: minmax(0, 1fr);
		}
		.sessions-panel {
			max-height: 42dvh;
			border-right: 0;
			border-bottom: 1px solid var(--border);
		}
		.resize-handle {
			display: none;
		}
		.sidebar-toggle {
			right: 10px;
			left: auto;
			border-left: 1px solid var(--border-strong);
			border-radius: 6px;
		}
		.sidebar-collapsed .sidebar-toggle {
			right: auto;
			left: 0;
		}
		.panel-tabs {
			margin-right: 48px;
		}
		.sessions-panel {
			padding: 22px 10px;
		}
		.session {
			gap: 6px;
			padding: 10px 5px;
		}
		.session-workspace {
			padding: 20px 12px 12px;
		}
		.session-workspace.has-game-ui {
			padding: 0;
		}
		.sidebar-collapsed .session-heading {
			padding-left: 44px;
		}
	}
</style>
