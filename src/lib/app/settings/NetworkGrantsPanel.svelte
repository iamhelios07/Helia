<script lang="ts">
	import { onMount, tick } from 'svelte';

	import {
		NetworkGrantsController,
		type NetworkGrantRow
	} from './network-grants-controller.svelte.js';
	const controller = new NetworkGrantsController();
	onMount(() => {
		void controller.load();
		return controller.dispose;
	});
	/** Revoking removes the clicked row, so move focus somewhere sensible instead of dropping it. */
	async function revoke(row: NetworkGrantRow, button: HTMLButtonElement) {
		const count = controller.rows.length;
		const section = button.closest('section');
		const index = [...(button.closest('ul')?.querySelectorAll('button') ?? [])].indexOf(button);
		const revoked = controller.revoke(row);
		await tick();
		// A failed revoke leaves the row and the button in place; focus stays where the player is.
		if (!revoked || controller.rows.length === count) {
			return;
		}
		const buttons = section?.querySelectorAll<HTMLButtonElement>('.grant-list button') ?? [];
		const target =
			buttons[Math.min(index, buttons.length - 1)] ?? section?.querySelector<HTMLElement>('h3');
		target?.focus();
	}
</script>

<svelte:window onstorage={controller.storageChanged} />

<section class="network-grants" aria-labelledby="network-grants-heading">
	<h3 id="network-grants-heading" tabindex="-1">다시 묻지 않기로 한 주소</h3>
	<p class="help">
		게임마다 허용해 둔 외부 주소예요. 취소하면 그 게임이 해당 주소에 연결할 때 다시 물어봅니다.
	</p>
	{#if controller.error}<p class="notice" role="alert">{controller.error}</p>{/if}
	<p class="status" role="status">{controller.status}</p>
	{#if controller.ready && controller.rows.length}
		<ul class="grant-list" aria-label="허용한 외부 주소 목록">
			{#each controller.rows as row (`${row.gameId}\n${row.origin}`)}
				<li>
					<span class="grant-text">
						<strong>{row.title}{row.trashed ? ' (휴지통)' : ''}</strong>
						<span class="origin">{row.origin}</span>
					</span>
					<button
						type="button"
						aria-label={`${row.title}의 ${row.origin} 허용 취소`}
						onclick={(event) => void revoke(row, event.currentTarget)}>허용 취소</button
					>
				</li>
			{/each}
		</ul>
	{:else if controller.ready}
		<p class="empty">다시 묻지 않기로 한 주소가 없어요.</p>
	{/if}
</section>

<style>
	.network-grants {
		max-width: 920px;
		min-width: 0;
		padding: 27px;
		border: 1px solid var(--border);
		border-radius: 12px;
	}
	h3 {
		margin: 0;
		color: var(--text-strong);
		font-size: 15px;
		font-weight: 550;
		letter-spacing: -0.025em;
	}
	.help,
	.empty {
		margin: 12px 0 0;
		color: var(--text-muted);
		font-size: 12px;
		line-height: 1.8;
	}
	.status:not(:empty) {
		margin: 14px 0 0;
		color: var(--text-muted);
		font-size: 12px;
		line-height: 1.7;
	}
	.notice {
		margin: 16px 0 0;
		padding: 14px;
		border: 1px solid var(--border-strong);
		border-radius: 8px;
		color: var(--text);
		font-size: 12px;
		line-height: 1.8;
	}
	.grant-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin: 20px 0 0;
		padding: 0;
		list-style: none;
	}
	li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 13px 15px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--surface);
	}
	.grant-text {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 5px;
	}
	strong {
		color: var(--text-strong);
		font-size: 13px;
		font-weight: 500;
		overflow-wrap: anywhere;
	}
	.origin {
		color: var(--text-muted);
		font-size: 12px;
		overflow-wrap: anywhere;
	}
	button {
		min-height: 36px;
		flex-shrink: 0;
		padding: 7px 12px;
		border: 1px solid var(--border-strong);
		border-radius: 7px;
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
	@media (max-width: 600px) {
		.network-grants {
			padding: 20px;
		}
		li {
			align-items: flex-start;
			flex-direction: column;
		}
	}
</style>
