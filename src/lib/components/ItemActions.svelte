<script lang="ts">
	import type { ComponentProps } from 'svelte';

	import Ellipsis from '@lucide/svelte/icons/ellipsis';

	import type Icon from './Icon.svelte';

	import ConfirmDialog from './ConfirmDialog.svelte';
	import ItemActionButton from './ItemActionButton.svelte';
	import NameDialog from './NameDialog.svelte';
	type MenuAction = {
		id: string;
		icon: ComponentProps<typeof Icon>['name'];
		text: string;
		disabled?: boolean;
		onclick: () => void;
	};
	let {
		name,
		disabled = false,
		renameReason = '',
		deleteReason = '',
		onrename,
		onrenamevalue,
		ondelete,
		deleteMessage,
		actions = []
	}: {
		name: string;
		disabled?: boolean;
		renameReason?: string;
		deleteReason?: string;
		onrename?: () => void;
		onrenamevalue?: (name: string) => void | Promise<void>;
		ondelete?: () => void | Promise<void>;
		deleteMessage?: string;
		actions?: readonly MenuAction[];
	} = $props();
	const id = $props.id();
	let left = $state(0);
	let top = $state(0);
	let renaming = $state(false);
	let deleting = $state(false);
	let busy = $state(false);
	let error = $state('');
	async function remove() {
		if (disabled || busy) {
			return;
		}
		busy = true;
		error = '';
		try {
			await ondelete?.();
			deleting = false;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : '삭제하지 못했어요. 다시 시도해주세요.';
		} finally {
			busy = false;
		}
	}
	function position(event: MouseEvent) {
		event.stopPropagation();
		const rect =
			event.currentTarget instanceof HTMLElement
				? event.currentTarget.getBoundingClientRect()
				: null;
		if (rect) {
			left = Math.max(8, Math.min(rect.right - 190, window.innerWidth - 198));
			top = Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 180));
		}
	}
	function choose(action?: () => void) {
		document.getElementById(id)?.hidePopover();
		document.getElementById(`${id}-trigger`)?.focus();
		action?.();
	}
	function fit(event: ToggleEvent) {
		if (event.newState !== 'open') {
			return;
		}
		const menu = event.currentTarget as HTMLElement;
		top = Math.max(8, Math.min(top, window.innerHeight - menu.offsetHeight - 8));
		menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
	}
</script>

<button
	id={`${id}-trigger`}
	class="trigger"
	type="button"
	aria-label={`${name} 작업`}
	title="항목 작업"
	popovertarget={id}
	{disabled}
	onclick={position}><Ellipsis size={16} /></button
>
<div
	class="item-actions"
	{id}
	popover="auto"
	role="group"
	aria-label={`${name} 작업 목록`}
	ontoggle={fit}
	style:left={`${left}px`}
	style:top={`${top}px`}
>
	{#if onrename || onrenamevalue}<ItemActionButton
			action="rename"
			label={`${name} 이름 변경`}
			disabled={disabled || !!renameReason}
			onclick={() => choose(onrenamevalue ? () => (renaming = true) : onrename)}
		/>{/if}
	{#if renameReason}<small>{renameReason}</small>{/if}
	{#if ondelete}<ItemActionButton
			action="delete"
			label={`${name} 삭제`}
			disabled={disabled || !!deleteReason}
			onclick={() =>
				choose(
					deleteMessage
						? () => {
								error = '';
								deleting = true;
							}
						: ondelete
				)}
		/>{/if}
	{#if deleteReason}<small>{deleteReason}</small>{/if}
	{#each actions as action (action.id)}
		<ItemActionButton
			icon={action.icon}
			text={action.text}
			label={`${name} ${action.text}`}
			disabled={disabled || action.disabled}
			onclick={() => choose(action.onclick)}
		/>
	{/each}
</div>
{#if renaming && onrenamevalue}<NameDialog
		{name}
		{disabled}
		onconfirm={onrenamevalue}
		oncancel={() => (renaming = false)}
	/>{/if}
{#if deleting}<ConfirmDialog
		title="삭제 확인"
		message={deleteMessage ?? `‘${name}’을 삭제할까요?`}
		disabled={disabled || busy}
		{error}
		confirmLabel={busy ? '삭제 중…' : '삭제'}
		onconfirm={remove}
		oncancel={() => (deleting = false)}
	/>{/if}

<style>
	.trigger {
		display: inline-grid;
		place-items: center;
		width: 28px;
		height: 28px;
		flex-shrink: 0;
		border: 0;
		border-radius: 4px;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}
	.trigger:hover:not(:disabled) {
		color: var(--text-strong);
		background: var(--surface-active, #ffffff12);
	}
	.trigger:focus-visible {
		outline: 2px solid var(--accent, var(--text));
		outline-offset: -2px;
	}
	.trigger:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.item-actions {
		position: fixed;
		inset: auto;
		margin: 0;
		width: 190px;
		max-width: calc(100vw - 16px);
		max-height: calc(100dvh - 16px);
		overflow-y: auto;
		padding: 5px;
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		background: var(--surface, #2b2b2b);
		color: var(--text);
		box-shadow: 0 8px 26px #0005;
	}
	.item-actions :global(button) {
		width: 100%;
		justify-content: flex-start;
		text-align: left;
	}
	small {
		display: block;
		margin: 0 7px 5px;
		font-size: 10px;
		line-height: 1.4;
		color: var(--text-muted);
	}
</style>
