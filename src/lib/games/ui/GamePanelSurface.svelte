<script lang="ts">
	import { onMount, type Snippet } from 'svelte';

	import Icon from '#lib/components/Icon.svelte';

	import type { PanelInfo, PanelLayout, PanelView } from './runtime/model.js';

	import { panelDropTarget, type DockEdge, type PanelDrop } from './panel-geometry.js';
	import { PanelMeasurement } from './panel-measurement.js';
	import PanelLayoutNode from './PanelLayoutNode.svelte';
	import {
		CHAT_PANEL_ID,
		addWorkbenchPanels,
		dockWorkbenchPanel,
		loadWorkbenchPreferences,
		reconcileWorkbenchLayout,
		resetWorkbenchPreferences,
		resizeWorkbenchSplit,
		saveWorkbenchPreferences,
		type WorkbenchPreferences
	} from './workbench-preferences.js';
	let {
		gameId,
		panels,
		initialLayout,
		children,
		chat,
		onviews
	}: {
		gameId: string;
		panels: PanelInfo[];
		initialLayout?: PanelLayout;
		children: Snippet;
		chat: Snippet;
		onviews: (views: PanelView[]) => void;
	} = $props();
	let preferences = $state.raw<WorkbenchPreferences | undefined>();
	let hidden = $derived(preferences?.hidden ?? []);
	let visiblePanels = $derived(panels.filter((panel) => !hidden.includes(panel.id)));
	let metadata = $derived([{ id: CHAT_PANEL_ID, title: '채팅' }, ...visiblePanels]);
	let template = $derived(
		addWorkbenchPanels(
			preferences?.tree ?? initialLayout ?? { kind: 'panel', id: CHAT_PANEL_ID },
			panels.map((panel) => panel.id)
		)
	);
	let tree = $derived(
		reconcileWorkbenchLayout(
			template,
			visiblePanels.map((panel) => panel.id)
		)
	);
	let chatRect = $state.raw<PanelView | undefined>();
	let resizing = $state(false);
	let dragging = $state.raw<{
		id: string;
		pointerId: number;
		target: HTMLElement;
		x: number;
		y: number;
		active: boolean;
	} | null>(null);
	let drop = $state.raw<PanelDrop | null>(null);
	onMount(() => {
		preferences = loadWorkbenchPreferences(gameId);
	});
	$effect(() => scheduleMeasure(tree));
	const measurement = new PanelMeasurement((views, chat) => {
		chatRect = chat;
		onviews(views);
	});
	const scheduleMeasure = measurement.scheduleMeasure;
	const attachBody = measurement.attachBody;
	const attachArea = (element: HTMLDivElement) => measurement.attachArea(element, cancelDock);
	function update(nextTree: PanelLayout, nextHidden = hidden, persist = true) {
		preferences = { version: 2, tree: nextTree, hidden: nextHidden };
		if (persist) {
			saveWorkbenchPreferences(gameId, preferences);
		}
		scheduleMeasure();
	}
	function hide(id: string) {
		if (id !== CHAT_PANEL_ID) {
			update(template, [...new Set([...hidden, id])]);
		}
	}
	function reopen(id: string) {
		update(
			template,
			hidden.filter((item) => item !== id)
		);
	}
	function dock(id: string, target: string, edge: DockEdge) {
		update(dockWorkbenchPanel(template, id, target, edge));
	}
	function resize(path: number[], ratio: number, persist: boolean) {
		update(
			resizeWorkbenchSplit(template, path, ratio, [
				CHAT_PANEL_ID,
				...visiblePanels.map((panel) => panel.id)
			]),
			hidden,
			persist
		);
	}
	function reset(event: MouseEvent) {
		(event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open');
		resetWorkbenchPreferences(gameId);
		preferences = undefined;
		scheduleMeasure();
	}
	function startDock(id: string, event: PointerEvent) {
		if (dragging || resizing || !event.isPrimary || event.button !== 0 || !measurement.area) {
			return;
		}
		event.preventDefault();
		const target = event.currentTarget as HTMLElement;
		target.setPointerCapture(event.pointerId);
		dragging = {
			id,
			pointerId: event.pointerId,
			target,
			x: event.clientX,
			y: event.clientY,
			active: false
		};
	}
	function moveDock(event: PointerEvent) {
		if (!dragging || dragging.pointerId !== event.pointerId || !measurement.area) {
			return;
		}
		if (
			!dragging.active &&
			Math.hypot(event.clientX - dragging.x, event.clientY - dragging.y) < 5
		) {
			return;
		}
		if (!dragging.active) {
			dragging = { ...dragging, active: true };
		}
		const bounds = measurement.area.getBoundingClientRect();
		drop = null;
		for (const [id, body] of Object.entries(measurement.bodies)) {
			if (id === dragging.id || !measurement.expectedIds.includes(id)) {
				continue;
			}
			const rect = body.parentElement!.getBoundingClientRect();
			drop = panelDropTarget(rect, bounds, event, id);
			if (drop) {
				break;
			}
		}
	}
	function cancelDock(event?: PointerEvent) {
		if (!dragging || (event && dragging.pointerId !== event.pointerId)) {
			return;
		}
		const previous = dragging;
		dragging = null;
		drop = null;
		if (previous.target.hasPointerCapture(previous.pointerId)) {
			previous.target.releasePointerCapture(previous.pointerId);
		}
	}
	function finishDock(event: PointerEvent) {
		if (!dragging || dragging.pointerId !== event.pointerId) {
			return;
		}
		const source = dragging.id,
			destination = dragging.active ? drop : null;
		cancelDock(event);
		if (destination) {
			dock(source, destination.target, destination.edge);
		}
	}
	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			const menu = (event.target as HTMLElement).closest?.('details');
			if (menu) {
				menu.open = false;
			}
		}
		if (event.key === 'Escape' && dragging) {
			event.preventDefault();
			cancelDock();
		}
	}
