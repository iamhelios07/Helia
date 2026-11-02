<script lang="ts">
	import '../app.css';
	import favicon from '#lib/assets/helia.svg';
	import AppSidebar from '#lib/home/AppSidebar.svelte';
	import { AppSidebarController, provideAppSidebar } from '#lib/shell/sidebar.svelte.js';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { LayoutProps } from './$types';

	let { children, params }: LayoutProps = $props();
	const sidebar = provideAppSidebar(new AppSidebarController());
	let options = $derived(sidebar.options);
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
	/>
</div>
<div class={['app-content', { 'sidebar-hidden': !sidebar.visible }]}>
	{@render children()}
</div>

<style>
	.app-content {
		min-height: 100dvh;
		margin-left: var(--rail-width);
	}
	.app-content.sidebar-hidden {
		margin-left: 0;
	}
</style>
