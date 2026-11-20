<script lang="ts">
	import { onMount, type Snippet } from 'svelte';

	import { OverlayScrollController } from './overlay-scroll-controller.svelte.js';

	let {
		children,
		label,
		maxHeight,
		edgeOffset = 0,
		viewport = $bindable()
	}: {
		children: Snippet;
		label: string;
		maxHeight?: string;
		edgeOffset?: number;
		viewport?: HTMLDivElement;
	} = $props();
	let content: HTMLDivElement;
	let track: HTMLDivElement;
	const id = $props.id();
	const scroll = new OverlayScrollController();
	onMount(() => scroll.mount(viewport!, content, track));
</script>

<div
	class="scroll-area"
	style:max-height={maxHeight}
	data-active={scroll.active || scroll.dragging}
>
	<!-- svelte-ignore a11y_no_noninteractive_tabindex (The scroll region needs focus for native keyboard scrolling.) -->
	<div {id} class="viewport" role="region" aria-label={label} tabindex="0" bind:this={viewport}>
		<div class="content" bind:this={content}>{@render children()}</div>
	</div>
	<div
		class="track"
		style:inset-inline-end={`${edgeOffset}px`}
		bind:this={track}
		inert={scroll.maximum <= 0}
		aria-hidden={scroll.maximum <= 0}
		role="scrollbar"
		aria-label={`${label} 이동`}
		aria-controls={id}
		aria-orientation="vertical"
		aria-valuemin="0"
		aria-valuemax={Math.round(scroll.maximum)}
		aria-valuenow={Math.round(scroll.position)}
		tabindex={scroll.maximum > 0 ? 0 : -1}
		onkeydown={scroll.keydown}
		onpointerdown={scroll.startDrag}
		onpointermove={scroll.moveDrag}
		onpointerup={scroll.endDrag}
		onpointercancel={scroll.endDrag}
		onlostpointercapture={scroll.endDrag}
	>
		<div
			class="thumb"
			style:height={`${scroll.thumbSize}px`}
			style:transform={`translateY(${scroll.thumbOffset}px)`}
		></div>
	</div>
</div>

<style>
	.scroll-area {
		position: relative;
		display: flex;
		flex: 1 1 auto;
		min-width: 0;
		min-height: 0;
	}
	.viewport {
		flex: 1;
		min-width: 0;
		min-height: 0;
		overflow: auto;
		scrollbar-width: none;
		scrollbar-gutter: auto;
	}
	.viewport::-webkit-scrollbar {
		display: none;
	}
	.content {
		min-width: 0;
		display: flow-root;
	}
	.track {
		position: absolute;
		inset-block: 2px;
		z-index: 2;
		width: 12px;
		opacity: 0;
		pointer-events: none;
		touch-action: none;
		user-select: none;
		transition: opacity 120ms;
	}
	.track[inert] {
		/* Keep geometry measurable when content first becomes scrollable. */
		visibility: hidden;
	}
	.thumb {
		position: absolute;
		inset-inline-end: 2px;
		width: 5px;
		border-radius: 6px;
		background: var(--text-muted);
		opacity: 0.65;
	}
	.scroll-area[data-active='true'] > .track,
	.scroll-area:focus-within > .track {
		opacity: 1;
		pointer-events: auto;
	}
	.track:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}
	.track:hover .thumb,
	.track:focus-visible .thumb {
		width: 7px;
		opacity: 1;
	}
	@media (hover: hover) {
		.scroll-area:hover > .track {
			opacity: 1;
			pointer-events: auto;
		}
	}
	@media (forced-colors: active) {
		.viewport {
			scrollbar-width: auto;
		}
		.viewport::-webkit-scrollbar {
			display: block;
		}
		.track {
			display: none;
		}
	}
</style>
