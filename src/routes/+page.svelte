<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { version } from '../../package.json';
	import Icon from '#lib/components/Icon.svelte';
	import { configureAppSidebar } from '#lib/shell/sidebar.svelte.js';
	import GameCard from '#lib/home/GameCard.svelte';
	import { toLibraryGame, type LibraryGame } from '#lib/home/library-games.js';
	import { listGames, createGame } from '#lib/games/repository.js';
	import type { Game } from '#lib/games/model.js';

	let search = $state('');
	let sort = $state<'recent' | 'name'>('recent');
	let view = $state<'grid' | 'list'>('grid');
	let activeDialog = $state<'add' | 'about' | null>(null);
	let creating = $state(false);
	let createError = $state('');
	let navigationError = $state('');
	let savedGames = $state.raw<Game[]>([]);
	let loading = $state(true);
	let loadError = $state('');
	let ready = $derived(!loading && !loadError);
	let libraryGames = $derived(savedGames.map(toLibraryGame));
	configureAppSidebar(() => ({
		games: ready ? libraryGames : undefined,
		activeGameId: null,
		busy: creating,
		onhome: goHome,
		onadd: () => (activeDialog = 'add'),
		onselect: selectGame
	}));

	onMount(() => {
		void loadLibrary();
	});

	async function loadLibrary() {
		loading = true;
		loadError = '';
		try {
			savedGames = await listGames();
		} catch {
			loadError = '저장된 게임을 불러오지 못했어요. 다시 시도해주세요.';
		} finally {
			loading = false;
		}
	}

	async function startGame() {
		if (!ready || creating) return;
		creating = true;
		createError = '';
		let saved: Game;
		try {
			saved = await createGame();
		} catch {
			createError = '게임을 만들지 못했어요. 다시 시도해주세요.';
			return;
		} finally {
			creating = false;
		}
		savedGames = [saved, ...savedGames];
		search = '';
		activeDialog = null;
		await openGame(saved.id);
	}

	async function openGame(id: string) {
		navigationError = '';
		try {
			await goto(resolve('/games/[id]', { id }));
		} catch {
			navigationError =
				'게임 화면을 열지 못했어요. 게임은 저장되어 있으니 목록에서 다시 열어주세요.';
		}
	}

	function closeDialog(dialog: typeof activeDialog) {
		if (!creating && activeDialog === dialog) activeDialog = null;
	}

	let visibleGames = $derived.by(() => {
		const query = search.trim().toLocaleLowerCase('ko-KR');
		const games = libraryGames.filter((game) =>
			`${game.title} ${game.genre}`.toLocaleLowerCase('ko-KR').includes(query)
		);
		return [...games].sort((a, b) =>
			sort === 'name'
				? a.title.localeCompare(b.title, 'ko-KR')
				: b.updatedAt.localeCompare(a.updatedAt)
		);
	});

	function goHome() {
		search = '';
		window.scrollTo({ top: 0 });
	}

	function selectGame(game: LibraryGame) {
		void openGame(game.id);
	}

	function openModal(dialog: HTMLDialogElement) {
		dialog.showModal();
		return () => dialog.close();
	}
</script>

<svelte:head>
	<title>Helia · 내 게임</title>
	<meta name="description" content="Helia 게임 라이브러리" />
</svelte:head>

<a class="skip-link" href="#library">게임 목록으로 건너뛰기</a>

<main>
	<div class="content">
		<header class="welcome">
			<div class="wordmark">
				<Icon name="sun" size={36} />
				<h1>Helia</h1>
			</div>
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
					<span class="count" aria-label="표시된 게임 수">{visibleGames.length}</span>
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
							><option value="recent">최근 활동순</option><option value="name">이름순</option
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

			{#if navigationError}<p class="library-status" role="alert">{navigationError}</p>{/if}
			{#if loading}
				<p class="library-status" role="status">저장된 게임을 불러오는 중…</p>
			{:else if loadError}
				<div class="library-status" role="alert">
					<p>{loadError}</p>
					<button class="secondary-button" type="button" onclick={loadLibrary}>다시 불러오기</button
					>
				</div>
			{/if}

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
									>게임 추가</span
								></button
							>
						</li>
					{/if}
				</ul>
			{:else if ready}
				<div class="empty-state">
					<span class="empty-icon"
						><Icon name={search.trim() ? 'search' : 'folder'} size={30} /></span
					>
					<h3>{search.trim() ? '검색 결과가 없습니다' : '게임이 없습니다'}</h3>
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
		</section>
	</div>
</main>

{#if activeDialog === 'add'}
	<dialog
		{@attach openModal}
		onclose={() => closeDialog('add')}
		oncancel={(event) => {
			if (creating) event.preventDefault();
		}}
		aria-labelledby="add-heading"
		aria-busy={creating}
	>
		<div class="dialog-heading">
			<h2 id="add-heading">게임 추가</h2>
			<button
				class="close-button"
				type="button"
				aria-label="닫기"
				disabled={creating}
				onclick={() => closeDialog('add')}><Icon name="close" /></button
			>
		</div>
		{#if !ready}<p role="status">
				{loading ? '불러오는 중…' : '게임을 불러올 수 없어요.'}
			</p>{/if}
		{#if createError}<p role="alert">{createError}</p>{/if}
		<div class="add-options">
			<button type="button" disabled={!ready || creating} onclick={startGame}
				><Icon name="edit" size={25} /><strong>새 게임 만들기</strong>{#if creating}<small
						role="status">저장 중…</small
					>{/if}</button
			>
			<button type="button" disabled
				><Icon name="import" size={25} /><strong>게임 가져오기</strong><small>준비 중</small
				></button
			>
		</div>
	</dialog>
{/if}

{#if activeDialog === 'about'}
	<dialog
		class="about-dialog"
		{@attach openModal}
		onclose={() => closeDialog('about')}
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
			<span class="version-badge">v{version}</span>
		</div>
	</dialog>
{/if}

<style>
	.library-status {
		margin: 0 0 24px;
		color: var(--text-muted);
		font-size: 13px;
	}
	.add-options button:hover:not(:disabled) {
		border-color: var(--text-muted);
		background: var(--surface-hover);
	}
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
		padding: 0 48px;
	}
	.content {
		width: 100%;
		max-width: 1120px;
		margin: 0 auto;
	}
	.welcome {
		display: flex;
		gap: 12px;
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
	.add-options {
		display: grid;
		gap: 12px;
		margin-top: 24px;
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
		color: var(--text-muted);
	}
	.add-options strong {
		color: var(--text);
		font-size: 13px;
		font-weight: 500;
	}
	.add-options small {
		grid-column: 3;
		color: var(--text-muted);
		font-size: 10px;
	}
	.version-badge {
		display: inline-block;
		padding: 5px 8px;
		border: 1px solid var(--border-strong);
		border-radius: 5px;
		color: var(--text-muted);
		font-size: 10px;
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
		.library {
			padding-top: 24px;
		}
		.library-heading {
			align-items: flex-start;
			margin-bottom: 22px;
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
		.add-options button {
			grid-template-columns: 25px 1fr auto;
			padding: 16px;
		}
	}
</style>
