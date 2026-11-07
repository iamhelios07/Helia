<script lang="ts">
	import { onDestroy } from 'svelte';
	import type { Game } from '#lib/games/model.js';
	import type { GameState } from '#lib/games/state/value.js';
	import { parseGameState } from '#lib/games/state/value.js';
	import type { SessionTimeline } from '#lib/games/state/history.js';
	import type { ToolDefinition } from '#lib/games/ai/protocol.js';
	import {
		createEditorPlaythrough,
		playgroundFingerprint,
		playgroundFailure,
		type EditorDiagnostic,
		type EditorPlaythrough
	} from '#lib/games/editor-playground.js';
	import { mountGameUI, type GameUIHandle } from '../runtime/bridge.js';
	import type { PanelInfo } from '../runtime/model.js';
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';

	let {
		game,
		mode,
		ondiagnostic,
		onstate
	}: {
		game: Game;
		mode: 'preview' | 'test';
		ondiagnostic?: (entry: EditorDiagnostic) => void;
		onstate?: (state: GameState) => void;
	} = $props();
	let preview = $state.raw<EditorPlaythrough | null>(null);
	let test = $state.raw<EditorPlaythrough | null>(null);
	let previewTimeline = $state.raw<SessionTimeline | null>(null);
	let testTimeline = $state.raw<SessionTimeline | null>(null);
	let previewTools = $state.raw<ToolDefinition[]>([]);
	let testTools = $state.raw<ToolDefinition[]>([]);
	let startingModes = $state({ preview: false, test: false });
	let operating = $state(false);
	let busyModes = $state({ preview: false, test: false });
	let error = $state('');
	let resetRequested = $state(false);
	let actionName = $state('');
	let actionArguments = $state('{}');
	let nextState = $state('{}');
	let aiInput = $state('');
	let streaming = $state('');
	let panelCount = $state(0);
	let ready = $state(false);
	const generations = { preview: 0, test: 0 };
	let disposed = false;
	let requestAbort: AbortController | undefined;
	let current = $derived(mode === 'preview' ? preview : test);
	let starting = $derived(startingModes[mode]);
	let uiBusy = $derived(busyModes[mode]);
	let timeline = $derived(mode === 'preview' ? previewTimeline : testTimeline);
	let tools = $derived(
		(mode === 'preview' ? previewTools : testTools).filter((tool) => tool.kind === 'action')
	);
	let outdated = $derived(
		mode === 'test' && !!test && test.fingerprint !== playgroundFingerprint(game)
	);
	let busy = $derived(starting || operating || uiBusy);
	let frameHeight = $derived(Math.max(220, panelCount * 190));

	// Recompile the real sandbox after edits settle. Test state changes only on explicit restart.
	$effect(() => {
		const snapshot = game;
		const fingerprint = playgroundFingerprint(snapshot);
		if (mode !== 'preview') return;
		const timer = setTimeout(() => {
			if (preview?.fingerprint !== fingerprint) void start('preview', snapshot);
		}, 350);
		return () => clearTimeout(timer);
	});
	$effect(() => {
		if (timeline) onstate?.(timeline.history.progress.state);
	});
	onDestroy(() => {
		disposed = true;
		generations.preview++;
		generations.test++;
		requestAbort?.abort();
		preview?.dispose();
		test?.dispose();
	});

	function report(entry: EditorDiagnostic) {
		ondiagnostic?.({
			...entry,
			message: `${mode === 'preview' ? '미리보기' : '테스트'} · ${entry.message}`
		});
	}
	async function start(kind: 'preview' | 'test', snapshot = game) {
		const generation = ++generations[kind];
		startingModes[kind] = true;
		if (mode === kind) error = '';
		try {
			const context = await createEditorPlaythrough(snapshot, {
				ondiagnostic: (entry) => {
					if (!disposed && generations[kind] === generation)
						ondiagnostic?.({
							...entry,
							message: `${kind === 'preview' ? '미리보기' : '테스트'} · ${entry.message}`
						});
				},
				onchange: (next) => {
					if (disposed || generations[kind] !== generation) return;
					if (kind === 'preview') previewTimeline = next;
					else testTimeline = next;
				}
			});
			if (disposed || generations[kind] !== generation) {
				context.dispose();
				return;
			}
			if (kind === 'preview') {
				preview?.dispose();
				preview = context;
			} else {
				test?.dispose();
				test = context;
			}
			if (mode === kind) {
				ready = false;
				panelCount = 0;
				nextState = JSON.stringify(context.timeline.history.progress.state, null, 2);
			}
			ondiagnostic?.({
				message: `${kind === 'preview' ? '미리보기' : '테스트'} · 별도 실행 시작`,
				failed: false
			});
			try {
				const catalog = await context.catalog();
				if (disposed || generations[kind] !== generation) return;
				if (kind === 'preview') previewTools = catalog;
				else testTools = catalog;
			} catch (failure) {
				if (mode === kind && generations[kind] === generation) fail(failure);
			}
		} catch (failure) {
			if (!disposed && mode === kind && generations[kind] === generation) fail(failure);
		} finally {
			if (!disposed && generations[kind] === generation) startingModes[kind] = false;
		}
	}
	function fail(failure: unknown) {
		error = playgroundFailure(failure);
		report({ message: '실행 실패', failed: true, detail: error });
	}
	function attachFrame(context: EditorPlaythrough) {
		const kind = mode;
		return (frame: HTMLIFrameElement) => {
			let canceled = false;
			let handle: GameUIHandle | undefined;
			let panels: PanelInfo[] = [];
			const resize = () => {
				const width = frame.getBoundingClientRect().width;
				if (width <= 0) return;
				handle?.setViews(
					panels.map((panel, index) => ({ id: panel.id, x: 0, y: index * 190, width, height: 185 }))
				);
			};
			const observer = new ResizeObserver(resize);
			observer.observe(frame);
			void mountGameUI(frame, context.game.id, context.game.activeSessionId, {
				runtime: context.runtime,
				ephemeral: true,
				blocked: () => operating,
				onready: () => {
					if (!canceled) ready = true;
				},
				onbusy: (value) => {
					if (!canceled) busyModes[kind] = value;
				},
				onerror: (message) => {
					if (!canceled) fail(new Error(message));
				},
				ondiagnostic: (message, detail) => {
					if (!canceled)
						report({
							message,
							failed: true,
							detail: detail instanceof Error ? playgroundFailure(detail) : JSON.stringify(detail)
						});
				},
				onpanels: (next) => {
					panels = next;
					if (!canceled) {
						panelCount = panels.length;
						requestAnimationFrame(resize);
					}
				}
			})
				.then((mounted) => {
					if (canceled) mounted();
					else {
						handle = mounted;
						resize();
					}
				})
				.catch((failure) => {
					if (!canceled) fail(failure);
				});
			return () => {
				canceled = true;
				busyModes[kind] = false;
				observer.disconnect();
				handle?.();
			};
		};
	}
	async function operate(operation: (context: EditorPlaythrough) => Promise<unknown>) {
		const context = current;
		if (!context || busy) return;
		operating = true;
		error = '';
		try {
			await operation(context);
		} catch (failure) {
			fail(failure);
		} finally {
			if (!disposed) operating = false;
		}
	}
	function runAction(event: SubmitEvent) {
		event.preventDefault();
		void operate(async (context) => {
			const name = actionName || tools[0]?.name;
			if (!name) throw Error('실행할 Action을 선택해주세요.');
			await context.action(name, parseGameState(JSON.parse(actionArguments)));
		});
	}
	function runAI(event: SubmitEvent) {
		event.preventDefault();
		streaming = '';
		void operate(async (context) => {
			requestAbort = new AbortController();
			await context.ai(
				aiInput,
				{ visible: true },
				{
					signal: requestAbort.signal,
					onEvent: (event) => {
						if (event.type === 'text') streaming += event.text;
						if (event.type === 'reset') streaming = '';
					}
				}
			);
			aiInput = '';
			streaming = '';
			requestAbort = undefined;
		});
	}
	function restart() {
		resetRequested = false;
		void start('test');
	}
