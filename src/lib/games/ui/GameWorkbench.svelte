<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import { isSessionBusy } from '#lib/games/ai/activity.js';
	import type { GameUI, PanelInfo, PanelView, PanelLayout } from './runtime/model.js';
	import {
		CHAT_PANEL_ID,
		defaultWorkbenchLayout,
		reconcileWorkbenchLayout
	} from './workbench-preferences.js';
	import { panelIds } from './runtime/layout.js';
	import type { GameUIHandle } from './runtime/bridge.js';
	import GamePanelSurface from './GamePanelSurface.svelte';
	let {
		gameId,
		sessionId,
		ui,
		blocked = false,
		onsavingchange,
		children
	}: {
		gameId: string;
		sessionId: string;
		ui?: GameUI;
		blocked?: boolean;
		onsavingchange: (busy: boolean) => void;
		children: Snippet<[GameUI['chatStyle']]>;
	} = $props();
	const initialUI = untrack(() => ui);
	let currentUI = $state.raw<GameUI | undefined>(initialUI);
	let loading = $state(true);
	let error = $state('');
	let attempt = $state(0);
	let panels = $state.raw<PanelInfo[]>([]);
	let defaultTree = $state.raw<PanelLayout | undefined>();
	let runtimeHandle: GameUIHandle | undefined;
	let latestViews: PanelView[] = [];
	function attachFrame(frame: HTMLIFrameElement) {
		let alive = true;
		let dispose: GameUIHandle | undefined;
		const game = untrack(() => gameId);
		const session = untrack(() => sessionId);
		async function mount() {
			try {
				const { mountGameUI } = await import('./runtime/bridge.js');
				if (!alive) return;
				const cleanup = await mountGameUI(frame, game, session, {
					blocked: () => !alive || blocked || isSessionBusy(game, session),
					oncontentchange: () => {
						if (alive) reload();
					},
					onpanels: (nextPanels) => {
						if (!alive) return;
						if (nextPanels.length) {
							defaultTree = defaultTree
								? reconcileWorkbenchLayout(defaultTree, [
										...new Set([
											...panelIds(defaultTree).filter((id) => id !== CHAT_PANEL_ID),
											...nextPanels.map((panel) => panel.id)
										])
									])
								: defaultWorkbenchLayout(
										currentUI,
										nextPanels.map((panel) => panel.id)
									);
						}
						panels = nextPanels;
					},
					onbusy: (busy) => {
						if (alive) onsavingchange(busy);
					},
					onui: (snapshotUI) => {
						if (!alive) return;
						currentUI = snapshotUI;
					},
					onready: () => {
						if (alive) loading = false;
					},
					onerror: () => {
						if (alive) {
							loading = false;
							error = '게임 화면을 불러오지 못했어요. 채팅은 계속 이용할 수 있어요.';
						}
					}
				});
				if (alive) {
					dispose = cleanup;
					runtimeHandle = cleanup;
					cleanup.setViews(latestViews);
				} else cleanup();
			} catch {
				if (alive) {
					loading = false;
					error = '게임 화면을 불러오지 못했어요. 채팅은 계속 이용할 수 있어요.';
				}
			}
		}
		void mount();
		return () => {
			alive = false;
			dispose?.();
			if (runtimeHandle === dispose) runtimeHandle = undefined;
			onsavingchange(false);
		};
	}

	function updateViews(views: PanelView[]) {
		latestViews = views;
		runtimeHandle?.setViews(views);
	}
	function reload() {
		loading = true;
		error = '';
		panels = [];
		defaultTree = undefined;
		latestViews = [];
		runtimeHandle = undefined;
		attempt += 1;
	}
</script>

<div class="workbench" aria-label="게임 워크벤치">
	<GamePanelSurface {gameId} {panels} initialLayout={defaultTree} onviews={updateViews}>
		{#snippet chat()}{@render children(currentUI?.chatStyle)}{/snippet}
		{#key attempt}<iframe
				title="게임 패널"
				hidden={!currentUI}
				sandbox="allow-scripts"
				referrerpolicy="no-referrer"
				{@attach attachFrame}
			></iframe>{/key}
	</GamePanelSurface>
	{#if loading}<p class="status" role="status">게임 화면을 불러오는 중…</p>{/if}
	{#if error}<div class="error">
			<p role="alert">{error}</p>
			<button type="button" onclick={reload}>다시 불러오기</button>
		</div>{/if}
</div>

<style>
	.workbench {
		position: relative;
		display: flex;
		flex: 1;
		min-width: 0;
		min-height: 0;
	}
	iframe {
		display: block;
		width: 100%;
		height: 100%;
		border: 0;
		background: var(--background);
	}
	iframe[hidden] {
		display: none;
	}
	.status,
	.error {
		position: absolute;
		bottom: 8px;
		right: 8px;
		z-index: 5;
		max-width: min(420px, 90%);
		padding: 8px 12px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--surface);
		font-size: 12px;
		color: var(--text-muted);
	}
	.status {
		pointer-events: none;
		margin: 0;
	}
	.error p {
		margin: 0 0 8px;
	}
	button {
		font: inherit;
		color: var(--text);
		border: 1px solid var(--border-strong);
		border-radius: 4px;
		background: var(--surface);
		padding: 4px 8px;
	}
</style>
