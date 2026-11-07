<script lang="ts">
	let {
		title,
		message,
		confirmLabel = '삭제',
		disabled = false,
		onconfirm,
		oncancel
	}: {
		title: string;
		message: string;
		confirmLabel?: string;
		disabled?: boolean;
		onconfirm: () => void;
		oncancel: () => void;
	} = $props();
	const id = $props.id();
	function open(element: HTMLDialogElement) {
		element.showModal();
		return () => element.close();
	}
</script>

<dialog
	{@attach open}
	aria-labelledby={`${id}-title`}
	aria-describedby={`${id}-message`}
	oncancel={(event) => {
		event.preventDefault();
		if (!disabled) oncancel();
	}}
>
	<h2 id={`${id}-title`}>{title}</h2>
	<p id={`${id}-message`}>{message}</p>
	<div class="actions">
		<button type="button" {disabled} onclick={oncancel}>취소</button>
		<button type="button" class="confirm" {disabled} onclick={onconfirm}>{confirmLabel}</button>
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
	button:focus-visible {
		outline: 2px solid var(--text);
		outline-offset: 3px;
	}
	button:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