</script>

<section
	class="playground"
	aria-label={mode === 'preview' ? '실행 미리보기' : '테스트 플레이'}
	aria-busy={busy}
>
	<div class="toolbar">
		<strong>{mode === 'preview' ? '실행 미리보기' : '테스트 플레이'}</strong>
		{#if mode === 'test'}
			<button
				type="button"
				disabled={busy}
				onclick={() => (test ? (resetRequested = true) : void start('test'))}
				>{test ? '테스트 다시 시작' : '테스트 시작'}</button
			>
		{:else}<span>{starting ? '새로 실행 중…' : '변경 시 자동 실행'}</span>{/if}
	</div>
	{#if outdated}<p class="notice">
			초안이 변경되었어요. 현재 테스트는 시작할 때의 내용을 유지합니다. 다시 시작하면 최신 초안을
			사용해요.
		</p>{/if}
	{#if error}<p class="error" role="alert">{error}</p>{/if}
	{#if current && timeline}
		<p class="muted">일반 플레이와 분리된 실행 · 리비전 {timeline.history.progress.revision}</p>
		{#if current.game.ui}
			{#key current.game.id}
				<iframe
					title={mode === 'preview' ? '게임 UI 미리보기' : '테스트 게임 UI'}
					sandbox="allow-scripts"
					referrerpolicy="no-referrer"
					style:height={`${frameHeight}px`}
					{@attach attachFrame(current)}
				></iframe>
			{/key}
			{#if !ready}<p class="muted">게임 UI를 실행하고 있어요…</p>{/if}
		{:else}<p class="muted">
				등록된 게임 화면이 없어요. Action과 AI로 게임 로직을 테스트할 수 있어요.
			</p>{/if}
		<div class="messages" aria-label="테스트 대화">
			{#each timeline.messages as message (message.id)}<article>
					<small>{message.role === 'user' ? '플레이어' : '게임'}</small>
					<p>{message.content}</p>
				</article>{/each}
			{#if streaming}<article aria-live="polite">
					<small>게임</small>
					<p>{streaming}</p>
				</article>{/if}
		</div>
		<form onsubmit={runAI}>
			<label
				>AI 입력<textarea
					bind:value={aiInput}
					rows="3"
					disabled={busy}
					placeholder="설정에서 선택한 모델로 테스트합니다"></textarea></label
			>
			<div class="buttons">
				<button disabled={busy || !aiInput.trim()}>AI 실행</button>{#if operating}<button
						type="button"
						onclick={() => requestAbort?.abort()}>중단</button
					>{/if}
			</div>
		</form>
		<details>
			<summary>Action 직접 실행</summary>
			<form onsubmit={runAction}>
				<label
					>Action<input
						list={`editor-actions-${current.game.id}`}
						value={actionName || tools[0]?.name || ''}
						oninput={(event) => (actionName = event.currentTarget.value)}
						disabled={busy}
						placeholder="등록한 Action 이름"
					/></label
				>
				<datalist id={`editor-actions-${current.game.id}`}>
					{#each tools as tool (tool.name)}<option value={tool.name}></option>{/each}
				</datalist>
				<label
					>인자 (JSON)<textarea bind:value={actionArguments} rows="3" disabled={busy}
					></textarea></label
				>
				<button disabled={busy || !(actionName || tools.length)}>Action 실행</button>
			</form>
		</details>
		<details>
			<summary>테스트 상태 · 트랜잭션</summary>
			<pre aria-label="실행 상태">{JSON.stringify(timeline.history.progress.state, null, 2)}</pre>
			<button
				type="button"
				disabled={busy}
				onclick={() => (nextState = JSON.stringify(timeline!.history.progress.state, null, 2))}
				>현재 상태 불러오기</button
			>
			<label
				>다음 상태 (JSON)<textarea bind:value={nextState} rows="6" disabled={busy}
				></textarea></label
			>
			<button
				type="button"
				disabled={busy}
				onclick={() =>
					void operate(async (context) =>
						context.transaction(parseGameState(JSON.parse(nextState)))
					)}>트랜잭션 커밋</button
			>
			<p class="muted">스키마·Filter·Hook을 통과한 변경만 이 테스트에 반영됩니다.</p>
		</details>
		<details>
			<summary>진행 기록 ({timeline.events.length})</summary>
			{#each timeline.events as event (event.id)}<details class="event">
					<summary>{event.summary}</summary>
					<pre>{JSON.stringify(
							{ id: event.id, action: event.action, changes: event.changes },
							null,
							2
						)}</pre>
				</details>{/each}
		</details>
	{:else if !starting}<p class="muted">
			테스트를 시작하면 현재 초안으로 독립적인 플레이를 실행합니다.
		</p>{/if}
</section>

{#if resetRequested}<ConfirmDialog
		title="테스트를 다시 시작할까요?"
		message="현재 테스트 진행 기록을 삭제하고 최신 초안의 초기 상태에서 다시 시작합니다."
		confirmLabel="다시 시작"
		disabled={busy}
		onconfirm={restart}
		oncancel={() => (resetRequested = false)}
	/>{/if}

<style>
	.playground {
		display: flex;
		flex-direction: column;
		gap: 12px;
		min-width: 0;
		padding: 12px;
	}
	.toolbar,
	.buttons {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	.toolbar span,
	.muted,
	small {
		color: var(--text-muted);
		font-size: 11px;
	}
	p {
		margin: 0;
		line-height: 1.6;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.notice {
		padding: 9px;
		border: 1px solid var(--border-strong);
		border-radius: 4px;
	}
	.error {
		color: var(--danger, #ffb3b3);
		overflow-wrap: anywhere;
	}
	iframe {
		display: block;
		width: 100%;
		min-height: 220px;
		border: 1px solid var(--border);
		background: var(--background);
	}
	form,
	label {
		display: flex;
		flex-direction: column;
		gap: 7px;
	}
	form {
		gap: 10px;
	}
	input,
	textarea,
	button {
		font: inherit;
		color: var(--text);
		border: 1px solid var(--border-strong);
		border-radius: 4px;
		background: var(--surface);
	}
	textarea,
	input {
		width: 100%;
		min-width: 0;
		padding: 7px;
	}
	textarea {
		resize: vertical;
	}
	button {
		padding: 6px 9px;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.5;
		cursor: default;
	}
	button:focus-visible,
	textarea:focus-visible,
	input:focus-visible,
	summary:focus-visible {
		outline: 2px solid var(--text-muted);
		outline-offset: 2px;
	}
	details {
		border-top: 1px solid var(--border);
		padding-top: 10px;
	}
	summary {
		cursor: pointer;
		margin-bottom: 9px;
	}
	pre {
		font-size: 11px;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		padding: 8px;
		background: var(--background);
	}
	.messages {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	article {
		border-left: 2px solid var(--border-strong);
		padding-left: 9px;
	}
	.event {
		margin: 6px 0;
	}
</style>