</script>

<svelte:window
	onpointermove={moveDock}
	onpointerup={finishDock}
	onpointercancel={cancelDock}
	onkeydown={handleKeydown}
/>
{#snippet layoutMenu()}
	<details class="layout-menu">
		<summary aria-label="워크벤치 배치" title="워크벤치 배치"
			><Icon name="grid" size={14} /></summary
		>
		<div class="menu-card">
			{#each panels.filter((panel) => hidden.includes(panel.id)) as panel (panel.id)}<button
					type="button"
					onclick={(event) => {
						event.currentTarget.closest('details')?.removeAttribute('open');
						reopen(panel.id);
					}}>{panel.title} 패널 열기</button
				>{/each}
			<button type="button" onclick={reset}>기본 배치로 복원</button>
		</div>
	</details>
{/snippet}
<div class={['panel-surface', { interacting: dragging !== null || resizing }]} {@attach attachArea}>
	<div class="frame">{@render children()}</div>
	<div
		class="chat-host"
		style:left={`${chatRect?.x ?? 0}px`}
		style:top={`${chatRect?.y ?? 0}px`}
		style:width={`${chatRect?.width ?? 0}px`}
		style:height={`${chatRect?.height ?? 0}px`}
		style:visibility={chatRect ? 'visible' : 'hidden'}
	>
		{@render chat()}
	</div>
	<div class="overlay">
		<PanelLayoutNode
			node={tree}
			panels={metadata}
			onhide={hide}
			onratio={resize}
			onbody={attachBody}
			ondragstart={startDock}
			onresizing={(active) => (resizing = active)}
			globalMenu={layoutMenu}
		/>
	</div>
	{#if dragging || resizing}<div class="interaction-shield" aria-hidden="true"></div>{/if}
	{#if dragging?.active}
		{#if drop}<div
				class="drop-preview"
				data-drop-edge={drop.edge}
				style:left={`${drop.x}px`}
				style:top={`${drop.y}px`}
				style:width={`${drop.width}px`}
				style:height={`${drop.height}px`}
			></div>{/if}
		<div class="dock-hint" role="status">
			{drop
				? `${metadata.find((panel) => panel.id === drop?.target)?.title ?? ''} · ${{ left: '왼쪽', right: '오른쪽', top: '위', bottom: '아래' }[drop.edge]}`
				: '다른 패널의 가장자리로 이동'} · Esc 취소
		</div>
	{/if}
</div>

<style>
	.panel-surface {
		flex: 1;
		min-width: 0;
		min-height: 0;
		position: relative;
		isolation: isolate;
		overflow: hidden;
		background: var(--background);
	}
	.frame {
		position: absolute;
		inset: 0;
		z-index: 0;
	}
	.frame :global(iframe) {
		display: block;
		width: 100%;
		height: 100%;
		border: 0;
	}
	.chat-host {
		position: absolute;
		z-index: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
		background: var(--background);
		overflow: hidden;
	}
	.overlay {
		position: absolute;
		inset: 0;
		z-index: 2;
		display: flex;
		pointer-events: none;
	}
	.interaction-shield {
		position: absolute;
		inset: 0;
		z-index: 3;
		cursor: grabbing;
	}
	.interacting {
		user-select: none;
	}
	.drop-preview {
		position: absolute;
		z-index: 4;
		pointer-events: none;
		border: 2px solid #7298d0;
		background: #7298d035;
		border-radius: 3px;
	}
	.dock-hint {
		position: absolute;
		bottom: 10px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 4;
		pointer-events: none;
		white-space: nowrap;
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: 5px;
		padding: 6px 10px;
		font-size: 12px;
		color: var(--text);
	}
	.layout-menu {
		position: relative;
		pointer-events: auto;
	}
	summary {
		list-style: none;
		display: grid;
		place-items: center;
		width: 25px;
		height: 25px;
		cursor: pointer;
		color: var(--text-muted);
		border-radius: 4px;
	}
	summary::-webkit-details-marker {
		display: none;
	}
	summary:hover {
		background: var(--surface-hover);
		color: var(--text);
	}
	.menu-card {
		position: absolute;
		right: 0;
		top: 29px;
		z-index: 5;
		display: flex;
		flex-direction: column;
		gap: 3px;
		min-width: 180px;
		padding: 5px;
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		box-shadow: 0 5px 18px #0003;
	}
	button {
		text-align: left;
		white-space: nowrap;
		border: 0;
		border-radius: 3px;
		padding: 7px 9px;
		color: var(--text);
		background: transparent;
		font: inherit;
		font-size: 12px;
	}
	button:hover {
		background: var(--surface-hover);
	}
</style>
