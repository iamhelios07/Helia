<script lang="ts">
	import { tick } from 'svelte';

	import Icon from '#lib/components/Icon.svelte';
	let {
		tabs,
		active,
		onselect,
		onclose
	}: {
		tabs: { id: string; title: string; dirty: boolean }[];
		active: string | null;
		onselect: (id: string) => void;
		onclose: (id: string) => void;
	} = $props();

	async function keydown(event: KeyboardEvent, id: string) {
		const index = tabs.findIndex((tab) => tab.id === id);
		let next: number;
		if (event.key === 'ArrowRight') {
			next = (index + 1) % tabs.length;
		} else if (event.key === 'ArrowLeft') {
			next = (index - 1 + tabs.length) % tabs.length;
		} else if (event.key === 'Home') {
			next = 0;
		} else if (event.key === 'End') {
			next = tabs.length - 1;
		} else if (event.key === 'Delete') {
			event.preventDefault();
			onclose(id);
			return;
		} else {
			return;
		}
		event.preventDefault();
		onselect(tabs[next].id);
		const tablist =
			event.currentTarget instanceof Element
				? event.currentTarget.closest('[role="tablist"]')
				: null;
		await tick();
		tablist?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
	}
</script>

<div class="document-tabs" role="tablist" aria-label="열린 문서">
	{#each tabs as tab (tab.id)}
		<div class={['tab', { active: active === tab.id }]}>
			<button
				type="button"
				role="tab"
				id="editor-tab-{tab.id}"
				aria-controls="editor-document"
				aria-selected={active === tab.id}
				tabindex={active === tab.id ? 0 : -1}
				onclick={() => onselect(tab.id)}
				onkeydown={(event) => keydown(event, tab.id)}
			>
				<Icon name="edit" size={13} /><span>{tab.title}</span>{#if tab.dirty}<span
						class="dirty"
						aria-label="미적용 변경">●</span
					>{/if}
			</button>
			<button
				type="button"
				class="close"
				aria-label="{tab.title} 문서 닫기"
				onclick={() => onclose(tab.id)}><Icon name="close" size={13} /></button
			>
		</div>
	{/each}
</div>

<style>
	.document-tabs {
		display: flex;
		min-height: 38px;
		overflow-x: auto;
		flex-shrink: 0;
		background: color-mix(in srgb, var(--background) 75%, #000);
		border-bottom: 1px solid var(--border);
	}
	.tab {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		border-right: 1px solid var(--border);
		border-top: 1px solid transparent;
		color: var(--text-muted);
	}
	.tab.active {
		background: var(--background);
		border-top-color: var(--text);
		color: var(--text-strong);
	}
	button {
		border: 0;
		border-radius: 0;
		background: transparent;
		color: inherit;
	}
	button[role='tab'] {
		display: flex;
		align-items: center;
		gap: 8px;
		height: 37px;
		padding: 0 9px 0 13px;
		font-size: 11px;
		white-space: nowrap;
	}
	.close {
		display: grid;
		place-items: center;
		margin-right: 7px;
		padding: 3px;
		border-radius: 3px;
	}
	.close:hover {
		background: var(--surface-active);
		color: var(--text-strong);
	}
	.dirty {
		font-size: 7px;
		color: var(--text-muted);
	}
	button:focus-visible {
		outline-offset: -3px;
	}
</style>
