<script lang="ts">
	import { MessageFrame, type MessageAppearance } from './message-frame.js';
	import { hasMessageHTML } from './message-html.js';

	let {
		content,
		html = true,
		appearance,
		onresize
	}: {
		content: string;
		html?: boolean;
		appearance?: MessageAppearance;
		onresize?: (heightChange: number) => void;
	} = $props();
	let failed = $state(false);
	const rich = $derived(html && !failed && hasMessageHTML(content));

	function attachFrame(element: HTMLIFrameElement) {
		const frame = new MessageFrame(
			element,
			() => {
				failed = true;
			},
			(change) => onresize?.(change)
		);
		$effect(() => {
			frame.update(content, appearance);
		});
		return frame.dispose;
	}
</script>

{#if rich}
	<iframe
		class="html-message"
		title="메시지 HTML"
		sandbox="allow-scripts"
		referrerpolicy="no-referrer"
		{@attach attachFrame}
	></iframe>
{:else}
	<div class="plain-message">{content}</div>
{/if}

<style>
	.html-message {
		display: block;
		width: 100%;
		min-width: 0;
		height: 20px;
		border: 0;
		background: transparent;
		color: inherit;
		font: inherit;
	}
	.plain-message {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
</style>
