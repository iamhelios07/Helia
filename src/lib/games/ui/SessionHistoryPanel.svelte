<script lang="ts">
	import { tick, untrack } from 'svelte';

	import type { HistoryEvent, SessionTimeline } from '#lib/games/state/history.js';
	import type { StateSlot } from '#lib/games/state/model.js';

	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
	import ItemActionButton from '#lib/components/ItemActionButton.svelte';

	import type { MessageAppearance } from './message-frame.js';

	import { historyGraph, HISTORY_ROW_HEIGHT } from './history-graph.js';
	import MessageContent from './MessageContent.svelte';
	let {
		timeline,
		busy,
		error,
		onselect,
		ondelete,
		onreload,
		appearance
	}: {
		timeline: SessionTimeline | null;
		busy: boolean;
		error: string;
		onselect: (id: string | null) => Promise<void>;
		ondelete: (id: string, revision: number) => Promise<boolean>;
		onreload: () => Promise<void>;
		appearance?: MessageAppearance;
	} = $props();
	let deleting = $state.raw<HistoryEvent | null>(null);
	let deletingRevision = 0;
	let graph = $derived(historyGraph(timeline?.events ?? []));
	let previewId = $derived(timeline?.history.progress.headId ?? null);
	let preview = $derived(timeline?.events.find((event) => event.id === previewId));
	let previewMessages = $derived(preview?.messages ?? (preview?.message ? [preview.message] : []));
	function requestDelete(event: HistoryEvent) {
		if (!timeline) {
			return;
		}
		deletingRevision = timeline.history.progress.revision;
		deleting = event;
	}
	function attachGraph(viewport: HTMLDivElement) {
		const index = untrack(() =>
			graph.nodes.findIndex((node) => node.id === timeline?.history.progress.headId)
		);
		let alive = true;
		void tick().then(() => {
			if (alive) {
				viewport.scrollTop = Math.max(0, index * HISTORY_ROW_HEIGHT - viewport.clientHeight / 2);
			}
		});
		return () => {
			alive = false;
		};
	}
	function slot(value: StateSlot): string {
		return value.exists ? JSON.stringify(value.value) : '(없음)';
	}
	function branchLabel(event?: HistoryEvent): string {
		if (!event) {
			return timeline?.history.progress.headId === null ? '현재 위치' : '';
		}
		if (event.selected) {
			return '현재 위치';
		}
		return event.active ? '현재 경로' : '다른 분기';
	}
	async function confirmDelete() {
		if (!deleting || busy) {
			return;
		}
		if (await ondelete(deleting.id, deletingRevision)) {
			deleting = null;
		}
	}
</script>

