<script lang="ts">
	let {
		version,
		disabled,
		error,
		onchange,
		onignore,
		oncancel
	}: {
		version: string;
		disabled: boolean;
		error: string;
		onchange: () => void;
		onignore: () => void;
		oncancel: () => void;
	} = $props();
	const id = $props.id();
	function open(dialog: HTMLDialogElement) {
		const previousFocus = document.activeElement;
		dialog.showModal();
		return () => {
			dialog.close();
			if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
				previousFocus.focus();
			}
		};
	}
</script>

<dialog
	{@attach open}
	aria-labelledby={`${id}-title`}
	aria-describedby={`${id}-description`}
	oncancel={(event) => {
		event.preventDefault();
		if (!disabled) {
			oncancel();
		}
	}}
>
	<h2 id={`${id}-title`}>버전 충돌</h2>
	<p id={`${id}-description`}>
		같은 원본 게임의 {version} 버전에 다른 콘텐츠가 있어요. 구분할 수 있도록 버전 변경을 권장해요. 무시하고
		계속하면 현재 적용된 콘텐츠도 같은 버전으로 확정돼요.
	</p>
	{#if error}<p class="error" role="alert">{error}</p>{/if}
	<div class="actions">
		<button type="button" {disabled} onclick={onchange}>버전 변경</button>
		<button type="button" {disabled} onclick={onignore}
			>{disabled ? '확정 중…' : '무시하고 계속하기'}</button
		>
		<button type="button" {disabled} onclick={oncancel}>취소</button>
	</div>
</dialog>

<style>
	dialog {
		width: min(460px, calc(100vw - 32px));
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
		color: var(--text-muted);
		font-size: 13px;
		line-height: 1.6;
		overflow-wrap: anywhere;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		flex-wrap: wrap;
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
	.error {
		color: var(--danger, #ef9b9b);
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
