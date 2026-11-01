<script lang="ts">
	const paths = {
		sun: 'M12 2v3m0 14v3M2 12h3m14 0h3M4.93 4.93l2.12 2.12m9.9 9.9 2.12 2.12M4.93 19.07l2.12-2.12m9.9-9.9 2.12-2.12M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
		grid: 'M3.5 3.5h6v6h-6zM14.5 3.5h6v6h-6zM3.5 14.5h6v6h-6zM14.5 14.5h6v6h-6z',
		plus: 'M12 5v14M5 12h14',
		search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Zm5-1.5L21 21',
		list: 'M8 5h13M8 12h13M8 19h13M3 5h.01M3 12h.01M3 19h.01',
		sort: 'M8 3v18m-4-4 4 4 4-4M16 21V3m-4 4 4-4 4 4',
		chevron: 'm8 10 4 4 4-4',
		close: 'm6 6 12 12M6 18 18 6',
		folder: 'M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z',
		import: 'M12 3v12m-4-4 4 4 4-4M4 15v5h16v-5',
		edit: 'm14 5 5 5M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15l-1 5Z',
		chat: 'M20 15a3 3 0 0 1-3 3H9l-5 3V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v9Z',
		tool: 'm14 6 4 4m-9 3-6 6a2.1 2.1 0 0 0 3 3l6-6M14 3a6 6 0 0 0-7 7l7 7a6 6 0 0 0 7-7l-4 3-4-4 3-4-2-2Z',
		settings:
			'm10 3-.6 2.4-2 .9L5 5.6 3 9l1.8 1.7v2.6L3 15l2 3.4 2.4-.7 2 .9L10 21h4l.6-2.4 2-.9 2.4.7 2-3.4-1.8-1.7v-2.6L21 9l-2-3.4-2.4.7-2-.9L14 3h-4Zm5 9a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
		info: 'M12 11v6m0-10h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z'
	};
	let { name, size = 20 }: { name: keyof typeof paths; size?: number } = $props();
</script>

<svg
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="1.5"
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
>
	<path d={paths[name]} />
</svg>
