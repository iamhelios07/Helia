<script lang="ts">
	import type { Snippet } from 'svelte';

	import Icon from '#lib/components/Icon.svelte';

	import type { PanelInfo, PanelLayout } from './runtime/model.js';

	import PanelLayoutNode from './PanelLayoutNode.svelte';
	import { CHAT_PANEL_ID } from './workbench-preferences.js';

	let {
		node,
		panels,
		path = [],
		onhide,
		onratio,
		onbody,
		ondragstart,
		onresizing,
		globalMenu
	}: {
		node: PanelLayout;
		panels: PanelInfo[];
		path?: number[];
		onhide: (id: string) => void;
		onratio: (path: number[], ratio: number, persist: boolean) => void;
		onbody: (id: string, element: HTMLDivElement) => () => void;
		ondragstart: (id: string, event: PointerEvent) => void;
		onresizing: (active: boolean) => void;
		globalMenu: Snippet;
	} = $props();
	let horizontal = $derived(node.kind === 'split' && node.axis === 'horizontal');
	let title = $derived(
		node.kind === 'panel' ? (panels.find((panel) => panel.id === node.id)?.title ?? node.id) : ''
	);
	let container: HTMLDivElement | undefined;
	let drag: { id: number; target: HTMLElement; start: number; ratio: number; size: number } | null =
		null;

	function attachContainer(element: HTMLDivElement) {
		container = element;
		return () => {
			finishResize();
			container = undefined;
		};
	}
	function startResize(event: PointerEvent) {
		if (node.kind !== 'split' || !container || drag || !event.isPrimary || event.button !== 0) {
			return;
		}
		event.preventDefault();
		const target = event.currentTarget as HTMLElement;
		target.setPointerCapture(event.pointerId);
		onresizing(true);
		drag = {
			id: event.pointerId,
			target,
			start: horizontal ? event.clientX : event.clientY,
			ratio: node.ratio,
			size: horizontal ? container.clientWidth : container.clientHeight
		};
	}
	function resize(event: PointerEvent) {
		if (!drag || drag.id !== event.pointerId || !drag.size) {
			return;
		}
		onratio(
			path,
			drag.ratio + ((horizontal ? event.clientX : event.clientY) - drag.start) / drag.size,
			false
		);
	}
	function finishResize(event?: PointerEvent) {
		if (!drag || (event && drag.id !== event.pointerId)) {
			return;
		}
		const previous = drag;
		drag = null;
		onresizing(false);
		if (previous.target.hasPointerCapture(previous.id)) {
			previous.target.releasePointerCapture(previous.id);
		}
		if (node.kind === 'split') {
			onratio(path, node.ratio, true);
		}
	}
	function resizeWithKeyboard(event: KeyboardEvent) {
		if (node.kind !== 'split') {
			return;
		}
		const negative = horizontal ? 'ArrowLeft' : 'ArrowUp';
		const positive = horizontal ? 'ArrowRight' : 'ArrowDown';
		if (![negative, positive, 'Home', 'End'].includes(event.key)) {
			return;
		}
		event.preventDefault();
		let ratio = node.ratio;
		if (event.key === 'Home') {
			ratio = 0.1;
		} else if (event.key === 'End') {
			ratio = 0.9;
		} else {
			ratio += (event.shiftKey ? 0.1 : 0.02) * (event.key === positive ? 1 : -1);
		}
		onratio(path, ratio, true);
	}

	function cancelResize(event: KeyboardEvent) {
		if (event.key !== 'Escape' || !drag || node.kind !== 'split') {
			return;
		}
		event.preventDefault();
		const previous = drag;
		drag = null;
		onratio(path, previous.ratio, false);
		onresizing(false);
		if (previous.target.hasPointerCapture(previous.id)) {
			previous.target.releasePointerCapture(previous.id);
		}
	}
</script>

