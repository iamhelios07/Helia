<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';

	import type { EditorWorkspace } from '../editor-workspace.svelte.js';

	import { EDITOR_LAYOUT_LIMITS } from '../../editor-layout.js';
	let { editor }: { editor: EditorWorkspace } = $props();
</script>

{#if editor.bottomOpen}
	<div
		class="bottom-handle"
		role="slider"
		tabindex="0"
		aria-label="검사 패널 높이 조절"
		aria-orientation="vertical"
		aria-valuemin={EDITOR_LAYOUT_LIMITS.bottom.min}
		aria-valuemax={Math.round(editor.maxBottomHeight)}
		aria-valuenow={Math.round(editor.displayedBottomHeight)}
		onpointerdown={editor.resizeBottom}
		onpointermove={editor.resizeBottom}
		onpointerup={editor.saveLayout}
		onpointercancel={editor.saveLayout}
		onkeydown={editor.resizeBottomKey}
	></div>
{/if}
<section class={['bottom-panel', { collapsed: !editor.bottomOpen }]} aria-label="편집기 검사">
	<div class="bottom-header">
		<div role="tablist" aria-label="검사 패널">
			{#each editor.panels as panel (panel.id)}<button
					type="button"
					role="tab"
					aria-selected={editor.bottomPanel === panel.id && editor.bottomOpen}
					aria-controls="editor-inspector"
					onclick={() => {
						editor.bottomPanel = panel.id;
						editor.bottomOpen = true;
					}}
					>{panel.label}{#if panel.id === 'problems' && editor.validation}<span class="count"
							>{editor.problems.length}</span
						>{/if}</button
				>{/each}
		</div>
		<button
			type="button"
			class="icon-button"
			aria-label={editor.bottomOpen ? '검사 패널 접기' : '검사 패널 펼치기'}
			aria-expanded={editor.bottomOpen}
			onclick={() => (editor.bottomOpen = !editor.bottomOpen)}
			><Icon name={editor.bottomOpen ? 'minus' : 'plus'} size={14} /></button
		>
	</div>
	{#if editor.bottomOpen}<div
			class="inspector-content"
			id="editor-inspector"
			role="tabpanel"
			aria-label={editor.panels.find((panel) => panel.id === editor.bottomPanel)?.label}
		>
			{#if editor.bottomPanel === 'problems'}{#if editor.validation && editor.problems.length === 0}<p
						class="inspection-clear"
					>
						<Icon name="check" size={14} />문서 형식 검사를 통과했어요.<span
							>소스 실행은 이 검사에 포함되지 않아요.</span
						>
					</p>{:else}<ul class="problem-list">
						{#each editor.problems as problem (problem.key)}<li>
								<button type="button" onclick={() => editor.showProblem(problem)}
									><span class="problem-marker">!</span><span>{problem.message}</span><span
										class="problem-document"
										>{'file' in problem
											? `${problem.file}:${problem.line}:${problem.column}`
											: editor.documentLabel(problem.documentId)}</span
									></button
								>
							</li>{/each}
					</ul>{/if}
			{:else if editor.bottomPanel === 'logs'}<p class="inspector-hint">
					편집기의 불러오기·적용 기록
				</p>
				<ul class="log-list">
					{#each editor.logs as entry (entry.id)}<li class={{ failed: entry.failed }}>
							<time>{entry.time}</time><span>{entry.message}</span>
						</li>{/each}
				</ul>
			{:else}<pre class="state-inspection">{JSON.stringify(
						editor.runtimeState ?? editor.previewContent?.initialState,
						null,
						2
					)}</pre>{/if}
		</div>{/if}
</section>

<style>
	button {
		font: inherit;
	}
	button {
		color: inherit;
	}
	button {
		border: 0;
		background: transparent;
	}
	button:disabled {
		opacity: 0.4;
	}
	button:not(:disabled):hover {
		background: var(--surface-hover);
	}
	button:focus-visible {
		outline: 1px solid var(--text);
		outline-offset: -2px;
	}
	p {
		margin: 0;
	}
	button {
		border-radius: 4px;
	}
	.icon-button {
		display: inline-grid;
		place-items: center;
		width: 27px;
		height: 27px;
		padding: 0;
		color: var(--text-muted);
	}
	.bottom-panel {
		height: var(--bottom-height);
		flex-shrink: 0;
		border-top: 1px solid var(--border);
		display: flex;
		flex-direction: column;
	}
	.bottom-panel.collapsed {
		height: 35px;
	}
	.bottom-handle {
		height: 5px;
		flex-shrink: 0;
		cursor: row-resize;
		touch-action: none;
		user-select: none;
	}
	.bottom-handle:hover,
	.bottom-handle:focus-visible {
		background: var(--border-strong);
		outline: none;
	}
	.bottom-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 0 10px 0 12px;
		height: 35px;
		min-height: 35px;
	}
	.bottom-header [role='tablist'] {
		display: flex;
		gap: 15px;
		height: 100%;
	}
	.bottom-header [role='tab'] {
		display: flex;
		align-items: center;
		gap: 7px;
		border-radius: 0;
		border-bottom: 1px solid transparent;
		padding: 0 4px;
		font-size: 11px;
		color: var(--text-muted);
	}
	.bottom-header [aria-selected='true'] {
		border-bottom-color: var(--text);
		color: var(--text-strong);
	}
	.count {
		display: inline-grid;
		place-items: center;
		background: var(--surface-active);
		border-radius: 7px;
		min-width: 15px;
		height: 14px;
		font-size: 10px;
	}
	.inspector-content {
		flex: 1;
		overflow: auto;
		font-size: 11px;
	}
	.inspection-clear {
		padding: 18px;
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--text-muted);
	}
	.inspection-clear span {
		opacity: 0.65;
		margin-left: 8px;
	}
	.problem-list,
	.log-list {
		margin: 0;
		padding: 5px 0;
		list-style: none;
	}
	.problem-list button {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		border-radius: 0;
		padding: 7px 18px;
		text-align: left;
		font-size: 11px;
	}
	.problem-marker {
		display: grid;
		place-items: center;
		width: 13px;
		height: 13px;
		border: 1px solid var(--text-muted);
		border-radius: 50%;
		font-size: 10px;
	}
	.problem-document {
		margin-left: auto;
		opacity: 0.6;
		font-size: 11px;
	}
	.inspector-hint {
		padding: 10px 18px 3px;
		color: var(--text-muted);
		font-size: 11px;
	}
	.log-list li {
		display: flex;
		gap: 14px;
		padding: 5px 18px;
		line-height: 1.7;
		font-size: 11px;
	}
	.log-list time {
		color: var(--text-muted);
		font-family: Consolas, monospace;
	}
	.state-inspection {
		padding: 10px 18px;
		margin: 0;
		font:
			11px/1.7 Consolas,
			monospace;
		white-space: pre-wrap;
	}
	.failed {
		color: #eab4ae;
	}
	@media (max-width: 1100px) {
		.inspection-clear {
			flex-wrap: wrap;
		}
		.inspection-clear span {
			margin-left: 22px;
		}
	}
	@media (max-width: 500px) {
		.inspection-clear span {
			margin-left: 0;
		}
	}
</style>
