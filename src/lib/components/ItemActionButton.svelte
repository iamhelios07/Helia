<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import type { MouseEventHandler } from 'svelte/elements';

	import Icon from './Icon.svelte';
	type ActionProps =
		| { action: 'rename' | 'delete'; icon?: never; text?: never }
		| { action?: never; icon: ComponentProps<typeof Icon>['name']; text: string };
	let {
		action,
		icon,
		text,
		label,
		disabled = false,
		compact = false,
		onclick
	}: ActionProps & {
		label: string;
		disabled?: boolean;
		compact?: boolean;
		onclick: MouseEventHandler<HTMLButtonElement>;
	} = $props();
</script>

<button
	type="button"
	class={['item-action', action, { compact }]}
	aria-label={label}
	title={label}
	{disabled}
	{onclick}
>
	<Icon name={icon ?? (action === 'rename' ? 'pencil' : 'trash')} size={14} />
	{#if !compact}<span>{text ?? (action === 'rename' ? '이름 변경' : '삭제')}</span>{/if}
</button>

<style>
	.item-action {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		min-height: 28px;
		padding: 4px 8px;
		border: 1px solid transparent;
		border-radius: 4px;
		background: transparent;
		color: var(--text-muted);
		font: inherit;
		font-size: 12px;
		cursor: pointer;
		flex-shrink: 0;
	}
	.compact {
		width: 28px;
		padding: 4px;
	}
	.item-action:hover:not(:disabled) {
		background: var(--surface-active, #ffffff12);
		color: var(--text-strong);
	}
	.delete:hover:not(:disabled) {
		background: color-mix(in srgb, var(--danger, #ef9b9b) 12%, transparent);
		color: var(--danger, #ef9b9b);
	}
	.item-action:focus-visible {
		outline: 2px solid var(--accent, var(--text));
		outline-offset: 2px;
	}
	.item-action:disabled {
		opacity: 0.4;
		cursor: default;
	}
</style>