<svelte:window onkeydown={cancelResize} />
{#if node.kind === 'panel'}
	{@const id = node.id}
	<section class="panel" data-leaf-id={id} aria-label={title + ' 패널'}>
		<header>
			<button
				class="panel-title"
				type="button"
				aria-label={title + ' 패널 이동'}
				title="드래그하여 이동"
				onpointerdown={(event) => ondragstart(id, event)}>{title}</button
			>
			{#if id !== CHAT_PANEL_ID}<button
					class="panel-minimize"
					type="button"
					aria-label={title + ' 패널 최소화'}
					title="최소화"
					onclick={() => onhide(id)}
				>
					<Icon name="minus" size={14} />
				</button>{/if}
			{#if id === CHAT_PANEL_ID}{@render globalMenu()}{/if}
		</header>
		<div class="panel-body" data-panel-body={id} {@attach (element) => onbody(id, element)}></div>
	</section>
{:else}
	<div class={['split', { horizontal }]} style:--ratio={node.ratio} {@attach attachContainer}>
		<div class="first">
			<PanelLayoutNode
				node={node.first}
				{panels}
				path={[...path, 0]}
				{onhide}
				{onratio}
				{onbody}
				{ondragstart}
				{onresizing}
				{globalMenu}
			/>
		</div>
		<div
			class="splitter"
			role="slider"
			tabindex="0"
			aria-label="패널 크기 조절"
			aria-orientation={horizontal ? 'horizontal' : 'vertical'}
			aria-valuemin="10"
			aria-valuemax="90"
			aria-valuenow={Math.round(node.ratio * 100)}
			onpointerdown={startResize}
			onpointermove={resize}
			onpointerup={finishResize}
			onpointercancel={finishResize}
			onlostpointercapture={finishResize}
			onkeydown={resizeWithKeyboard}
		></div>
		<div class="second">
			<PanelLayoutNode
				node={node.second}
				{panels}
				path={[...path, 1]}
				{onhide}
				{onratio}
				{onbody}
				{ondragstart}
				{onresizing}
				{globalMenu}
			/>
		</div>
	</div>
{/if}

<style>
	.panel,
	.split,
	.first,
	.second {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
	}
	.panel {
		position: relative;
		outline: 1px solid var(--border);
		outline-offset: -1px;
	}
	header {
		position: relative;
		display: flex;
		align-items: center;
		gap: 2px;
		flex: 0 0 32px;
		min-width: 0;
		padding: 0 5px;
		background: var(--surface);
		border-bottom: 1px solid var(--border);
		pointer-events: auto;
	}
	.panel-title {
		min-width: 0;
		flex: 1;
		border: 0;
		padding: 4px 5px;
		text-align: left;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font: inherit;
		font-size: 12px;
		font-weight: 550;
		color: var(--text);
		background: transparent;
		cursor: grab;
		touch-action: none;
	}
	.panel-title:active {
		cursor: grabbing;
	}
	.panel-body {
		flex: 1;
		min-height: 0;
		min-width: 0;
		pointer-events: none;
	}
	.split.horizontal {
		flex-direction: row;
	}
	.first {
		flex: var(--ratio) 1 0;
	}
	.second {
		flex: calc(1 - var(--ratio)) 1 0;
	}
	.splitter {
		flex: 0 0 5px;
		background: var(--background);
		pointer-events: auto;
		touch-action: none;
		cursor: row-resize;
	}
	.horizontal > .splitter {
		cursor: col-resize;
	}
	.splitter:hover,
	.splitter:focus-visible {
		background: #7298d0;
	}
	.panel-minimize {
		display: grid;
		place-items: center;
		flex: 0 0 22px;
		width: 22px;
		height: 22px;
		border: 0;
		padding: 0;
		background: transparent;
		color: var(--text-muted);
		border-radius: 4px;
	}
	.panel-minimize:hover {
		background: var(--surface-hover);
		color: var(--text);
	}
</style>
