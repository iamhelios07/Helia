<script lang="ts">
	import '../app.css';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { tick } from 'svelte';

	import AppSidebar from '#lib/app/AppSidebar.svelte';
	import SettingsDialog from '#lib/app/settings/SettingsDialog.svelte';
	import { AppSidebarController, provideAppSidebar } from '#lib/app/sidebar.svelte.js';
	import favicon from '#lib/assets/helia.svg';

	import type { LayoutProps } from './$types';

	let { children, params }: LayoutProps = $props();
	const sidebar = provideAppSidebar(new AppSidebarController());
	let options = $derived(sidebar.options);
	let settingsOpen = $state(false);
	let settingsOpener: HTMLElement | null = null;

	function openSettings() {
		if (settingsOpen) {
			return;
		}
		settingsOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		settingsOpen = true;
	}

	async function closeSettings() {
		if (!settingsOpen) {
			return;
		}
		const opener = settingsOpener;
		settingsOpener = null;
		settingsOpen = false;
		await tick();
		if (!settingsOpen && opener?.isConnected) {
			opener.focus();
		}
	}

	function goHome() {
		void goto(resolve('/'));
	}
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<div hidden={!sidebar.visible}>
	<AppSidebar
		games={sidebar.games}
		activeGameId={options ? options.activeGameId : (params.id ?? null)}
		busy={options?.busy ?? false}
		onhome={options?.onhome ?? goHome}
		onadd={options?.onadd ?? goHome}
		onselect={options?.onselect ?? goHome}
		onsettings={openSettings}
	/>
</div>
<div class={['app-content', { 'sidebar-hidden': !sidebar.visible }]}>
	{@render children()}
</div>

{#if settingsOpen}
	<SettingsDialog onclose={closeSettings} />
{/if}

<style>
	.app-content {
		min-height: 100dvh;
		margin-left: var(--rail-width);
	}
	.app-content.sidebar-hidden {
		margin-left: 0;
	}
</style>
