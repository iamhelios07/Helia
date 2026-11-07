<script lang="ts">
	let {
		value,
		label,
		language = 'JSON',
		readonly = false,
		disabled = false,
		onchange
	}: {
		value: string;
		label: string;
		language?: string;
		readonly?: boolean;
		disabled?: boolean;
		onchange?: (value: string) => void;
	} = $props();
	let lineCount = $derived(value.split('\n').length);
	let scrollTop = $state(0);
	let firstLine = $derived(Math.min(lineCount, Math.max(1, Math.floor(scrollTop / 21) - 5)));
	let visibleLines = $derived(
		Array.from(
			{ length: Math.min(150, lineCount - firstLine + 1) },
			(_, index) => firstLine + index
		)
	);
	let position = $state({ line: 1, column: 1 });

	function updatePosition(element: HTMLTextAreaElement) {
		const before = element.value.slice(0, element.selectionStart);
		const lines = before.split('\n');
		position = { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
	}
</script>

<div class="source-editor">
	<div class="source-body">
		<div class="line-numbers" aria-hidden="true">
			<div style:transform="translateY({(firstLine - 1) * 21 - scrollTop}px)">
				{#each visibleLines as line (line)}
					<div>{line}</div>
				{/each}
			</div>
		</div>
		<textarea
			aria-label={label}
			{value}
			{readonly}
			{disabled}
			spellcheck="false"
			autocapitalize="off"
			autocomplete="off"
			wrap="off"
			oninput={(event) => {
				onchange?.(event.currentTarget.value);
				updatePosition(event.currentTarget);
			}}
			onscroll={(event) => (scrollTop = event.currentTarget.scrollTop)}
			onclick={(event) => updatePosition(event.currentTarget)}
			onkeyup={(event) => updatePosition(event.currentTarget)}></textarea>
	</div>
	<footer>
		<span>{language}{readonly ? ' · 읽기 전용' : ''}</span><span
			>줄 {position.line}, 열 {position.column}</span
		>
	</footer>
</div>

<style>
	.source-editor {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}
	.source-body {
		position: relative;
		display: flex;
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}
	.line-numbers {
		flex: 0 0 48px;
		overflow: hidden;
		padding: 20px 11px 20px 0;
		text-align: right;
		color: color-mix(in srgb, var(--text-muted) 55%, transparent);
		user-select: none;
	}
	.line-numbers,
	textarea {
		font:
			12px/21px Consolas,
			'SFMono-Regular',
			monospace;
		tab-size: 2;
	}
	textarea {
		flex: 1;
		min-width: 0;
		resize: none;
		border: 0;
		border-radius: 0;
		padding: 20px 18px 20px 0;
		background: transparent;
		color: var(--text);
		outline-offset: -2px;
		white-space: pre;
	}
	textarea:focus-visible {
		outline: 1px solid var(--border-strong);
	}
	footer {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		padding: 7px 15px;
		border-top: 1px solid var(--border);
		font-size: 10px;
		color: var(--text-muted);
	}
</style>
