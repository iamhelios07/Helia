<script lang="ts">
	import { untrack } from 'svelte';

	import type { Game, Session } from '#lib/games/model.js';

	import { AppSidebarController, provideAppSidebar } from '#lib/app/sidebar.svelte.js';
	import GameSessionSidebar from '#lib/games/ui/GameSessionSidebar.svelte';
	import { GameWorkspaceController } from '#lib/games/ui/gameworkspace-controller.svelte.js';
	import SessionChat from '#lib/games/ui/SessionChat.svelte';
	let {
		game,
		session,
		onsessionupdate,
		onsavingchange
	}: {
		game: Game;
		session: Session;
		onsessionupdate: (session: Session) => void;
		onsavingchange: (busy: boolean) => void;
	} = $props();
	provideAppSidebar(new AppSidebarController());
	const workspace = new GameWorkspaceController(() => ({ gameId: game.id }));
	workspace.game = untrack(() => game);
	workspace.sessions = [untrack(() => session)];
</script>

<div class="fixture">
	<GameSessionSidebar {workspace} />
	<SessionChat
		gameId={game.id}
		sessionId={session.id}
		gameTitle={game.title}
		oncontroller={workspace.attachChat}
		onsessionupdate={(updated) => {
			workspace.sessions = [updated];
			onsessionupdate(updated);
		}}
		onsavingchange={(busy) => {
			workspace.chatSaving = busy;
			onsavingchange(busy);
		}}
	/>
</div>

<style>
	.fixture {
		display: grid;
		grid-template-columns: 320px minmax(0, 1fr);
		height: 100dvh;
		max-height: 100%;
		min-height: 0;
		width: 100%;
	}
</style>
