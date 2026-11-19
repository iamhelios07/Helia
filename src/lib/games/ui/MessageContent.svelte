<script lang="ts">
	import { renderCBS, type CBSContext } from '#lib/games/ai/cbs/index.js';

	import { MessageFrame, type MessageAppearance } from './message-frame.js';
	import { renderMessageContent } from './message-html.js';

	let {
		content,
		html = true,
		appearance,
		onresize,
		context
	}: {
		content: string;
		html?: boolean;
		appearance?: MessageAppearance;
		onresize?: (heightChange: number) => void;
		context?: CBSContext;
	} = $props();
	let failed = $state(false);
	const display = $derived.by(() => {
		try {
			return { text: context ? renderCBS(content, context) : content, error: '' };
		} catch (cause) {
			return {
				text: '',
				error: cause instanceof Error ? cause.message : '메시지를 표시하지 못했어요.'
			};
		}
	});
	const rendered = $derived(html && !failed ? renderMessageContent(display.text) : null);
	const rich = $derived(rendered?.rich ?? false);

	function attachFrame(element: HTMLIFrameElement) {
		const frame = new MessageFrame(
			element,
			() => {
				failed = true;
			},
			(change) => onresize?.(change)
		);
		$effect(() => {
			frame.update(rendered?.html ?? '', appearance);
		});
		return frame.dispose;
	}
</script>

{#if display.error}
	<p class="render-error" role="alert">{display.error}</p>
{:else if rich}
	<iframe
		class="html-message"
		title="메시지 HTML"
		sandbox="allow-scripts"
		referrerpolicy="no-referrer"
		{@attach attachFrame}
	></iframe>
{:else}
	<div class="plain-message">{display.text}</div>
{/if}

<style>
	.render-error {
		color: var(--danger, #ef9b9b);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
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
