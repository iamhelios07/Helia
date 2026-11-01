<script lang="ts">
	import GameCover from './GameCover.svelte';
	import { formatLastPlayed, type PreviewGame } from './preview-games';
	let {
		game,
		view,
		onselect
	}: { game: PreviewGame; view: 'grid' | 'list'; onselect: (game: PreviewGame) => void } = $props();
</script>

<button
	class={['game-card', { 'game-card--list': view === 'list' }]}
	type="button"
	aria-label={`${game.title} · 샘플 게임 상세 보기`}
	onclick={() => onselect(game)}
>
	<span class="cover-wrap"><GameCover kind={game.cover} /></span>
	<span class="game-copy"
		><span class="genre">{game.genre}</span><strong>{game.title}</strong><span class="metadata"
			>{formatLastPlayed(game.lastPlayed)}</span
		></span
	>
	<span class="save-count">{game.saves ? `저장 ${game.saves}개` : '새로운 이야기'}</span>
</button>

<style>
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
	.metadata,
	.save-count {
		color: var(--text-muted);
		font-size: 11px;
		line-height: 1.6;
	}
	.save-count {
		margin-top: 2px;
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
	.game-card--list .save-count {
		margin: 0 8px 0 auto;
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
		.game-card--list .save-count {
			display: none;
		}
	}
</style>
