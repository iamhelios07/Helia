<script lang="ts">
	import type { Snippet } from 'svelte';

	import { page } from '$app/state';

	import GameEditor from '#lib/games/ui/GameEditor.svelte';

	let { children }: { children: Snippet } = $props();
</script>

{#key page.params.id}
	<GameEditor gameId={page.params.id ?? ''} documentRoute={page.params.document ?? ''} />
{/key}
{@render children()}
