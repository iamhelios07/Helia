<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import GameCover from './GameCover.svelte';
	import type { PreviewGame } from './preview-games';
	let {
		games,
		onhome,
		onadd,
		onselect,
		onabout
	}: {
		games: readonly PreviewGame[];
		onhome: () => void;
		onadd: () => void;
		onselect: (game: PreviewGame) => void;
		onabout: () => void;
	} = $props();
</script>

<aside class="sidebar" aria-label="사이드바">
	<button class="brand" type="button" title="Helia 홈" aria-label="Helia 홈" onclick={onhome}
		><Icon name="sun" size={29} /></button
	>
	<nav class="primary-nav" aria-label="메인 메뉴">
		<button
			class="rail-button active"
			type="button"
			title="내 게임"
			aria-label="내 게임"
			aria-current="page"
			onclick={onhome}><Icon name="grid" size={21} /></button
		>
		<button
			class="rail-button outlined"
			type="button"
			title="게임 추가"
			aria-label="게임 추가"
			onclick={onadd}><Icon name="plus" size={23} /></button
		>
	</nav>
	<div class="separator"></div>
	<nav class="recent-games" aria-label="최근 게임">
		{#each games as game (game.id)}
			<button
				class="recent-game"
				type="button"
				title={game.title}
				aria-label={`${game.title} 상세 보기`}
				onclick={() => onselect(game)}><GameCover kind={game.cover} /></button
			>
		{/each}
	</nav>
	<nav class="bottom-nav" aria-label="앱 메뉴">
		<div class="separator"></div>
		<button
			class="rail-button"
			type="button"
			title="플레이 기록 · 준비 중"
			aria-label="플레이 기록 · 준비 중"
			disabled><Icon name="chat" size={21} /></button
		>
		<button
			class="rail-button"
			type="button"
			title="제작 도구 · 준비 중"
			aria-label="제작 도구 · 준비 중"
			disabled><Icon name="tool" size={21} /></button
		>
		<button
			class="rail-button"
			type="button"
			title="설정 · 준비 중"
			aria-label="설정 · 준비 중"
			disabled><Icon name="settings" size={21} /></button
		>
		<button
			class="rail-button about"
			type="button"
			title="Helia 정보"
			aria-label="Helia 정보"
			onclick={onabout}><Icon name="info" size={18} /></button
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
	.about {
		height: 30px;
		margin-top: 2px;
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
