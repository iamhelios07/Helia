<script lang="ts">
	let { message, ondismiss }: { message: string; ondismiss: () => void } = $props();
</script>

<!-- Announced by screen readers as soon as it appears; it stays until the player dismisses it. -->
<div class="grant-notice">
	<p role="alert">{message}</p>
	<button type="button" onclick={ondismiss} aria-label="알림 닫기">닫기</button>
</div>

<style>
	.grant-notice {
		position: fixed;
		inset-inline: 16px;
		bottom: 16px;
		z-index: 60;
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		max-width: 520px;
		margin: 0 auto;
		padding: 14px 16px;
		border: 1px solid var(--border-strong);
		border-radius: 8px;
		background: var(--surface);
		box-shadow: 0 12px 40px #0006;
	}
	p {
		margin: 0;
		color: var(--text);
		font-size: 13px;
		line-height: 1.7;
		overflow-wrap: anywhere;
	}
	button {
		flex-shrink: 0;
		min-height: 32px;
		padding: 5px 10px;
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		background: var(--surface-hover);
		color: var(--text-strong);
		font-size: 12px;
	}
	button:hover {
		background: var(--surface-active);
	}
	button:focus-visible {
		outline: 2px solid var(--text);
		outline-offset: 2px;
	}
</style>
