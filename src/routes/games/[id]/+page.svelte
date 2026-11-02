<script lang="ts">
	import { page } from '$app/state';
	import GameWorkspace from '#lib/games/GameWorkspace.svelte';
</script>

{#key page.params.id}
	<GameWorkspace gameId={page.params.id ?? ''} />
{/key}
