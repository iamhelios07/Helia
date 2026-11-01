<script lang="ts">
	import { version } from '../../package.json';
	import Icon from '#lib/components/Icon.svelte';
	import AppSidebar from '#lib/home/AppSidebar.svelte';
	import GameCard from '#lib/home/GameCard.svelte';
	import GameCover from '#lib/home/GameCover.svelte';
	import { previewGames, type PreviewGame } from '#lib/home/preview-games.js';

	let search = $state('');
	let sort = $state<'recent' | 'name'>('recent');
	let view = $state<'grid' | 'list'>('grid');
	let showSamples = $state(true);
	let selectedGame = $state<PreviewGame | null>(null);
	let activeDialog = $state<'add' | 'game' | 'about' | null>(null);

	const recentGames = previewGames.filter((game) => game.lastPlayed);
	let visibleGames = $derived.by(() => {
		const query = search.trim().toLocaleLowerCase('ko-KR');
		const games = showSamples
			? previewGames.filter((game) =>
					`${game.title} ${game.genre}`.toLocaleLowerCase('ko-KR').includes(query)
				)
			: [];
		return [...games].sort((a, b) =>
			sort === 'name'
				? a.title.localeCompare(b.title, 'ko-KR')
				: (b.lastPlayed ?? '').localeCompare(a.lastPlayed ?? '')
		);
	});

	function goHome() {
		search = '';
		window.scrollTo({ top: 0 });
	}

	function selectGame(game: PreviewGame) {
		selectedGame = game;
		activeDialog = 'game';
	}

	function openModal(dialog: HTMLDialogElement) {
		dialog.showModal();
		return () => dialog.close();
	}
</script>

<svelte:head>
	<title>Helia · 내 게임</title>
	<meta name="description" content="당신만의 세계, 당신만의 이야기. Helia 게임 라이브러리." />
</svelte:head>

<a class="skip-link" href="#library">게임 목록으로 건너뛰기</a>

<AppSidebar
	games={showSamples ? recentGames : []}
	onhome={goHome}
	onadd={() => (activeDialog = 'add')}
	onselect={selectGame}
	onabout={() => (activeDialog = 'about')}
/>

