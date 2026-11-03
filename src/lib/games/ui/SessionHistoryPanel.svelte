<script lang="ts">
	import type { HistoryEvent, SessionTimeline } from '#lib/games/state/history.js';
	import type { StateSlot } from '#lib/games/state/model.js';

	let {
		timeline,
		busy,
		error,
		onselect,
		ondelete,
		onreload
	}: {
		timeline: SessionTimeline | null;
		busy: boolean;
		error: string;
		onselect: (id: string | null) => Promise<void>;
		ondelete: (id: string) => Promise<boolean>;
		onreload: () => Promise<void>;
	} = $props();
	const uid = $props.id();
	let deleting = $state.raw<HistoryEvent | null>(null);

	function openDialog(dialog: HTMLDialogElement) {
		dialog.showModal();
		return () => dialog.close();
	}
	function slot(value: StateSlot): string {
		return value.exists ? JSON.stringify(value.value) : '(없음)';
	}
	async function confirmDelete() {
		if (!deleting || busy) return;
		if (await ondelete(deleting.id)) deleting = null;
	}
</script>

<section class="timeline" aria-label="세션 이력" aria-busy={busy}>
	<header>
		<h3>이력과 분기</h3>
		<button type="button" disabled={busy} onclick={onreload}>새로고침</button>
	</header>
	<p class="hint">과거로 이동한 후 행동하면 새로운 분기가 만들어집니다.</p>
	{#if error}<p role="alert">{error}</p>{/if}
	{#if !timeline}
		<p role="status">{busy ? '이력을 불러오는 중…' : '이력을 불러오지 못했어요.'}</p>
	{:else}
		<button
			type="button"
			disabled={busy}
			aria-current={timeline.history.progress.headId === null ? 'step' : undefined}
			onclick={() => onselect(null)}
			>초기 상태{timeline.history.progress.headId === null ? ' · 현재 위치' : ''}</button
		>
		<ol>
			{#each timeline.events as event (event.id)}
				<li
					class={['event', { active: event.active, selected: event.selected }]}
					style:--depth={Math.min(event.depth, 8)}
				>
					<div class="event-heading">
						<button
							type="button"
							class="select-event"
							disabled={busy}
							aria-current={event.selected ? 'step' : undefined}
							onclick={() => onselect(event.id)}
						>
							<span>{event.summary}</span>
							<small
								>{event.selected ? '현재 위치' : event.active ? '현재 경로' : '다른 분기'}</small
							>
						</button>
						<button
							type="button"
							disabled={busy}
							aria-label={`${event.summary} 삭제`}
							onclick={() => (deleting = event)}>삭제</button
						>
					</div>
					<details>
						<summary>변경 내용 · {event.changes.length}개</summary>
						<time datetime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time>
						{#if event.message}<p class="dialogue">{event.message.content}</p>{/if}
						{#if event.changes.length}
							<dl>
								{#each event.changes as change, index (`${event.id}:${index}`)}
									<dt>{change.path.length ? change.path.join('.') : '(전체 상태)'}</dt>
									<dd><code>{slot(change.before)}</code> → <code>{slot(change.after)}</code></dd>
								{/each}
							</dl>
						{:else}<p>상태 변경 없음</p>{/if}
						<details>
							<summary>작업 데이터</summary>
							<pre>{JSON.stringify({ action: event.action, changes: event.changes }, null, 2)}</pre>
						</details>
					</details>
				</li>
			{/each}
		</ol>
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
	{/if}
</section>

{#if deleting}
	<dialog
		{@attach openDialog}
		aria-labelledby={`${uid}-delete-title`}
		aria-describedby={`${uid}-delete-description`}
		oncancel={(event) => {
			if (busy) event.preventDefault();
		}}
		onclose={() => {
			if (!busy) deleting = null;
		}}
	>
		<h3 id={`${uid}-delete-title`}>이벤트 삭제</h3>
		<p>{deleting.summary}</p>
		<p id={`${uid}-delete-description`}>
			이 이벤트와 여기서 이어지는 모든 분기의 후속 이벤트, 메시지와 연결된 기억을 삭제합니다.
			공유하는 이전 이력과 다른 분기는 보존됩니다. 이 작업은 되돌릴 수 없습니다.
		</p>
		{#if error}<p role="alert">{error}</p>{/if}
		<div class="dialog-actions">
			<button type="button" disabled={busy} onclick={() => (deleting = null)}>취소</button>
			<button type="button" disabled={busy} onclick={confirmDelete}
				>{busy ? '삭제 중…' : '삭제'}</button
			>
		</div>
	</dialog>
{/if}

<style>
	.timeline {
		padding: 16px;
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--surface);
		font-size: 12px;
	}
	header,
	.event-heading,
	.dialog-actions {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	header {
		justify-content: space-between;
	}
	h3 {
		margin: 0;
		color: var(--text-strong);
		font-size: 14px;
	}
	.hint,
	small,
	time {
		color: var(--text-muted);
	}
	button {
		padding: 7px 10px;
		border: 1px solid var(--border-strong);
		border-radius: 7px;
		background: var(--surface);
		color: var(--text);
		font: inherit;
		cursor: pointer;
	}
	button:hover:not(:disabled) {
		background: var(--surface-hover);
	}
	button:disabled {
		opacity: 0.45;
		cursor: default;
	}
	button[aria-current] {
		border-color: var(--text-muted);
		color: var(--text-strong);
	}
	ol {
		padding: 0;
		list-style: none;
	}
	.event {
		margin: 10px 0 10px calc(var(--depth) * 12px);
		padding-left: 8px;
		border-left: 2px solid var(--border);
	}
	.event.active {
		border-color: var(--text-muted);
	}
	.event.selected {
		border-color: var(--text-strong);
	}
	.select-event {
		display: flex;
		min-width: 0;
		flex: 1;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		text-align: left;
	}
	.select-event span {
		overflow-wrap: anywhere;
	}
	small {
		flex-shrink: 0;
		font-size: 10px;
	}
	details {
		margin-top: 10px;
	}
	summary {
		cursor: pointer;
		color: var(--text-muted);
	}
	dd {
		margin: 4px 0 10px;
	}
	pre,
	code {
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}
	pre {
		max-height: 260px;
		overflow: auto;
	}
	.dialogue {
		white-space: pre-wrap;
	}
	dialog {
		max-width: min(460px, calc(100vw - 32px));
		padding: 24px;
		border: 1px solid var(--border-strong);
		border-radius: 12px;
		background: var(--surface);
		color: var(--text);
		font-size: 13px;
		line-height: 1.7;
	}
	dialog::backdrop {
		background: rgb(0 0 0 / 0.6);
	}
	.dialog-actions {
		justify-content: flex-end;
		margin-top: 20px;
	}
</style>
