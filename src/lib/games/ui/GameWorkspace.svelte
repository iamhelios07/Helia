<script lang="ts">
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';

	import { MIN_SIDEBAR_WIDTH } from '#lib/app/preferences/sidebar.js';
	import Icon from '#lib/components/Icon.svelte';

	import type { GameUI } from './runtime/model.js';

	import { SESSION_TITLE_MAX_LENGTH } from '../model.js';
	import GameSettingsPanel from './GameSettingsPanel.svelte';
	import GameWorkbench from './GameWorkbench.svelte';
	import { GameWorkspaceController } from './gameworkspace-controller.svelte.js';
	import SessionChat from './SessionChat.svelte';
	let { gameId }: { gameId: string } = $props();

	const workspace = new GameWorkspaceController(() => ({ gameId }));
	onMount(workspace.mount);
</script>

<svelte:head><title>{workspace.game?.title ?? '게임'} · Helia</title></svelte:head>

<div class="workspace">
	<header>
		<a class="home-link" href={resolve('/')} aria-label="내 게임"
			><Icon name="sun" size={24} /><span>내 게임</span></a
		>
		{#if workspace.game}
			<div class="game-heading">
				<h1>{workspace.game.title}</h1>
				<span class="badge">제작 중</span>
			</div>
		{/if}
	</header>

	{#if workspace.loading}
		<main class="status"><p role="status">게임을 불러오는 중…</p></main>
	{:else if workspace.loadError}
		<main class="status">
			<p role="alert">{workspace.loadError}</p>
			<button type="button" onclick={workspace.loadWorkspace}>다시 불러오기</button>
		</main>
	{:else if workspace.missing}
		<main class="status">
			<h1>게임을 찾을 수 없어요</h1>
			<a href={resolve('/')}>내 게임으로 돌아가기</a>
		</main>
	{:else if workspace.game}
		<div
			class={[
				'game-layout',
				{ resizing: workspace.resizing, 'sidebar-collapsed': workspace.sidebarCollapsed }
			]}
			bind:clientWidth={workspace.layoutWidth}
			style:--sidebar-width={`${workspace.displayedWidth}px`}
		>
			<aside
				id="workspace-sidebar"
				class="sessions-panel"
				aria-label="게임 세션"
				hidden={workspace.sidebarCollapsed}
			>
				<div class="panel-tabs" role="tablist" aria-label="사이드바 보기">
					<button
						id="sessions-tab"
						onkeydown={workspace.moveTab}
						data-tab="sessions"
						class={{ selected: workspace.selectedTab === 'sessions' }}
						type="button"
						role="tab"
						aria-selected={workspace.selectedTab === 'sessions'}
						aria-controls="sessions-panel"
						tabindex={workspace.selectedTab === 'sessions' ? 0 : -1}
						onclick={() => (workspace.selectedTab = 'sessions')}>세션</button
					>
					<button
						id="game-tab"
						onkeydown={workspace.moveTab}
						data-tab="game"
						class={{ selected: workspace.selectedTab === 'game' }}
						type="button"
						role="tab"
						aria-selected={workspace.selectedTab === 'game'}
						aria-controls="game-panel"
						tabindex={workspace.selectedTab === 'game' ? 0 : -1}
						onclick={() => (workspace.selectedTab = 'game')}>게임</button
					>
				</div>
				<div
					id="sessions-panel"
					role="tabpanel"
					aria-labelledby="sessions-tab"
					tabindex="0"
					hidden={workspace.selectedTab !== 'sessions'}
				>
					<button
						class="new-session"
						type="button"
						disabled={workspace.busy}
						onclick={workspace.addSession}
						><Icon name="plus" size={17} /><span>새 세션</span></button
					>
					<nav aria-label="세션 목록" aria-busy={workspace.busy}>
						{#each workspace.sessions as session (session.id)}
							<div
								class={['session-row', { active: session.id === workspace.game.activeSessionId }]}
							>
								{#if workspace.renamingSessionId === session.id}
									<form class="session-rename" onsubmit={workspace.saveSessionName}>
										<span class="session-prefix" aria-hidden="true">#</span>
										<input
											{@attach workspace.focusSessionName}
											aria-label="세션 이름"
											bind:value={workspace.sessionName}
											maxlength={SESSION_TITLE_MAX_LENGTH}
											disabled={workspace.busy}
											aria-describedby={workspace.renameError ? 'session-rename-error' : undefined}
											onkeydown={(event) => {
												if (event.key === 'Escape' && !workspace.busy) {
													event.preventDefault();
													workspace.renamingSessionId = null;
													workspace.renameError = '';
												}
											}}
										/>
										<button
											class="session-action"
											type="submit"
											aria-label="이름 저장"
											disabled={workspace.busy}><Icon name="check" size={16} /></button
										>
										<button
											class="session-action"
											type="button"
											aria-label="이름 수정 취소"
											disabled={workspace.busy}
											onclick={() => {
												workspace.renamingSessionId = null;
												workspace.renameError = '';
											}}><Icon name="close" size={16} /></button
										>
									</form>
								{:else}
									<button
										class="session"
										type="button"
										aria-current={session.id === workspace.game.activeSessionId
											? 'true'
											: undefined}
										disabled={workspace.busy}
										aria-label={`${session.title} 열기`}
										onclick={() => workspace.changeSession(session.id)}
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
										disabled={workspace.busy}
										onclick={() => workspace.startRename(session)}
										><Icon name="pencil" size={16} /></button
									>
									<button
										class="session-action"
										type="button"
										aria-label={`${session.title} 삭제`}
										title="삭제"
										disabled={workspace.busy}
										onclick={() => workspace.requestDelete(session)}
										><Icon name="trash" size={16} /></button
									>
								{/if}
							</div>
						{/each}
					</nav>
					{#if workspace.renameError}<p
							class="session-error"
							id="session-rename-error"
							role="alert"
						>
							{workspace.renameError}
						</p>{/if}
				</div>
				<div
					class="game-panel"
					id="game-panel"
					role="tabpanel"
					aria-labelledby="game-tab"
					tabindex="0"
					hidden={workspace.selectedTab !== 'game'}
				>
					<GameSettingsPanel
						game={workspace.game}
						onsave={workspace.saveSettings}
						blocked={workspace.busy}
					/>
				</div>
			</aside>
			<div
				class="resize-handle"
				role="slider"
				hidden={workspace.sidebarCollapsed}
				tabindex="0"
				aria-label="사이드바 너비 조절"
				aria-orientation="horizontal"
				aria-controls="workspace-sidebar"
				aria-valuemin={MIN_SIDEBAR_WIDTH}
				aria-valuemax={Math.round(workspace.maxSidebarWidth)}
				aria-valuenow={Math.round(workspace.displayedWidth)}
				onpointerdown={workspace.startResize}
				onpointermove={workspace.resize}
				onpointerup={workspace.finishResize}
				onpointercancel={workspace.finishResize}
				onlostpointercapture={workspace.finishResize}
				onkeydown={workspace.resizeWithKeyboard}
			></div>
			<button
				class="sidebar-toggle"
				type="button"
				aria-label={workspace.sidebarCollapsed ? '사이드바 펼치기' : '사이드바 접기'}
				aria-controls="workspace-sidebar"
				aria-expanded={!workspace.sidebarCollapsed}
				onclick={workspace.toggleSidebar}
				><Icon name={workspace.sidebarCollapsed ? 'arrow-right' : 'arrow-left'} size={20} /></button
			>
			<main
				class={['session-workspace', { 'has-game-ui': !!workspace.game.ui }]}
				aria-label="현재 세션"
			>
				{#if workspace.actionError}<p class="action-error" role="alert">
						{workspace.actionError}
					</p>{/if}
				{#if workspace.activeSession}
					{@const currentSessionId = workspace.activeSession.id}
					{@const currentGame = workspace.game}
					<div class="session-heading">
						<Icon name="chat" size={18} />
						<h2>{workspace.activeSession.title}</h2>
					</div>
					{#snippet chat(theme?: GameUI['chatStyle'])}
						{#key currentSessionId}
							<SessionChat
								gameId={currentGame.id}
								sessionId={currentSessionId}
								gameTitle={currentGame.title}
								blocked={workspace.sessionBusy || workspace.uiSaving}
								chatStyle={theme}
								bind:draft={
									() => workspace.chatDrafts[currentSessionId] ?? '',
									(value) => (workspace.chatDrafts[currentSessionId] = value)
								}
								onsessionupdate={(updated) => {
									workspace.sessions = workspace.sessions.map((session) =>
										session.id === updated.id ? updated : session
									);
								}}
								onsavingchange={(saving) => (workspace.chatSaving = saving)}
							/>
						{/key}
					{/snippet}
					{#key currentSessionId}
						<GameWorkbench
							gameId={workspace.game.id}
							sessionId={currentSessionId}
							ui={workspace.game.ui}
							blocked={workspace.sessionBusy || workspace.chatSaving}
							onsavingchange={(saving) => (workspace.uiSaving = saving)}
						>
							{#snippet children(theme)}{@render chat(theme)}{/snippet}
						</GameWorkbench>
					{/key}
				{/if}
			</main>
		</div>
	{/if}
</div>

{#if workspace.deletingSession}
	<dialog
		class="delete-dialog"
		{@attach workspace.openDeleteDialog}
		aria-labelledby="delete-session-heading"
		oncancel={(event) => {
			if (workspace.busy) {
				event.preventDefault();
			}
		}}
		onclose={() => {
			if (!workspace.busy) {
				workspace.deletingSession = null;
			}
		}}
	>
		<h2 id="delete-session-heading">세션 삭제</h2>
		<p class="delete-title">{workspace.deletingSession.title}</p>
		{#if workspace.deleteError}<p class="session-error" role="alert">
				{workspace.deleteError}
			</p>{/if}
		<div class="dialog-actions">
			<button
				type="button"
				disabled={workspace.busy}
				onclick={() => (workspace.deletingSession = null)}>취소</button
			>
			<button type="button" disabled={workspace.busy} onclick={workspace.confirmDelete}
				>{workspace.busy ? '삭제 중…' : '삭제'}</button
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
