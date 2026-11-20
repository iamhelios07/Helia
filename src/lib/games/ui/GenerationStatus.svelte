<script lang="ts">
	import type { CBSContext } from '#lib/games/ai/cbs/index.js';
	import type { SessionFileAccess } from '#lib/games/files/client.js';

	import Icon from '#lib/components/Icon.svelte';

	import type { GenerationMonitor } from './generation-monitor.svelte.js';
	import type { MessageAppearance } from './message-frame.js';

	import MessageContent from './MessageContent.svelte';

	let {
		monitor,
		status,
		label,
		tools,
		thinking,
		progressText,
		onstop,
		onretry,
		appearance,
		context,
		files
	}: {
		monitor: GenerationMonitor;
		status: string;
		label: string;
		tools: { id: number; name: string; status: 'running' | 'completed' | 'failed' }[];
		thinking: string;
		progressText: string;
		onstop?: () => void;
		onretry?: () => void;
		appearance?: MessageAppearance;
		context?: CBSContext;
		files?: SessionFileAccess;
	} = $props();
	const uid = $props.id();
	const toolLabels = { running: '실행 중', completed: '완료', failed: '실패' };
	let busy = $derived(status === 'generating' || status === 'committing');
	let failed = $derived(['failed', 'incomplete', 'cancelled'].includes(status));
	let stage = $derived(status === 'generating' ? monitor.label : label);
</script>

<aside
	class={['generation', { busy, failed, complete: status === 'committed' }]}
	aria-label="AI 생성 진행"
