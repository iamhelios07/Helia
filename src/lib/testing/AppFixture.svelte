<script lang="ts">
	import { untrack } from 'svelte';
	import Layout from '../../routes/+layout.svelte';
	import Home from '../../routes/+page.svelte';
	import GameWorkspace from '../games/ui/GameWorkspace.svelte';
	import { useAppSidebarVisibility } from '../app/sidebar.svelte.js';
	import AppFixture from './AppFixture.svelte';

	interface Props {
		view: 'home' | 'game' | 'sidebar';
		gameId?: string;
		/** Internal: this instance is already nested inside the real root layout. */
		contentOnly?: boolean;
	}

	let { view, gameId, contentOnly = false }: Props = $props();
	// The wrapper role is fixed for the lifetime of this component instance.
	const visibility = untrack(() => contentOnly) ? useAppSidebarVisibility() : null;
	let restoreFirst = () => {};
	let restoreSecond = () => {};
</script>

{#if !contentOnly}
	<Layout data={{}} params={gameId ? { id: gameId } : {}}>
		{#key view}
			<AppFixture {view} {gameId} contentOnly />
		{/key}
	</Layout>
{:else if view === 'home'}
	<Home />
{:else if view === 'game' && gameId}
	<GameWorkspace {gameId} />
{:else if view === 'sidebar'}
	<button onclick={() => (restoreFirst = visibility!.hide())}>첫 숨김</button>
	<button onclick={() => (restoreSecond = visibility!.hide())}>두 번째 숨김</button>
	<button onclick={() => restoreFirst()}>첫 복원</button>
	<button onclick={() => restoreSecond()}>두 번째 복원</button>
{/if}
