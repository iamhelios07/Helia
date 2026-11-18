<script lang="ts">
	import { onDestroy } from 'svelte';
	let {
		title = '이름 변경',
		name,
		label = '이름',
		description = '',
		disabled = false,
		maxlength,
		onconfirm,
		oncancel
	}: {
		title?: string;
		name: string;
		label?: string;
		description?: string;
		disabled?: boolean;
		maxlength?: number;
		onconfirm: (name: string) => void | Promise<void>;
		oncancel: () => void;
	} = $props();
	const id = $props.id();
	let value = $state('');
	let error = $state('');
	let busy = $state(false);
	let locked = $derived(disabled || busy);
	let disposed = false;
	onDestroy(() => {
		disposed = true;
	});
	function open(dialog: HTMLDialogElement) {
		const previousFocus = document.activeElement;
		value = name;
		dialog.showModal();
		const input = dialog.querySelector('input');
		input?.focus();
		input?.select();
		return () => {
			dialog.close();
			if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
				previousFocus.focus();
			}
		};
	}
	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (locked) {
			return;
		}
		busy = true;
		error = '';
		try {
			if (!value.trim()) {
				throw Error('이름을 입력해주세요.');
			}
			await onconfirm(value.trim());
			if (!disposed) {
				oncancel();
			}
		} catch (cause) {
			if (!disposed) {
				error = cause instanceof Error ? cause.message : '저장하지 못했어요. 다시 시도해주세요.';
			}
		} finally {
			if (!disposed) {
				busy = false;
			}
		}
	}
</script>

<dialog
	{@attach open}
	aria-labelledby={`${id}-title`}
	oncancel={(event) => {
		event.preventDefault();
		if (!locked) {
			oncancel();
		}
	}}
>
	<form onsubmit={submit}>
		<h2 id={`${id}-title`}>{title}</h2>
		{#if description}<p id={`${id}-description`}>{description}</p>{/if}
		<label for={`${id}-name`}>{label}</label>
		<input
			id={`${id}-name`}
			bind:value
			{maxlength}
			disabled={locked}
			required
			autocomplete="off"
			aria-describedby={description ? `${id}-description` : undefined}
			aria-invalid={!!error}
		/>
		{#if error}<p role="alert">{error}</p>{/if}
		<footer>
			<button type="button" disabled={locked} onclick={oncancel}>취소</button><button
				class="confirm"
				type="submit"
				disabled={locked}>{busy ? '저장 중…' : '확인'}</button
			>
		</footer>
	</form>
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
	form {
		display: grid;
		gap: 12px;
	}
	h2 {
		margin: 0;
		font-size: 17px;
	}
	p {
		margin: 0;
		color: var(--text-muted);
		font-size: 12px;
		line-height: 1.6;
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}
	p[role='alert'] {
		color: var(--danger, #ef9b9b);
	}
	label {
		font-size: 12px;
	}
	input {
		width: 100%;
		min-width: 0;
		padding: 9px;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--background);
		color: var(--text);
		font: inherit;
	}
	footer {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 12px;
	}
	button {
		padding: 8px 14px;
		border: 1px solid var(--border-strong);
		border-radius: 5px;
		background: transparent;
		color: inherit;
		cursor: pointer;
	}
	.confirm {
		background: var(--text);
		color: var(--background);
	}
	button:disabled,
	input:disabled {
		opacity: 0.5;
		cursor: default;
	}
	button:focus-visible,
	input:focus-visible {
		outline: 2px solid var(--accent, var(--text));
		outline-offset: 2px;
	}
</style>
