<script lang="ts">
	import { page } from '$app/state';
	import GameEditor from '#lib/games/ui/GameEditor.svelte';
</script>

{#key page.params.id}
	<GameEditor gameId={page.params.id ?? ''} />
{/key}
