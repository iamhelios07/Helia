<script lang="ts">
	import { tick } from 'svelte';

	import Icon from '#lib/components/Icon.svelte';
	import ItemActions from '#lib/components/ItemActions.svelte';

	import type { GameWorkspaceController } from './gameworkspace-controller.svelte.js';

	import GameSettingsPanel from './GameSettingsPanel.svelte';
	import SessionHistoryPanel from './SessionHistoryPanel.svelte';
	import SessionModelSelect from './SessionModelSelect.svelte';
	import SessionPersonaSelect from './SessionPersonaSelect.svelte';
	let { workspace }: { workspace: GameWorkspaceController } = $props();
	let historyButton: HTMLButtonElement | undefined;
	let sessionList: HTMLElement | undefined;
	let listScroll = 0;
	function attachHistoryButton(element: HTMLButtonElement) {
		historyButton = element;
		return () => {
			historyButton = undefined;
		};
	}
	function attachSessionList(element: HTMLElement) {
		sessionList = element;
		return () => {
			sessionList = undefined;
		};
	}
	function openHistory() {
		listScroll = sessionList?.scrollTop ?? 0;
		workspace.chat?.toggleTimeline();
	}
	async function closeHistory() {
		workspace.chat?.toggleTimeline();
		await tick();
		if (sessionList) {
			sessionList.scrollTop = listScroll;
		}
		historyButton?.focus({ preventScroll: true });
	}
</script>

<aside
	id="workspace-sidebar"
	class={['sessions-panel', { 'history-open': workspace.chat?.showTimeline }]}
	aria-label="게임 세션"
	hidden={workspace.sidebarCollapsed}
>
	<div class="sidebar-standard" hidden={workspace.chat?.showTimeline ?? false}>
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
			class="panel-content"
			id="sessions-panel"
			role="tabpanel"
			aria-labelledby="sessions-tab"
			tabindex="0"
			hidden={workspace.selectedTab !== 'sessions'}
		>
			<button
				class="new-session"
				type="button"
				{@attach attachHistoryButton}
				disabled={!workspace.chat ||
					workspace.busy ||
					workspace.chat.loading ||
					!!workspace.chat.loadError}
				aria-controls="sidebar-history"
				aria-expanded={workspace.chat?.showTimeline ?? false}
				onclick={openHistory}
			>
				<Icon name="branch" size={17} /><span>이력과 분기</span>
			</button>
			<button
				class="new-session"
				type="button"
				disabled={workspace.busy}
				onclick={workspace.addSession}><Icon name="plus" size={17} /><span>새 세션</span></button
			>
			<nav {@attach attachSessionList} aria-label="세션 목록" aria-busy={workspace.busy}>
				{#each workspace.sessions as session (session.id)}
					<div class={['session-row', { active: session.id === workspace.game?.activeSessionId }]}>
						<button
							class="session"
							type="button"
							aria-current={session.id === workspace.game?.activeSessionId ? 'true' : undefined}
							disabled={workspace.busy}
							aria-label={`${session.title} 열기`}
							onclick={() => workspace.changeSession(session.id)}
						>
							<span class="session-prefix" aria-hidden="true">#</span><strong
								>{session.title}</strong
							>
						</button>
						<ItemActions
							name={session.title}
							disabled={workspace.busy}
							onrename={() => workspace.startRename(session)}
							ondelete={() => workspace.requestDelete(session)}
						/>
					</div>
				{/each}
			</nav>
		</div>
		<div
			class="game-panel"
			id="game-panel"
			role="tabpanel"
			aria-labelledby="game-tab"
			tabindex="0"
			hidden={workspace.selectedTab !== 'game'}
		>
			{#if workspace.game}<GameSettingsPanel
					game={workspace.game}
					onsave={workspace.saveSettings}
					blocked={workspace.busy}
				/>{/if}
		</div>
		<SessionModelSelect chat={workspace.chat} blocked={workspace.busy} />
		<SessionPersonaSelect chat={workspace.chat} blocked={workspace.busy} />
	</div>
	{#if workspace.chat?.showTimeline}
		{@const chat = workspace.chat}
		<div class="history-view" id="sidebar-history">
			<button class="back" type="button" onclick={closeHistory}
				><Icon name="arrow-left" size={16} /><span>돌아가기</span></button
			>
			<div class="history-heading">
				<Icon name="branch" size={18} />
				<h2>이력과 분기</h2>
			</div>
			<p class="history-session">{workspace.activeSession?.title}</p>
			<SessionHistoryPanel
				context={chat.displayContext}
				timeline={chat.timeline}
				busy={chat.timelineBusy || chat.locked || chat.blocked}
				appearance={chat.theme}
				error={chat.timelineError}
				onselect={async (id) => {
					await chat.changeTimeline(id);
				}}
				ondelete={(id, revision) => chat.changeTimeline(id, true, revision)}
				onreload={chat.reloadTimeline}
			/>
		</div>
	{/if}
</aside>

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
	.sessions-panel {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
		padding: 16px 14px;
		border-right: 1px solid var(--border);
		background: var(--surface);
	}
	.panel-tabs {
		flex-shrink: 0;
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
	.new-session {
		flex-shrink: 0;
		width: 100%;
		margin-bottom: 12px;
	}
	nav {
		display: flex;
		flex-direction: column;
		gap: 5px;
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		scrollbar-width: thin;
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
	.sessions-panel[hidden],
	.sidebar-standard[hidden],
	.panel-content[hidden],
	.game-panel[hidden] {
		display: none;
	}
	.sidebar-standard,
	.panel-content {
		display: flex;
		flex-direction: column;
		min-height: 0;
	}
	.sidebar-standard {
		overflow-y: auto;
		scrollbar-width: thin;
	}
	.panel-content {
		flex-shrink: 0;
	}
	.panel-content nav {
		flex: 0 1 auto;
		max-height: 40vh;
	}
	.game-panel {
		flex: 0 1 auto;
		min-height: 0;
		max-height: 45vh;
		overflow-y: auto;
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
		font: inherit;
		font-size: 12px;
		cursor: pointer;
	}
	button:hover:not(:disabled) {
		background: var(--surface-hover);
		color: var(--text-strong);
	}
	button:disabled {
		opacity: 0.6;
		cursor: default;
	}
	button:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.history-view {
		display: flex;
		flex: 1;
		min-height: 0;
		flex-direction: column;
	}
	.back {
		align-self: flex-start;
		padding-left: 5px;
		border-color: transparent;
		background: transparent;
	}
	.history-heading {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 16px;
		color: var(--text-strong);
	}
	h2 {
		margin: 0;
		font-size: 14px;
		font-weight: 550;
	}
	.history-session {
		color: var(--text-muted);
		font-size: 12px;
		margin: 7px 0 16px;
		overflow-wrap: anywhere;
	}
	@media (max-width: 640px) {
		.sessions-panel.history-open {
			max-height: 62dvh;
		}
		.sessions-panel {
			max-height: 42dvh;
			border-right: 0;
			border-bottom: 1px solid var(--border);
			padding: 22px 10px;
		}
		.panel-tabs,
		.back {
			margin-right: 48px;
		}
		.session {
			gap: 6px;
			padding: 10px 5px;
		}
	}
</style>