<section class="timeline" aria-label="세션 이력" aria-busy={busy}>
	<div class="toolbar">
		<span>{timeline?.events.length ?? 0}개 기록</span><button
			type="button"
			disabled={busy}
			onclick={onreload}>새로고침</button
		>
	</div>
	{#if error}<p class="error" role="alert">{error}</p>{/if}
	{#if !timeline}
		<p role="status">{busy ? '이력을 불러오는 중…' : '이력을 불러오지 못했어요.'}</p>
	{:else}
		<div class="graph-scroll" {@attach attachGraph}>
			<div
				class="graph"
				style:--gutter={`${graph.width}px`}
				style:--row-height={`${HISTORY_ROW_HEIGHT}px`}
				style:height={`${graph.height}px`}
			>
				<svg width={graph.width} height={graph.height} aria-hidden="true">
					{#each graph.edges as edge (edge.id)}<path
							d={edge.path}
							class={{ active: edge.active }}
						/>{/each}
					{#each graph.nodes as node (node.id)}
						<circle
							cx={node.cx}
							cy={node.cy}
							r="4"
							class={['node', { active: !node.event || node.event.active }]}
						/>
						{#if node.id === timeline.history.progress.headId}<circle
								class="head"
								cx={node.cx}
								cy={node.cy}
								r="8"
							/>{/if}
					{/each}
				</svg>
				<ol aria-label="이력 그래프">
					{#each graph.nodes as node (node.id)}
						<li
							class={[
								'event',
								{
									current: node.id === timeline.history.progress.headId
								}
							]}
						>
							<button
								class="inspect"
								type="button"
								disabled={busy}
								aria-current={node.id === timeline.history.progress.headId ? 'step' : undefined}
								aria-label={`${node.event?.summary ?? '초기 상태'} ${branchLabel(node.event)}`.trim()}
								onclick={() => onselect(node.id)}
							>
								<span class="summary">{node.event?.summary ?? '초기 상태'}</span>
								<small
									>{branchLabel(node.event)}{#if node.event}<time datetime={node.event.createdAt}
											>{new Date(node.event.createdAt).toLocaleTimeString([], {
												hour: '2-digit',
												minute: '2-digit'
											})}</time
										>{/if}</small
								>
							</button>
						</li>
					{/each}
				</ol>
			</div>
		</div>
		<div class="preview" aria-label="선택한 이력">
			<div class="preview-heading">
				<strong>{preview?.summary ?? '초기 상태'}</strong
				>{#if previewId === timeline.history.progress.headId}<span>현재 위치</span>{/if}
			</div>
			{#if preview}
				<details>
					<summary>변경 내용 · {preview.changes.length}개</summary>
					<time datetime={preview.createdAt}>{new Date(preview.createdAt).toLocaleString()}</time>
					{#each previewMessages as message (message.id)}
						<div class="dialogue"><MessageContent content={message.content} {appearance} /></div>
					{/each}
					{#if preview.changes.length}<dl>
							{#each preview.changes as change, index (`${preview.id}:${index}`)}
								<dt>{change.path.join('.') || '(전체 상태)'}</dt>
								<dd><code>{slot(change.before)}</code> → <code>{slot(change.after)}</code></dd>
							{/each}
						</dl>{:else}<p>상태 변경 없음</p>{/if}
					<details>
						<summary>작업 데이터</summary>
						<pre>{JSON.stringify(
								{ action: preview.action, changes: preview.changes },
								null,
								2
							)}</pre>
					</details>
				</details>
				<ItemActionButton
					action="delete"
					label={`${preview.summary} 삭제`}
					disabled={busy}
					onclick={() => requestDelete(preview!)}
				/>
			{:else}<p class="hint">게임을 시작한 지점입니다.</p>{/if}
			<details>
				<summary>현재 게임 상태</summary>
				<pre aria-label="현재 게임 상태">{JSON.stringify(
						timeline.history.progress.state,
						null,
						2
					)}</pre>
			</details>
			<details>
				<summary>현재 경로의 기억 · {timeline.memories.length}개</summary>
				<ul aria-label="현재 경로의 기억">
					{#each timeline.memories as memory (memory.id)}<li>{memory.content}</li>{/each}
				</ul>
			</details>
		</div>
	{/if}
</section>

{#if deleting}<ConfirmDialog
		title="이벤트 삭제"
		message={`${deleting.summary}\n이 이벤트와 여기서 이어지는 모든 분기의 후속 이벤트, 메시지와 연결된 기억을 삭제합니다. 공유하는 이전 이력과 다른 분기는 보존됩니다. 이 작업은 되돌릴 수 없습니다.`}
		disabled={busy}
		{error}
		confirmLabel={busy ? '삭제 중…' : '삭제'}
		onconfirm={confirmDelete}
		oncancel={() => (deleting = null)}
	/>{/if}

<style>
	.timeline {
		display: flex;
		flex-direction: column;
		min-height: 0;
		flex: 1;
		font-size: 12px;
	}
	.toolbar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 8px;
		flex-shrink: 0;
		padding-bottom: 8px;
		color: var(--text-muted);
		font-size: 11px;
	}
	button {
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 6px 8px;
		background: var(--surface);
		color: var(--text);
		font: inherit;
		cursor: pointer;
	}
	button:hover:not(:disabled) {
		background: var(--surface-hover);
		color: var(--text-strong);
	}
	button:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}
	button:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.graph-scroll {
		min-height: 90px;
		flex: 1;
		overflow: auto;
		scrollbar-width: thin;
	}
	.graph {
		position: relative;
		min-width: calc(var(--gutter) + 140px);
	}
	svg {
		position: absolute;
		inset: 0 auto auto 0;
		pointer-events: none;
		overflow: visible;
		z-index: 1;
	}
	path {
		fill: none;
		stroke: light-dark(#9384b4, #76658e);
		stroke-width: 1.5px;
	}
	path.active {
		stroke: light-dark(#467653, #86b693);
	}
	.node {
		fill: var(--background);
		stroke: light-dark(#9384b4, #9684ae);
		stroke-width: 2px;
	}
	.node.active {
		fill: light-dark(#467653, #86b693);
		stroke: light-dark(#467653, #86b693);
	}
	.head {
		fill: none;
		stroke: var(--text-strong);
		stroke-width: 1.5px;
	}
	ol {
		list-style: none;
		padding: 0;
		margin: 0;
	}
	.event {
		height: var(--row-height);
		border-radius: 6px;
	}
	.event.current {
		background: var(--surface-active);
	}
	.inspect {
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 5px;
		width: 100%;
		height: 100%;
		padding: 7px 8px 7px calc(var(--gutter) + 4px);
		border: 0;
		text-align: left;
		background: transparent;
	}
	.summary {
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		overflow: hidden;
		overflow-wrap: anywhere;
		line-height: 1.5;
	}
	small {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		width: 100%;
		color: var(--text-muted);
		font-size: 10px;
	}
	time {
		color: var(--text-muted);
		font-size: 10px;
	}
	small time {
		margin-left: auto;
	}
	.current .summary {
		color: var(--text-strong);
	}
	.preview {
		flex-shrink: 0;
		max-height: 46%;
		overflow: auto;
		border-top: 1px solid var(--border-strong);
		margin-top: 10px;
		padding-top: 12px;
		scrollbar-width: thin;
		line-height: 1.7;
	}
	.preview-heading {
		display: flex;
		align-items: baseline;
		gap: 8px;
		margin-bottom: 8px;
	}
	.preview-heading strong {
		flex: 1;
		overflow-wrap: anywhere;
		color: var(--text-strong);
		font-weight: 550;
	}
	.preview-heading span {
		font-size: 10px;
		color: var(--text-muted);
		flex-shrink: 0;
	}
	details {
		margin-top: 10px;
	}
	summary {
		cursor: pointer;
		color: var(--text-muted);
	}
	.dialogue {
		margin-top: 8px;
		white-space: pre-wrap;
	}
	.hint {
		color: var(--text-muted);
		font-size: 11px;
	}
	.error {
		color: var(--text-strong);
	}
	dd {
		margin: 4px 0 10px;
	}
	pre,
	code {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	pre {
		max-height: 220px;
		overflow: auto;
	}
</style>