<main>
	<div class="content">
		<header class="welcome">
			<div class="wordmark">
				<Icon name="sun" size={36} />
				<h1>Helia</h1>
			</div>
			<p class="tagline">당신만의 세계, 당신만의 이야기.</p>
			<button
				class="version"
				type="button"
				onclick={() => (activeDialog = 'about')}
				aria-label={`Helia 버전 ${version} 정보`}
				>v{version}<Icon name="chevron" size={12} /></button
			>
		</header>

		<section class="library" id="library" aria-labelledby="library-heading" tabindex="-1">
			<div class="library-heading">
				<div class="heading-copy">
					<h2 id="library-heading">내 게임</h2>
					<span class="count">{showSamples ? previewGames.length : 0}</span>
				</div>
				<div class="sample-control">
					<span>샘플 라이브러리</span><button
						type="button"
						onclick={() => {
							showSamples = !showSamples;
							search = '';
						}}
						aria-pressed={showSamples}>{showSamples ? '샘플 숨기기' : '샘플 보기'}</button
					>
				</div>
			</div>

			<div class="toolbar">
				<label class="search"
					><Icon name="search" size={17} /><input
						type="search"
						bind:value={search}
						placeholder="게임 검색"
						aria-label="게임 검색"
					/></label
				>
				<div class="toolbar-actions">
					<label class="sort"
						><Icon name="sort" size={15} /><span class="sr-only">게임 정렬</span><select
							bind:value={sort}
							><option value="recent">최근 플레이순</option><option value="name">이름순</option
							></select
						><Icon name="chevron" size={13} /></label
					>
					<div class="view-switch" role="group" aria-label="목록 보기 방식">
						<button
							class={{ selected: view === 'grid' }}
							type="button"
							title="카드 보기"
							aria-label="카드 보기"
							aria-pressed={view === 'grid'}
							onclick={() => (view = 'grid')}><Icon name="grid" size={16} /></button
						>
						<button
							class={{ selected: view === 'list' }}
							type="button"
							title="목록 보기"
							aria-label="목록 보기"
							aria-pressed={view === 'list'}
							onclick={() => (view = 'list')}><Icon name="list" size={17} /></button
						>
					</div>
					<button class="add-button" type="button" onclick={() => (activeDialog = 'add')}
						><Icon name="plus" size={17} /><span>게임 추가</span></button
					>
				</div>
			</div>

			{#if visibleGames.length}
				<ul class={['game-grid', { 'game-list': view === 'list' }]} aria-label="게임 목록">
					{#each visibleGames as game (game.id)}
						<li><GameCard {game} {view} onselect={selectGame} /></li>
					{/each}
					{#if !search.trim()}
						<li>
							<button
								class={['add-tile', { 'add-tile--list': view === 'list' }]}
								type="button"
								onclick={() => (activeDialog = 'add')}
								><span class="add-tile-icon"><Icon name="plus" size={24} /></span><span
									>새로운 이야기 추가</span
								></button
							>
						</li>
					{/if}
				</ul>
			{:else}
				<div class="empty-state">
					<span class="empty-icon"
						><Icon name={search.trim() ? 'search' : 'folder'} size={30} /></span
					>
					<h3>{search.trim() ? '검색 결과가 없어요' : '첫 번째 이야기를 기다리고 있어요'}</h3>
					<p>
						{search.trim()
							? '다른 이름이나 장르로 검색해보세요.'
							: '게임을 추가하고 나만의 라이브러리를 채워보세요.'}
					</p>
					{#if search.trim()}
						<button class="secondary-button" type="button" onclick={() => (search = '')}
							>검색 초기화</button
						>
					{:else}
						<button class="secondary-button" type="button" onclick={() => (activeDialog = 'add')}
							><Icon name="plus" size={16} />게임 추가</button
						>
					{/if}
				</div>
			{/if}

			<footer class="library-footer">
				<span>모든 이야기는 하나의 선택에서 시작됩니다.</span><span>HELIA</span>
			</footer>
		</section>
	</div>
</main>

{#if activeDialog === 'add'}
	<dialog {@attach openModal} onclose={() => (activeDialog = null)} aria-labelledby="add-heading">
		<div class="dialog-heading">
			<h2 id="add-heading">새로운 이야기 추가</h2>
			<button
				class="close-button"
				type="button"
				aria-label="닫기"
				onclick={() => (activeDialog = null)}><Icon name="close" /></button
			>
		</div>
		<p class="dialog-description">게임을 만드는 방법과 가져오기 기능을 준비하고 있어요.</p>
		<div class="add-options">
			<button type="button" disabled
				><Icon name="edit" size={25} /><strong>새 게임 만들기</strong><span
					>나만의 세계와 이야기를 만들어보세요.</span
				><small>준비 중</small></button
			>
			<button type="button" disabled
				><Icon name="import" size={25} /><strong>게임 가져오기</strong><span
					>가지고 있는 게임을 라이브러리에 추가해요.</span
				><small>준비 중</small></button
			>
		</div>
	</dialog>
{/if}

{#if activeDialog === 'game'}
	<dialog
		class="details-dialog"
		{@attach openModal}
		onclose={() => (activeDialog = null)}
		aria-labelledby="game-heading"
	>
		{#if selectedGame}
			<div class="dialog-heading">
				<span class="sample-badge">샘플 게임</span><button
					class="close-button"
					type="button"
					aria-label="닫기"
					onclick={() => (activeDialog = null)}><Icon name="close" /></button
				>
			</div>
			<div class="game-details">
				<div class="detail-cover"><GameCover kind={selectedGame.cover} /></div>
				<div class="detail-copy">
					<span class="detail-genre">{selectedGame.genre}</span>
					<h2 id="game-heading">{selectedGame.title}</h2>
					<p>{selectedGame.description}</p>
					<p class="sample-notice">
						라이브러리를 둘러보기 위한 샘플 게임입니다.<br />실제 플레이는 아직 지원하지 않습니다.
					</p>
					<button class="secondary-button" type="button" disabled>플레이 준비 중</button>
				</div>
			</div>
		{/if}
	</dialog>
{/if}

{#if activeDialog === 'about'}
	<dialog
		class="about-dialog"
		{@attach openModal}
		onclose={() => (activeDialog = null)}
		aria-labelledby="about-heading"
	>
		<div class="dialog-heading">
			<span></span><button
				class="close-button"
				type="button"
				aria-label="닫기"
				onclick={() => (activeDialog = null)}><Icon name="close" /></button
			>
		</div>
		<div class="about-content">
			<Icon name="sun" size={44} />
			<h2 id="about-heading">Helia</h2>
			<span class="sample-badge">v{version}</span>
			<p>당신만의 세계, 당신만의 이야기.</p>
			<span class="about-caption">AI roleplay gaming client</span>
		</div>
	</dialog>
{/if}

<style>
	.skip-link {
		position: fixed;
		top: 12px;
		left: 88px;
		z-index: 30;
		padding: 12px 18px;
		transform: translateY(-150%);
		border-radius: 8px;
		background: var(--accent);
		color: var(--on-accent);
	}
	.skip-link:focus {
		transform: translateY(0);
	}
	main {
		min-height: 100dvh;
		margin-left: var(--rail-width);
		padding: 0 48px;
	}
	.content {
		width: 100%;
		max-width: 1120px;
		margin: 0 auto;
	}
	.welcome {
		display: flex;
		min-height: 190px;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 28px 0;
	}
	.wordmark {
		display: flex;
		align-items: center;
		gap: 12px;
		color: var(--text-strong);
	}
	h1 {
		margin: 0;
		font-size: 40px;
		font-weight: 550;
		letter-spacing: -2.4px;
		line-height: 1.2;
	}
	.tagline {
		margin: 12px 0 10px;
		color: var(--text-muted);
		font-size: 13px;
		letter-spacing: 0.02em;
	}
	.version {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px 9px;
		border: 1px solid var(--border);
		border-radius: 5px;
		background: transparent;
		color: var(--text-muted);
		font-size: 10px;
		letter-spacing: 0.04em;
	}
	.version:hover {
		background: var(--surface-hover);
		color: var(--text-strong);
	}
	.library {
		min-width: 0;
		padding: 30px 0 24px;
		border-top: 1px solid var(--border-strong);
	}
	.library:focus {
		outline: none;
	}
	.library-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 26px;
	}
	.heading-copy {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	h2 {
		margin: 0;
		color: var(--text-strong);
		font-size: 17px;
		font-weight: 550;
		letter-spacing: -0.03em;
	}
	.count {
		display: grid;
		min-width: 22px;
		height: 22px;
		place-items: center;
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--text-muted);
		font-size: 11px;
	}
	.sample-control {
		display: flex;
		align-items: center;
		gap: 12px;
		color: var(--text-muted);
		font-size: 11px;
	}
	.sample-control button {
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--text);
		font-size: 11px;
		text-decoration: underline;
		text-underline-offset: 4px;
		text-decoration-color: var(--border-strong);
	}
	.sample-control button:hover {
		color: var(--text-strong);
	}
	.toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 26px;
	}
	.search {
		display: flex;
		width: 242px;
		min-width: 130px;
		height: 38px;
		align-items: center;
		gap: 9px;
		padding: 0 12px;
		border: 1px solid var(--border);
		border-radius: 7px;
		color: var(--text-muted);
	}
	.search:focus-within {
		border-color: var(--text-muted);
	}
	.search input {
		width: 100%;
		min-width: 0;
		height: 100%;
		padding: 0;
		border: 0;
		outline: none;
		background: transparent;
		color: var(--text-strong);
		font-size: 12px;
	}
	.search input::placeholder {
		color: var(--text-muted);
	}
	.toolbar-actions {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.sort {
		position: relative;
		display: flex;
		height: 38px;
		align-items: center;
		gap: 8px;
		padding: 0 10px;
		color: var(--text-muted);
	}
	.sort select {
		width: 112px;
		height: 100%;
		padding: 0 18px 0 0;
		appearance: none;
		border: 0;
		background: transparent;
		color: var(--text);
		cursor: pointer;
		font-size: 12px;
	}
	.sort option {
		background: var(--background);
		color: var(--text);
	}
	.sort > :global(svg:last-child) {
		position: absolute;
		right: 12px;
		pointer-events: none;
	}
	.view-switch {
		display: flex;
		height: 36px;
		align-items: center;
		gap: 2px;
		padding: 3px;
		border: 1px solid var(--border);
		border-radius: 7px;
	}
	.view-switch button {
		display: grid;
		width: 30px;
		height: 28px;
		place-items: center;
		padding: 0;
		border: 0;
		border-radius: 4px;
		background: transparent;
		color: var(--text-muted);
	}
	.view-switch button.selected {
		background: var(--surface-active);
		color: var(--text-strong);
	}
	.view-switch button:hover {
		color: var(--text-strong);
	}
	.add-button {
		display: flex;
		height: 36px;
		flex-shrink: 0;
		align-items: center;
		justify-content: center;
		gap: 7px;
		padding: 0 13px;
		border: 1px solid var(--accent);
		border-radius: 7px;
		background: var(--accent);
		color: var(--on-accent);
		font-size: 12px;
		font-weight: 600;
	}
	.add-button:hover {
		background: var(--palette-silver);
		border-color: var(--palette-silver);
	}
	.game-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
		gap: 28px 22px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.game-grid > li {
		min-width: 0;
	}
	.game-list {
		grid-template-columns: 1fr;
		gap: 12px;
	}
	.add-tile {
		display: flex;
		width: 100%;
		aspect-ratio: 3 / 4;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 16px;
		padding: 16px;
		border: 1px dashed var(--border-strong);
		border-radius: 9px;
		background: transparent;
		color: var(--text-muted);
		font-size: 12px;
		transition:
			background 150ms,
			border-color 150ms;
	}
	.add-tile-icon {
		display: grid;
		width: 46px;
		height: 46px;
		place-items: center;
		border: 1px solid var(--border);
		border-radius: 50%;
	}
	.add-tile:hover {
		border-color: var(--text-muted);
		background: var(--surface);
		color: var(--text-strong);
	}
	.add-tile--list {
		height: 80px;
		aspect-ratio: auto;
		flex-direction: row;
		gap: 12px;
	}
	.add-tile--list .add-tile-icon {
		width: 30px;
		height: 30px;
		border: 0;
	}
	.library-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		margin-top: 52px;
		padding-top: 20px;
		border-top: 1px solid var(--border);
		color: var(--text-muted);
		font-size: 10px;
		line-height: 1.6;
	}
	.library-footer > :last-child {
		font-size: 9px;
		letter-spacing: 0.2em;
	}
	.empty-state {
		display: flex;
		min-height: 340px;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 40px 16px;
		text-align: center;
	}
	.empty-icon {
		display: grid;
		width: 76px;
		height: 76px;
		place-items: center;
		margin-bottom: 24px;
		border: 1px solid var(--border);
		border-radius: 22px;
		background: var(--surface);
		color: var(--text-muted);
	}
	.empty-state h3 {
		margin: 0 0 12px;
		color: var(--text-strong);
		font-size: 17px;
		font-weight: 500;
	}
	.empty-state p {
		margin: 0 0 26px;
		color: var(--text-muted);
		font-size: 12px;
		line-height: 1.8;
	}
	.secondary-button {
		display: inline-flex;
		min-height: 38px;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: 8px 14px;
		border: 1px solid var(--border-strong);
		border-radius: 7px;
		background: var(--surface-hover);
		color: var(--text-strong);
		font-size: 12px;
	}
	.secondary-button:hover:not(:disabled) {
		background: var(--surface-active);
	}
	.secondary-button:disabled {
		color: var(--text-muted);
	}
	dialog {
		width: min(530px, calc(100vw - 40px));
		max-height: calc(100dvh - 40px);
		padding: 26px;
		border: 1px solid var(--border-strong);
		border-radius: 16px;
		background: var(--background);
		color: var(--text);
	}
	dialog::backdrop {
		background: color-mix(in srgb, var(--palette-pepper) 80%, transparent);
		backdrop-filter: blur(6px);
	}
	.dialog-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
	}
	.close-button {
		display: grid;
		width: 30px;
		height: 30px;
		place-items: center;
		padding: 0;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--text-muted);
	}
	.close-button:hover {
		background: var(--surface-hover);
		color: var(--text-strong);
	}
	.dialog-description {
		margin: 14px 0 24px;
		color: var(--text-muted);
		font-size: 12px;
		line-height: 1.8;
	}
	.add-options {
		display: grid;
		gap: 12px;
	}
	.add-options button {
		display: grid;
		grid-template-columns: 32px 1fr auto;
		align-items: center;
		gap: 8px 14px;
		padding: 20px;
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--surface);
		text-align: left;
	}
	.add-options button > :global(svg) {
		grid-row: span 2;
		color: var(--text-muted);
	}
	.add-options strong {
		color: var(--text);
		font-size: 13px;
		font-weight: 500;
	}
	.add-options span {
		grid-column: 2;
		color: var(--text-muted);
		font-size: 11px;
		line-height: 1.6;
	}
	.add-options small {
		grid-column: 3;
		grid-row: 1 / span 2;
		color: var(--text-muted);
		font-size: 10px;
	}
	.details-dialog {
		width: min(620px, calc(100vw - 40px));
	}
	.sample-badge {
		display: inline-block;
		padding: 5px 8px;
		border: 1px solid var(--border-strong);
		border-radius: 5px;
		color: var(--text-muted);
		font-size: 10px;
	}
	.game-details {
		display: flex;
		align-items: center;
		gap: 28px;
		padding-top: 24px;
	}
	.detail-cover {
		width: 190px;
		aspect-ratio: 3 / 4;
		flex-shrink: 0;
		overflow: hidden;
		border: 1px solid var(--border);
		border-radius: 8px;
	}
	.detail-copy {
		min-width: 0;
	}
	.detail-genre {
		color: var(--text-muted);
		font-size: 11px;
	}
	.detail-copy h2 {
		margin: 12px 0 16px;
		font-size: 23px;
		line-height: 1.5;
	}
	.detail-copy p {
		font-size: 12px;
		line-height: 1.9;
	}
	.sample-notice {
		margin: 24px 0 18px;
		color: var(--text-muted);
		font-size: 11px;
	}
	.about-dialog {
		width: min(380px, calc(100vw - 40px));
	}
	.about-content {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 16px;
		padding: 12px 0 36px;
		color: var(--text-strong);
		text-align: center;
	}
	.about-content h2 {
		font-size: 34px;
	}
	.about-content p {
		margin: 8px 0 0;
		color: var(--text);
		font-size: 13px;
	}
	.about-caption {
		color: var(--text-muted);
		font-size: 11px;
	}
	@media (min-width: 1600px) {
		.welcome {
			min-height: 210px;
		}
	}
	@media (max-width: 900px) {
		main {
			padding: 0 28px;
		}
		.toolbar {
			flex-wrap: wrap;
		}
		.search {
			flex: 1;
		}
		.toolbar-actions {
			flex-wrap: wrap;
		}
		.welcome {
			min-height: 180px;
		}
	}
	@media (max-width: 600px) {
		main {
			padding: 0 20px;
		}
		.welcome {
			min-height: 180px;
			padding: 28px 0;
		}
		h1 {
			font-size: 36px;
		}
		.wordmark {
			gap: 12px;
		}
		.tagline {
			font-size: 11px;
		}
		.library {
			padding-top: 24px;
		}
		.library-heading {
			align-items: flex-start;
			margin-bottom: 22px;
		}
		.sample-control {
			flex-direction: column;
			align-items: flex-end;
			gap: 7px;
			font-size: 10px;
		}
		.sample-control button {
			font-size: 10px;
		}
		.toolbar {
			gap: 12px;
			margin-bottom: 22px;
		}
		.search {
			width: 100%;
			flex-basis: 100%;
		}
		.toolbar-actions {
			width: 100%;
			justify-content: space-between;
			gap: 6px;
		}
		.sort {
			gap: 6px;
			padding-left: 0;
		}
		.sort select {
			width: 101px;
			font-size: 11px;
		}
		.view-switch {
			margin-left: auto;
		}
		.add-button {
			width: 34px;
			height: 34px;
			padding: 0;
		}
		.add-button span {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip-path: inset(50%);
		}
		.game-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 26px 14px;
		}
		.game-list {
			grid-template-columns: 1fr;
		}
		.add-tile {
			font-size: 10px;
		}
		.library-footer {
			align-items: flex-start;
			margin-top: 36px;
			font-size: 9px;
		}
		.library-footer > :last-child {
			display: none;
		}
		.game-details {
			flex-direction: column;
			gap: 22px;
		}
		.detail-cover {
			width: 150px;
		}
		.detail-copy {
			width: 100%;
		}
		.detail-copy h2 {
			font-size: 21px;
		}
		.add-options button {
			grid-template-columns: 25px 1fr;
			padding: 16px;
		}
		.add-options small {
			grid-column: 2;
			grid-row: 3;
		}
	}
</style>
