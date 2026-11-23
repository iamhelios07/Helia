<script lang="ts">
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';

	import { MIN_SIDEBAR_WIDTH } from '#lib/app/preferences/sidebar.js';
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import NameDialog from '#lib/components/NameDialog.svelte';

	import type { GameUI } from './runtime/model.js';

	import { SESSION_TITLE_MAX_LENGTH } from '../model.js';
	import GameSessionSidebar from './GameSessionSidebar.svelte';
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
			<GameSessionSidebar {workspace} />
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
								initialTimeline={workspace.startupTimeline?.session.id === currentSessionId
									? workspace.startupTimeline
									: undefined}
								regex={currentGame.regex}
								oncontroller={workspace.attachChat}
								blocked={workspace.sessionBusy || workspace.uiSaving}
								chatStyle={theme}
								bind:draft={
									() => workspace.chatDrafts[currentSessionId] ?? '',
									(value) => (workspace.chatDrafts[currentSessionId] = value)
								}
								onsessionupdate={(updated) => {
									if (workspace.startupTimeline?.session.updatedAt !== updated.updatedAt) {
										workspace.startupTimeline = null;
									}
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
							initialHistory={workspace.startupTimeline?.session.id === currentSessionId
								? workspace.startupTimeline.history
								: undefined}
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

{#if workspace.renamingSessionId}<NameDialog
		name={workspace.sessionName}
		label="세션 이름"
		maxlength={SESSION_TITLE_MAX_LENGTH}
		disabled={workspace.busy}
		onconfirm={workspace.saveSessionName}
		oncancel={() => (workspace.renamingSessionId = null)}
	/>{/if}
{#if workspace.deletingSession}<ConfirmDialog
		title="세션 삭제"
		message={`‘${workspace.deletingSession.title}’ 세션과 진행 기록을 삭제할까요?`}
		disabled={workspace.busy}
		error={workspace.deleteError}
		confirmLabel={workspace.busy ? '삭제 중…' : '삭제'}
		onconfirm={workspace.confirmDelete}
		oncancel={() => (workspace.deletingSession = null)}
	/>{/if}

<style>
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
	h2 {
		margin: 0;
		color: var(--text-strong);
		font-size: 13px;
		font-weight: 550;
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
