<script lang="ts">
	import { onMount, tick } from 'svelte';
	import Icon from '#lib/components/Icon.svelte';
	import { invokeSessionAI } from '#lib/games/ai/browser.js';
	import {
		isSessionBusy,
		subscribeSessionActivity,
		subscribeSessionAIEvents
	} from '#lib/games/ai/activity.js';
	import type { AgentEvent } from '#lib/games/ai/protocol.js';
	import { loadAISettings } from '#lib/app/settings/repository.js';
	import { emptyAISettings, type AISettings } from '#lib/app/settings/model.js';
	import SessionHistoryPanel from './SessionHistoryPanel.svelte';
	import type { GameUI } from './runtime/model.js';
	import { safeChatStyle } from './chat-style.js';
	import {
		getSessionConversation,
		getSessionTimeline,
		selectSessionBranch,
		deleteSessionEvent,
		subscribeSessionChanges
	} from '../repository.js';
	import type { SessionTimeline } from '#lib/games/state/history.js';
	import type { Message, Session } from '../model.js';

	let {
		gameId,
		sessionId,
		gameTitle,
		draft = $bindable(''),
		onsessionupdate,
		onsavingchange,
		blocked = false,
		chatStyle
	}: {
		gameId: string;
		sessionId: string;
		gameTitle: string;
		draft?: string;
		onsessionupdate: (session: Session) => void;
		onsavingchange: (saving: boolean) => void;
		blocked?: boolean;
		chatStyle?: GameUI['chatStyle'];
	} = $props();

	let messages = $state.raw<Message[]>([]);
	let loading = $state(true);
	let saving = $state(false);
	let loadError = $state('');
	let saveError = $state('');
	let modelSettings = $state.raw<AISettings>(emptyAISettings());
	let selectedModelId = $state('');
	let modelError = $state('');
	let externalBusy = $state(false);
	let streamedText = $state('');
	let thinking = $state('');
	let progressText = $state('');
	let toolProgress = $state<
		{ id: number; name: string; status: 'running' | 'completed' | 'failed' }[]
	>([]);
	let attemptStatus = $state<
		'idle' | 'generating' | 'committing' | 'committed' | 'failed' | 'cancelled' | 'incomplete'
	>('idle');
	let externalAttempt = false;
	let generation: AbortController | undefined;
	let locked = $derived(saving || externalBusy);
	let attemptLabel = $derived(
		attemptStatus === 'generating'
			? '응답 생성 중…'
			: attemptStatus === 'committing'
				? '응답 저장 중…'
				: attemptStatus === 'committed'
					? '응답 저장 완료'
					: attemptStatus === 'cancelled'
						? '생성 취소됨 · 저장되지 않은 응답'
						: attemptStatus === 'incomplete'
							? '생성 중단 · 저장되지 않은 응답'
							: '생성 실패 · 저장되지 않은 응답'
	);
	let showTimeline = $state(false);
	let timeline = $state.raw<SessionTimeline | null>(null);
	let timelineBusy = $state(false);
	let timelineError = $state('');
	const uid = $props.id();
	let history: HTMLDivElement | undefined;
	let composer: HTMLTextAreaElement | undefined;
	let disposed = false;
	let requestId = 0;
	let refreshPending = false;
	let refreshRunning = false;
	let refreshTimer: ReturnType<typeof setTimeout> | undefined;
	let theme = $derived(safeChatStyle(chatStyle));

	$effect(() => {
		if (!blocked && !locked) queueMicrotask(scheduleRefresh);
	});

	function scheduleRefresh() {
		if (disposed || !refreshPending || refreshTimer !== undefined) return;
		refreshTimer = setTimeout(() => {
			refreshTimer = undefined;
			void refreshConversation();
		}, 0);
	}

	async function refreshConversation() {
		if (
			disposed ||
			!refreshPending ||
			refreshRunning ||
			loading ||
			locked ||
			timelineBusy ||
			blocked
		)
			return;
		refreshPending = false;
		refreshRunning = true;
		const game = gameId;
		const session = sessionId;
		const request = ++requestId;
		try {
			const next = await getSessionTimeline(game, session);
			if (isCurrent(game, session) && request === requestId) {
				const previousTail = messages.at(-1);
				const nextTail = next.messages.at(-1);
				applyTimeline(
					next,
					previousTail?.id !== nextTail?.id || previousTail?.content !== nextTail?.content
				);
				loadError = '';
				timelineError = '';
			}
		} catch {
			if (isCurrent(game, session) && request === requestId)
				timelineError = '이력을 불러오지 못했어요. 다시 시도해주세요.';
		} finally {
			refreshRunning = false;
			scheduleRefresh();
		}
	}

	function isCurrent(game: string, session: string) {
		return !disposed && gameId === game && sessionId === session;
	}

	function applyTimeline(next: SessionTimeline, scroll = true) {
		timeline = next;
		messages = next.messages;
		onsessionupdate(next.session);
		if (scroll) void scrollToEnd();
	}

	async function reloadTimeline() {
		if (timelineBusy || locked || loading) return;
		const game = gameId;
		const session = sessionId;
		const request = ++requestId;
		timelineBusy = true;
		timelineError = '';
		try {
			const next = await getSessionTimeline(game, session);
			if (isCurrent(game, session) && request === requestId) applyTimeline(next);
		} catch {
			if (isCurrent(game, session)) timelineError = '이력을 불러오지 못했어요. 다시 시도해주세요.';
		} finally {
			if (isCurrent(game, session) && request === requestId) timelineBusy = false;
			scheduleRefresh();
		}
	}

	async function changeTimeline(
		id: string | null,
		remove = false,
		expectedRevision?: number
	): Promise<boolean> {
		if (!timeline || timelineBusy || locked || loading || blocked) return false;
		if (!remove && timeline.history.progress.headId === id) return true;
		const game = gameId;
		const session = sessionId;
		const revision = expectedRevision ?? timeline.history.progress.revision;
		requestId += 1;
		timelineBusy = true;
		timelineError = '';
		onsavingchange(true);
		try {
			let next: SessionTimeline;
			if (remove && id !== null) {
				next = await deleteSessionEvent(game, session, id, revision);
			} else {
				await selectSessionBranch(game, session, id, revision);
				next = await getSessionTimeline(game, session);
			}
			if (!isCurrent(game, session)) return false;
			applyTimeline(next);
			return true;
		} catch {
			if (isCurrent(game, session))
				timelineError = '이력을 변경하지 못했어요. 새로고침 후 다시 시도해주세요.';
			return false;
		} finally {
			if (isCurrent(game, session)) {
				timelineBusy = false;
				onsavingchange(false);
				scheduleRefresh();
			}
		}
	}

	function toggleTimeline() {
		showTimeline = !showTimeline;
		if (showTimeline) void reloadTimeline();
	}

	onMount(() => {
		loadModels();
		externalBusy = isSessionBusy(gameId, sessionId);
		const unsubscribeActivity = subscribeSessionActivity(gameId, sessionId, () => {
			externalBusy = isSessionBusy(gameId, sessionId);
			if (!externalBusy && externalAttempt) {
				if (attemptStatus !== 'committed') {
					attemptStatus = 'incomplete';
					finishInterruptedTools();
				}
				externalAttempt = false;
			}
		});
		const unsubscribeAIEvents = subscribeSessionAIEvents(gameId, sessionId, (event) => {
			if (saving) return;
			if (event.type === 'status' && event.status === 'generating') {
				externalAttempt = true;
				resetAttempt();
			}
			receiveAgentEvent(event);
		});
		const unsubscribe = subscribeSessionChanges(gameId, sessionId, () => {
			refreshPending = true;
			scheduleRefresh();
		});
		void loadConversation();
		return () => {
			disposed = true;
			generation?.abort();
			unsubscribeActivity();
			unsubscribeAIEvents();
			unsubscribe();
			if (refreshTimer !== undefined) clearTimeout(refreshTimer);
		};
	});

	function loadModels() {
		if (saving) return;
		try {
			modelSettings = loadAISettings();
			if (!modelSettings.models.some((model) => model.id === selectedModelId))
				selectedModelId = modelSettings.defaultModelId ?? modelSettings.models[0]?.id ?? '';
			modelError = '';
		} catch (error) {
			modelError = error instanceof Error ? error.message : '모델 설정을 불러오지 못했어요.';
		}
	}

	function receiveAgentEvent(event: AgentEvent) {
		if (event.type === 'error') {
			saveError = event.message;
			attemptStatus = 'incomplete';
			finishInterruptedTools();
		} else if (event.type === 'reset') streamedText = '';
		else if (event.type === 'text') streamedText += event.text;
		else if (event.type === 'thinking') thinking += event.text;
		else if (event.type === 'progress')
			progressText += `${progressText ? '\n\n' : ''}${event.text}`;
		else if (event.type === 'tool') {
			const running = toolProgress.findLast(
				(tool) => tool.name === event.name && tool.status === 'running'
			);
			if (event.status === 'running' || !running)
				toolProgress.push({ id: toolProgress.length, name: event.name, status: event.status });
			else running.status = event.status;
		} else attemptStatus = event.status;
		void scrollToEnd();
	}

	function resetAttempt() {
		saveError = '';
		streamedText = '';
		thinking = '';
		progressText = '';
		toolProgress = [];
		attemptStatus = 'generating';
	}

	function finishInterruptedTools() {
		for (const tool of toolProgress) {
			if (tool.status === 'running') tool.status = 'failed';
		}
	}

	function stopGeneration() {
		generation?.abort();
	}

	function attachHistory(element: HTMLDivElement) {
		history = element;
		return () => {
			history = undefined;
		};
	}

	function attachComposer(element: HTMLTextAreaElement) {
		composer = element;
		return () => {
			composer = undefined;
		};
	}

	async function scrollToEnd() {
		await tick();
		if (!disposed && history) history.scrollTop = history.scrollHeight;
	}

	async function loadConversation() {
		const game = gameId;
		const session = sessionId;
		loading = true;
		loadError = '';
		try {
			const conversation = await getSessionConversation(game, session);
			if (!isCurrent(game, session)) return;
			messages = conversation.messages;
			onsessionupdate(conversation.session);
			void scrollToEnd();
		} catch {
			if (isCurrent(game, session)) loadError = '채팅 기록을 불러오지 못했어요.';
		} finally {
			if (isCurrent(game, session)) loading = false;
			scheduleRefresh();
		}
	}

	async function sendMessage(event?: SubmitEvent) {
		event?.preventDefault();
		if (loading || locked || timelineBusy || blocked || loadError || !draft.trim()) return;
		loadModels();
		if (modelError || !selectedModelId) return;
		requestId += 1;
		const game = gameId;
		const session = sessionId;
		saving = true;
		resetAttempt();
		const controller = new AbortController();
		generation = controller;
		onsavingchange(true);
		const content = draft;
		try {
			const saved = await invokeSessionAI(
				game,
				session,
				{ text: content, modelId: selectedModelId },
				{
					signal: controller.signal,
					onEvent: (event) => {
						if (isCurrent(game, session)) receiveAgentEvent(event);
					}
				}
			);
			if (!isCurrent(game, session)) return;
			applyTimeline(saved);
			attemptStatus = 'committed';
			draft = '';
			void scrollToEnd();
			composer?.focus();
		} catch (error) {
			if (isCurrent(game, session)) {
				attemptStatus = controller.signal.aborted ? 'cancelled' : 'failed';
				finishInterruptedTools();
				saveError = controller.signal.aborted
					? '생성을 취소했어요. 입력 내용은 유지돼요.'
					: error instanceof Error
						? error.message
						: '응답을 생성하지 못했어요. 다시 시도해주세요.';
			}
		} finally {
			if (generation === controller) generation = undefined;
			if (isCurrent(game, session)) {
				saving = false;
				onsavingchange(false);
				scheduleRefresh();
			}
		}
		if (isCurrent(game, session) && showTimeline) void reloadTimeline();
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229)
			return;
		event.preventDefault();
		void sendMessage();
	}