>
	<div class="heading">
		<div class="identity">
			<span class="indicator" aria-hidden="true">
				{#if status === 'committed'}<Icon name="check" size={13} />
				{:else if failed}<Icon name="info" size={13} />
				{:else}<span class="dot"></span>{/if}
			</span>
			<strong title={monitor.model}>{monitor.model}</strong>
		</div>
		<div class="controls">
			{#if onstop && busy}<button
					class="stop"
					type="button"
					onclick={onstop}
					disabled={status === 'committing'}>생성 중지</button
				>{/if}
			{#if onretry}<button class="retry" type="button" onclick={onretry}>다시 시도</button>{/if}
			<button
				class="expand"
				type="button"
				aria-label="생성 상세 정보"
				aria-controls={`${uid}-details`}
				aria-expanded={monitor.expanded}
				onclick={() => (monitor.expanded = !monitor.expanded)}
			>
				<span class={{ flipped: monitor.expanded }}><Icon name="chevron" size={15} /></span>
			</button>
		</div>
	</div>
	<div class="overview">
		<p class="stage" role="status" title={stage}>{stage}</p>
		<div class="metrics" aria-label="생성 통계" aria-live="off">
			<span>{monitor.seconds}초</span>
			<span>{monitor.characters.toLocaleString()}자</span>
			<span title="전체 경과 시간 기준 평균 수신 문자 수 · 본문, Thinking, 도구 인수 포함"
				>{monitor.speed.toLocaleString()} c/s</span
			>
			{#if tools.length}<span class="tools"><Icon name="tool" size={11} />{tools.length}회</span
				>{/if}
		</div>
	</div>
	<div class="details" id={`${uid}-details`} hidden={!monitor.expanded}>
		<p class="request">
			AI 요청 {monitor.round}회{#if monitor.attempt > 1}
				· 현재 요청 재시도 {monitor.attempt - 1}회{/if}
		</p>
		{#if thinking}<details>
				<summary>Thinking</summary>
				<div class="text">{thinking}</div>
			</details>{/if}
		{#if progressText}<details>
				<summary>중간 응답</summary>
				<div class="text" aria-label="중간 응답 내용">
					<MessageContent content={progressText} {appearance} {context} {files} />
				</div>
			</details>{/if}
		{#if tools.length}<details>
				<summary>도구 진행 · {tools.length}개</summary>
				<ul aria-label="도구 진행">
					{#each tools as tool (tool.id)}<li>
							<span class={['tool-state', tool.status]} aria-hidden="true"></span><span
								class="tool-name">{tool.name}</span
							><span>{toolLabels[tool.status]}</span>
						</li>{/each}
				</ul>
			</details>{/if}
		{#if !thinking && !progressText && !tools.length}<p class="empty">
				아직 표시할 상세 내역이 없습니다.
			</p>{/if}
	</div>
</aside>

<style>
	.generation {
		flex-shrink: 0;
		width: min(100%, 860px);
		box-sizing: border-box;
		margin: 0 auto;
		padding: 9px 12px;
		border-radius: 10px;
		background: color-mix(in srgb, var(--surface) 65%, transparent);
		color: var(--text);
		font-size: 11px;
	}
	.heading,
	.identity,
	.controls,
	.overview,
	.metrics,
	.tools {
		display: flex;
		align-items: center;
	}
	.heading {
		justify-content: space-between;
		gap: 10px;
		min-height: 24px;
	}
	.identity {
		gap: 7px;
		min-width: 0;
	}
	strong {
		color: var(--text-strong);
		font-size: 12px;
		font-weight: 550;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.indicator {
		display: grid;
		place-items: center;
		width: 13px;
		flex-shrink: 0;
		color: var(--text-muted);
	}
	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--accent);
	}
	.busy .dot {
		animation: pulse 1.5s ease-in-out infinite;
	}
	.complete .indicator {
		color: light-dark(#397547, #87bb91);
	}
	.failed .indicator {
		color: light-dark(#a05239, #d99e80);
	}
	.controls {
		gap: 6px;
		flex-shrink: 0;
	}
	button {
		cursor: pointer;
		font: inherit;
		color: var(--text);
		border: 1px solid var(--border);
		background: transparent;
		border-radius: 5px;
		padding: 3px 7px;
	}
	button:hover:not(:disabled) {
		background: var(--surface-hover);
		color: var(--text-strong);
	}
	button:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	button:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.expand {
		display: grid;
		place-items: center;
		border-color: transparent;
		padding: 3px;
	}
	.expand span {
		display: flex;
	}
	.flipped {
		transform: rotate(180deg);
	}
	.overview {
		justify-content: space-between;
		gap: 8px 18px;
		flex-wrap: wrap;
		padding-left: 20px;
	}
	.stage {
		color: var(--text-muted);
		margin: 2px 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
		flex: 1 1 130px;
		line-height: 1.5;
	}
	.metrics {
		gap: 9px;
		max-width: 100%;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
		flex-shrink: 0;
		line-height: 1.6;
		flex-wrap: wrap;
	}
	.metrics > span {
		white-space: nowrap;
	}
	.tools {
		gap: 3px;
	}
	.details {
		max-height: min(32vh, 240px);
		overflow-y: auto;
		overscroll-behavior: contain;
		border-top: 1px solid var(--border);
		margin-top: 7px;
		padding-top: 8px;
		line-height: 1.7;
	}
	.details[hidden] {
		display: none;
	}
	.request,
	.empty {
		margin: 0;
		color: var(--text-muted);
	}
	details {
		margin-top: 7px;
	}
	summary {
		cursor: pointer;
		width: fit-content;
		color: var(--text-muted);
	}
	.text {
		padding: 7px 0;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		font-size: 12px;
	}
	ul {
		list-style: none;
		padding: 0;
		margin: 6px 0 0;
	}
	li {
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 3px 0;
		color: var(--text-muted);
	}
	.tool-name {
		flex: 1;
		overflow-wrap: anywhere;
		color: var(--text);
	}
	.tool-state {
		width: 4px;
		height: 4px;
		border-radius: 50%;
		background: var(--text-muted);
		flex-shrink: 0;
	}
	.tool-state.running {
		background: var(--accent);
	}
	.tool-state.failed {
		background: light-dark(#a05239, #d99e80);
	}
	@keyframes pulse {
		50% {
			opacity: 0.35;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.busy .dot {
			animation: none;
		}
	}
	@media (max-width: 480px) {
		.overview {
			gap: 2px;
		}
		.stage {
			flex-basis: 100%;
		}
		.metrics {
			gap: 8px;
		}
	}
</style>
