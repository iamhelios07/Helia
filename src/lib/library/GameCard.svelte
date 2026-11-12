<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';

	import type { LibraryGame } from './library-games.js';

	import GameCover from './GameCover.svelte';
	let {
		game,
		view,
		onselect,
		ontrash
	}: {
		game: LibraryGame;
		view: 'grid' | 'list';
		onselect: (game: LibraryGame) => void;
		ontrash?: (game: LibraryGame) => void;
	} = $props();
</script>

<div class="card-shell">
	<button
		class={['game-card', { 'game-card--list': view === 'list' }]}
		type="button"
		aria-label={`${game.title} · 제작 중 상세 보기`}
		onclick={() => onselect(game)}
	>
		<span class="cover-wrap"><GameCover /></span>
		<span class="game-copy"
			>{#if game.genre}<span class="genre">{game.genre}</span>{/if}<strong>{game.title}</strong
			><span class="metadata">제작 중</span></span
		>
	</button>
	{#if ontrash}
		<button
			class="card-trash"
			type="button"
			aria-label={game.title + ` 휴지통으로 이동`}
			onclick={(event) => {
				event.stopPropagation();
				ontrash(game);
			}}
		>
			<Icon name="trash" size={13} />
		</button>
	{/if}
</div>

<style>
	.card-shell {
		position: relative;
	}
	.card-trash {
		position: absolute;
		top: 10px;
		right: 10px;
		display: inline-grid;
		place-items: center;
		width: 30px;
		height: 30px;
		padding: 0;
		border: 1px solid var(--border);
		border-radius: 7px;
		background: color-mix(in srgb, var(--background) 85%, transparent);
		color: var(--text-muted);
	}
	.card-trash:hover {
		color: var(--text-strong);
		border-color: var(--text-muted);
	}

	.game-card {
		display: flex;
		width: 100%;
		min-width: 0;
		flex-direction: column;
		padding: 0;
		border: 0;
		border-radius: 10px;
		background: transparent;
		text-align: left;
	}
	.cover-wrap {
		display: block;
		width: 100%;
		aspect-ratio: 3 / 4;
		overflow: hidden;
		border: 1px solid var(--border);
		border-radius: 9px;
		transition:
			transform 180ms,
			border-color 180ms;
	}
	.game-card:hover .cover-wrap {
		transform: translateY(-4px);
		border-color: var(--text-muted);
	}
	.game-copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 7px;
		padding-top: 16px;
	}
	.genre {
		color: var(--text-muted);
		font-size: 11px;
		line-height: 1.5;
	}
	strong {
		overflow: hidden;
		color: var(--text-strong);
		font-size: 14px;
		font-weight: 550;
		line-height: 1.6;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.metadata {
		color: var(--text-muted);
		font-size: 11px;
		line-height: 1.6;
	}
	.game-card--list {
		flex-direction: row;
		align-items: center;
		gap: 22px;
		padding: 14px;
		border: 1px solid var(--border);
		background: var(--surface);
	}
	.game-card--list .cover-wrap {
		width: 60px;
		flex-shrink: 0;
		border-radius: 5px;
	}
	.game-card--list .game-copy {
		flex: 1;
		gap: 4px;
		padding: 0;
	}
	.game-card--list:hover {
		background: var(--surface-hover);
	}
	.game-card--list:hover .cover-wrap {
		transform: none;
	}
	@media (max-width: 600px) {
		.game-card--list {
			gap: 12px;
		}
	}
</style>
