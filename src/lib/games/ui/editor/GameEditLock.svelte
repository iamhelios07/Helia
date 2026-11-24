<script lang="ts">
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';

	import { UNLOCK_CONFIRMATION } from '../../edit-lock.js';
	import { unlockGame } from '../../repository.js';

	let { gameId, onunlocked }: { gameId: string; onunlocked: () => Promise<void> } = $props();
	let confirming = $state(false);
	let unlocking = $state(false);
	let error = $state('');
	async function unlock() {
		if (unlocking) {
			return;
		}
		unlocking = true;
		error = '';
		try {
			await unlockGame(gameId);
			confirming = false;
			await onunlocked();
		} catch {
			error = '편집 잠금을 해제하지 못했어요. 다시 시도해주세요.';
		} finally {
			unlocking = false;
		}
	}
</script>

<section aria-label="편집 잠금" class="edit-lock">
	<h2>편집이 잠긴 게임이에요</h2>
	<p>게임을 편집하려면 잠금을 해제해주세요. 플레이는 계속할 수 있어요.</p>
	<button type="button" onclick={() => (confirming = true)} disabled={unlocking}
		>편집 잠금 해제</button
	>
	{#if error && !confirming}<p role="alert">{error}</p>{/if}
</section>
{#if confirming}
	<ConfirmDialog
		title="편집 잠금 해제"
		message={UNLOCK_CONFIRMATION}
		{error}
		tone="default"
		confirmLabel={unlocking ? '해제 중…' : '잠금 해제'}
		disabled={unlocking}
		onconfirm={unlock}
		oncancel={() => (confirming = false)}
	/>
{/if}

<style>
	.edit-lock {
		padding: 3rem;
		color: var(--text-strong);
	}
	p {
		color: var(--text-muted);
	}
</style>
