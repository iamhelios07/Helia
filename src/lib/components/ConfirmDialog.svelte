<script lang="ts">
	let {
		title,
		message,
		confirmLabel = '삭제',
		disabled = false,
		error = '',
		tone = 'danger',
		optionLabel = '',
		onconfirm,
		oncancel
	}: {
		title: string;
		message: string;
		confirmLabel?: string;
		disabled?: boolean;
		error?: string;
		tone?: 'danger' | 'default';
		/** Shows an unchecked checkbox; its state is passed to onconfirm and ignored on cancel. */
		optionLabel?: string;
		onconfirm: (option: boolean) => void;
		oncancel: () => void;
	} = $props();
	const id = $props.id();
	let option = $state(false);
	function open(element: HTMLDialogElement) {
		const previousFocus = document.activeElement;
		element.showModal();
		return () => {
			element.close();
			if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
				previousFocus.focus();
			}
		};
	}
</script>

<dialog
	{@attach open}
	aria-labelledby={`${id}-title`}
	aria-describedby={`${id}-message`}
	oncancel={(event) => {
		event.preventDefault();
		if (!disabled) {
			oncancel();
		}
	}}
>
	<h2 id={`${id}-title`}>{title}</h2>
	<p id={`${id}-message`}>{message}</p>
	{#if optionLabel}<label class="option"
			><input type="checkbox" bind:checked={option} {disabled} /><span>{optionLabel}</span></label
		>{/if}
	{#if error}<p class="error" role="alert">{error}</p>{/if}
	<div class="actions">
		<button type="button" {disabled} onclick={oncancel}>취소</button>
		<button type="button" class={['confirm', tone]} {disabled} onclick={() => onconfirm(option)}
			>{confirmLabel}</button
		>
	</div>
</dialog>

<style>
	dialog {
		width: min(420px, calc(100vw - 32px));
		padding: 24px;
		border: 1px solid var(--border-strong);
		border-radius: 8px;
		background: var(--surface, #2b2b2b);
		color: var(--text);
		box-shadow: 0 20px 70px #0006;
	}
	dialog::backdrop {
		background: #0008;
	}
	h2 {
		margin: 0 0 12px;
		font-size: 17px;
	}
	p {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		color: var(--text-muted);
		font-size: 13px;
		line-height: 1.6;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 24px;
	}
	button {
		padding: 8px 14px;
		border: 1px solid var(--border-strong);
		border-radius: 5px;
		background: transparent;
		color: inherit;
		cursor: pointer;
	}
	button.confirm {
		background: var(--text);
		color: var(--background);
	}
	button.danger {
		background: color-mix(in srgb, var(--danger, #ef9b9b) 15%, transparent);
		border-color: color-mix(in srgb, var(--danger, #ef9b9b) 50%, transparent);
		color: var(--danger, #ef9b9b);
	}
	.error {
		color: var(--danger, #ef9b9b);
	}
	.option {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 16px;
		color: var(--text);
		font-size: 13px;
		cursor: pointer;
	}
	.option input {
		width: 16px;
		height: 16px;
		margin: 0;
		accent-color: var(--text);
	}
	.option input:focus-visible {
		outline: 2px solid var(--text);
		outline-offset: 3px;
	}
	button:focus-visible {
		outline: 2px solid var(--text);
		outline-offset: 3px;
	}
	button:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
