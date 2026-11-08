<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';

	import type { LibraryGame } from '../library/library-games.js';

	import GameCover from '../library/GameCover.svelte';
	let {
		games,
		onhome,
		onadd,
		onselect,
		onsettings,
		activeGameId = null,
		busy = false
	}: {
		games: readonly LibraryGame[];
		onhome: () => void;
		onadd: () => void;
		onselect: (game: LibraryGame) => void;
		onsettings?: () => void;
		activeGameId?: string | null;
		busy?: boolean;
	} = $props();
</script>

<aside class="sidebar" aria-label="사이드바">
	<button class="brand" type="button" title="Helia 홈" aria-label="Helia 홈" onclick={onhome}
		><Icon name="sun" size={29} /></button
	>
	<nav class="primary-nav" aria-label="메인 메뉴">
		<button
			class={['rail-button', { active: activeGameId === null }]}
			type="button"
			title="내 게임"
			aria-label="내 게임"
			aria-current={activeGameId === null ? 'page' : undefined}
			disabled={busy}
			onclick={onhome}><Icon name="grid" size={21} /></button
		>
		<button
			class="rail-button outlined"
			type="button"
			title="게임 추가"
			aria-label="게임 추가"
			disabled={busy}
			onclick={onadd}><Icon name="plus" size={23} /></button
		>
	</nav>
	<div class="separator"></div>
	<nav class="recent-games" aria-label="최근 게임">
		{#each games as game (game.id)}
			<button
				class={['recent-game', { selected: game.id === activeGameId }]}
				type="button"
				title={game.title}
				aria-label={`${game.title} 상세 보기`}
				aria-current={game.id === activeGameId ? 'page' : undefined}
				disabled={busy}
				onclick={() => onselect(game)}><GameCover /></button
			>
		{/each}
	</nav>
	<nav class="bottom-nav" aria-label="앱 메뉴">
		<div class="separator"></div>
		<button
			class="rail-button"
			type="button"
			title="설정"
			aria-label="설정"
			disabled={busy || !onsettings}
			onclick={onsettings}><Icon name="settings" size={21} /></button
		>
	</nav>
</aside>

<style>
	.sidebar {
		position: fixed;
		inset: 0 auto 0 0;
		z-index: 10;
		display: flex;
		width: var(--rail-width);
		height: 100dvh;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		padding: 24px 10px 14px;
		border-right: 1px solid var(--border);
		background: var(--surface);
	}
	button {
		display: grid;
		flex-shrink: 0;
		place-items: center;
		padding: 0;
		border: 1px solid transparent;
		background: transparent;
		transition:
			background 150ms,
			color 150ms,
			border-color 150ms;
	}
	.brand {
		width: 44px;
		height: 44px;
		margin-bottom: 24px;
		border-radius: 12px;
		color: var(--text-strong);
	}
	.primary-nav,
	.bottom-nav {
		display: flex;
		width: 100%;
		flex-direction: column;
		align-items: center;
		gap: 9px;
	}
	.rail-button {
		position: relative;
		width: 44px;
		height: 44px;
		border-radius: 12px;
		color: var(--text-muted);
	}
	.rail-button.active {
		border-color: var(--border);
		background: var(--surface-active);
		color: var(--text-strong);
	}
	.active::before {
		position: absolute;
		inset: 12px auto 12px -14px;
		width: 3px;
		border-radius: 0 3px 3px 0;
		background: var(--accent);
		content: '';
	}
	.outlined {
		border-color: var(--border);
	}
	button:hover:not(:disabled) {
		background: var(--surface-hover);
		color: var(--text-strong);
	}
	button:disabled {
		opacity: 0.5;
	}
	.separator {
		width: 24px;
		height: 1px;
		flex-shrink: 0;
		margin: 10px 0;
		background: var(--border);
	}
	.recent-games {
		display: flex;
		min-height: 0;
		width: 100%;
		flex: 1;
		flex-direction: column;
		align-items: center;
		gap: 14px;
		overflow-y: auto;
		padding: 3px;
		scrollbar-width: none;
	}
	.recent-game {
		width: 38px;
		height: 38px;
		overflow: hidden;
		border: 1px solid var(--border-strong);
		border-radius: 12px;
	}
	.recent-game:hover {
		border-color: var(--text-muted);
	}
	.recent-game.selected {
		border-color: var(--accent);
		box-shadow: 0 0 0 2px var(--border-strong);
	}
	@media (max-width: 600px) {
		.sidebar {
			padding: 18px 7px 12px;
		}
		.brand {
			margin-bottom: 17px;
		}
		.active::before {
			left: -8px;
		}
	}
</style>
