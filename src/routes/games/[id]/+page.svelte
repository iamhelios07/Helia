<script lang="ts">
	import { page } from '$app/state';
	import GameWorkspace from '#lib/games/ui/GameWorkspace.svelte';
</script>

{#key page.params.id}
	<GameWorkspace gameId={page.params.id ?? ''} />
{/key}