</script>

<svelte:window onfocus={loadModels} onstorage={loadModels} />

<section
	class="chat"
	aria-label="채팅"
	style:--chat-background={theme?.background}
	style:--chat-color={theme?.color}
	style:--chat-font={theme?.fontFamily}
	style:--chat-user-background={theme?.userBackground}
	style:--chat-assistant-background={theme?.assistantBackground}
>
	<div class="history-toolbar">
		<label class="model-select" for={`${uid}-model`}
			>모델
			<select
				id={`${uid}-model`}
				bind:value={selectedModelId}
				disabled={locked}
				onfocus={loadModels}
			>
				{#if !modelSettings.models.length}<option value="">등록된 모델 없음</option>{/if}
				{#each modelSettings.models as model (model.id)}
					<option value={model.id}
						>{model.name} · {modelSettings.providers.find(
							(provider) => provider.id === model.providerId
						)?.name ?? ''}</option
					>
				{/each}
			</select>
		</label>
		<button
			type="button"
			disabled={loading || locked || timelineBusy || blocked || !!loadError}
			aria-controls={`${uid}-timeline`}
			aria-expanded={showTimeline}
			onclick={toggleTimeline}>이력과 분기</button
		>
	</div>
	{#if showTimeline}
		<div class="timeline-container" id={`${uid}-timeline`}>
			<SessionHistoryPanel
				{timeline}
				busy={timelineBusy || locked || blocked}
				error={timelineError}
				onselect={async (id) => {
					await changeTimeline(id);
				}}
				ondelete={(id, revision) => changeTimeline(id, true, revision)}
				onreload={reloadTimeline}
			/>
		</div>
	{/if}
	<div class="history" {@attach attachHistory}>
		{#if loading}
			<p class="status" role="status">채팅 기록을 불러오는 중…</p>
		{:else if loadError}
			<div class="error">
				<p role="alert">{loadError}</p>
				<button type="button" onclick={loadConversation}>다시 불러오기</button>
			</div>
		{:else}
			<div
				class="messages"
				role="log"
				aria-label="채팅 메시지"
				aria-live="polite"
				aria-relevant="additions"
			>
				{#each messages as message (message.id)}
					<article
						class={['message', { player: message.role === 'user' }]}
						aria-label={message.role === 'user' ? '플레이어 메시지' : '게임 메시지'}
					>
						<div class="avatar" aria-hidden="true">
							<Icon name={message.role === 'user' ? 'user' : 'game'} size={20} />
						</div>
						<div class="message-body">
							<h3>{message.role === 'user' ? '플레이어' : gameTitle}</h3>
							<div class="message-content">{message.content}</div>
						</div>
					</article>
				{/each}
			</div>
			{#if attemptStatus !== 'idle'}
				<aside class="generation" aria-label="AI 생성 진행">
					<p class="generation-status" role="status">{attemptLabel}</p>
					{#if streamedText && attemptStatus !== 'committed'}
						<div class="message-content" aria-label="저장 전 AI 응답">{streamedText}</div>
					{/if}
					{#if thinking}<details>
							<summary>Thinking</summary>
							<div class="message-content">{thinking}</div>
						</details>{/if}
					{#if progressText}<details>
							<summary>중간 응답</summary>
							<div class="message-content" aria-label="중간 응답 내용">{progressText}</div>
						</details>{/if}
					{#if toolProgress.length}
						<details>
							<summary>도구 진행 · {toolProgress.length}개</summary>
							<ul aria-label="도구 진행">
								{#each toolProgress as tool (tool.id)}
									<li>
										{tool.name} · {tool.status === 'running'
											? '실행 중'
											: tool.status === 'completed'
												? '완료'
												: '실패'}
									</li>
								{/each}
							</ul>
						</details>
					{/if}
				</aside>
			{/if}
		{/if}
	</div>
	<form class="composer" onsubmit={sendMessage} aria-label="메시지 작성">
		{#if modelError}<p class="save-error" role="alert">{modelError}</p>
		{:else if !selectedModelId}<p class="save-error">
				앱 설정에서 API 연결과 모델을 등록해주세요.
			</p>{/if}
		{#if saveError}<p class="save-error" role="alert">{saveError}</p>{/if}
		<div class="input-row">
			<textarea
				{@attach attachComposer}
				bind:value={draft}
				aria-label="메시지"
				placeholder="메시지 입력"
				rows="1"
				readonly={locked || timelineBusy || blocked}
				onkeydown={handleKeydown}></textarea>
			<button
				class="send"
				type="submit"
				aria-label="메시지 전송"
				title="전송"
				disabled={loading ||
					locked ||
					timelineBusy ||
					blocked ||
					!!loadError ||
					!!modelError ||
					!selectedModelId ||
					!draft.trim()}
			>
				<Icon name="send" size={20} />
			</button>
			{#if saving}<button
					type="button"
					onclick={stopGeneration}
					disabled={attemptStatus === 'committing' || attemptStatus === 'committed'}
					>생성 중지</button
				>{/if}
		</div>
	</form>
</section>

<style>
	.history-toolbar {
		display: flex;
		gap: 10px;
		align-items: center;
		flex-wrap: wrap;
		justify-content: flex-end;
		padding: 0 0 8px;
	}
	.model-select {
		display: flex;
		gap: 8px;
		align-items: center;
		margin-right: auto;
		font-size: 12px;
		min-width: 0;
	}
	.model-select select {
		min-width: 0;
		max-width: 260px;
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 8px;
		background: var(--surface);
		color: var(--text);
		font: inherit;
	}
	.generation {
		width: min(100%, 860px);
		box-sizing: border-box;
		margin: 0 auto 16px;
		padding: 16px 20px;
		border: 1px solid var(--border);
		border-radius: 10px;
	}
	.generation-status,
	.generation details {
		color: var(--text-muted);
		font-size: 12px;
		line-height: 1.7;
	}
	.generation-status {
		margin: 0 0 8px;
	}
	.generation details {
		margin-top: 8px;
	}
	.generation summary {
		cursor: pointer;
	}
	.timeline-container {
		min-height: 0;
		max-height: 45%;
		overflow-y: auto;
		flex-shrink: 0;
		margin-bottom: 8px;
	}
	.chat {
		background: var(--chat-background, transparent);
		color: var(--chat-color, var(--text));
		font-family: var(--chat-font, inherit);
		display: flex;
		min-height: 0;
		min-width: 0;
		flex: 1;
		flex-direction: column;
	}
	.history {
		min-height: 0;
		flex: 1;
		overflow-y: auto;
		overscroll-behavior: contain;
		scrollbar-width: thin;
	}
	.messages {
		width: min(100%, 860px);
		margin-inline: auto;
		padding: 24px 0;
	}
	.message {
		display: flex;
		gap: 14px;
		padding: 22px 20px;
		border-radius: 10px;
	}
	.message.player {
		background: var(--chat-user-background, var(--surface));
	}
	.message:not(.player) {
		background: var(--chat-assistant-background, transparent);
	}
	.avatar {
		display: grid;
		width: 36px;
		height: 36px;
		flex-shrink: 0;
		place-items: center;
		border: 1px solid var(--border);
		border-radius: 10px;
		color: var(--text-muted);
	}
	.message-body {
		min-width: 0;
		flex: 1;
	}
	h3 {
		margin: 0 0 10px;
		color: var(--text-strong);
		font-size: 13px;
		font-weight: 550;
		overflow-wrap: anywhere;
	}
	.message-content {
		color: var(--chat-color, var(--text));
		font-size: 14px;
		line-height: 1.85;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.composer {
		width: min(100%, 860px);
		margin-inline: auto;
		padding-top: 16px;
		padding-bottom: env(safe-area-inset-bottom);
	}
	.input-row {
		display: flex;
		min-width: 0;
		gap: 10px;
		align-items: flex-end;
		padding: 10px;
		border: 1px solid var(--border-strong);
		border-radius: 12px;
		background: var(--surface);
	}
	.input-row:focus-within {
		border-color: var(--text-muted);
	}
	textarea {
		width: 100%;
		min-width: 0;
		min-height: 38px;
		max-height: 180px;
		field-sizing: content;
		resize: none;
		padding: 8px 4px;
		border: 0;
		outline: none;
		background: transparent;
		color: var(--text-strong);
		font: inherit;
		font-size: 14px;
		line-height: 1.6;
	}
	textarea::placeholder {
		color: var(--text-muted);
	}
	button {
		border: 1px solid var(--border-strong);
		border-radius: 8px;
		background: var(--surface);
		color: var(--text);
		padding: 8px 12px;
		font: inherit;
		font-size: 12px;
	}
	.send {
		display: grid;
		width: 38px;
		height: 38px;
		flex-shrink: 0;
		place-items: center;
		padding: 0;
		background: var(--surface-active);
		color: var(--text-strong);
	}
	button:hover:not(:disabled) {
		background: var(--surface-hover);
	}
	button:disabled {
		opacity: 0.35;
		cursor: default;
	}
	.status,
	.error,
	.save-error {
		color: var(--text-muted);
		font-size: 12px;
		line-height: 1.7;
	}
	.status,
	.error {
		padding: 20px;
	}
	.save-error {
		margin: 0 0 10px;
		color: var(--text-strong);
	}
	@media (max-width: 640px) {
		.message {
			gap: 10px;
			padding: 18px 8px;
		}
		.avatar {
			width: 28px;
			height: 28px;
			border-radius: 8px;
		}
		.message-content {
			font-size: 13px;
		}
		.messages {
			padding: 12px 0;
		}
	}
</style>
