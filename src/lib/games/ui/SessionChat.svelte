<script lang="ts">
	import { onMount, tick } from 'svelte';
	import Icon from '#lib/components/Icon.svelte';
	import SessionHistoryPanel from './SessionHistoryPanel.svelte';
	import type { GameUI } from './runtime/model.js';
	import { safeChatStyle } from './chat-style.js';
	import {
		appendUserMessage,
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
		if (!blocked) queueMicrotask(scheduleRefresh);
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
			saving ||
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
		if (timelineBusy || saving || loading) return;
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
		if (!timeline || timelineBusy || saving || loading || blocked) return false;
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
		const unsubscribe = subscribeSessionChanges(gameId, sessionId, () => {
			refreshPending = true;
			scheduleRefresh();
		});
		void loadConversation();
		return () => {
			disposed = true;
			unsubscribe();
			if (refreshTimer !== undefined) clearTimeout(refreshTimer);
		};
	});

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
		if (loading || saving || timelineBusy || blocked || loadError || !draft.trim()) return;
		requestId += 1;
		const game = gameId;
		const session = sessionId;
		saving = true;
		saveError = '';
		onsavingchange(true);
		const content = draft;
		try {
			const saved = await appendUserMessage(game, session, content);
			if (!isCurrent(game, session)) return;
			messages = [...messages, saved.message];
			draft = '';
			onsessionupdate(saved.session);
			void scrollToEnd();
			composer?.focus();
		} catch {
			if (isCurrent(game, session)) saveError = '메시지를 저장하지 못했어요. 다시 전송해주세요.';
		} finally {
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
		<button
			type="button"
			disabled={loading || saving || timelineBusy || blocked || !!loadError}
			aria-controls={`${uid}-timeline`}
			aria-expanded={showTimeline}
			onclick={toggleTimeline}>이력과 분기</button
		>
	</div>
	{#if showTimeline}
		<div class="timeline-container" id={`${uid}-timeline`}>
			<SessionHistoryPanel
				{timeline}
				busy={timelineBusy || saving || blocked}
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
		{/if}
	</div>
	<form class="composer" onsubmit={sendMessage} aria-label="메시지 작성">
		{#if saveError}<p class="save-error" role="alert">{saveError}</p>{/if}
		<div class="input-row">
			<textarea
				{@attach attachComposer}
				bind:value={draft}
				aria-label="메시지"
				placeholder="메시지 입력"
				rows="1"
				readonly={saving || timelineBusy || blocked}
				onkeydown={handleKeydown}></textarea>
			<button
				class="send"
				type="submit"
				aria-label="메시지 전송"
				title="전송"
				disabled={loading || saving || timelineBusy || blocked || !!loadError || !draft.trim()}
			>
				<Icon name="send" size={20} />
			</button>
		</div>
	</form>
</section>

<style>
	.history-toolbar {
		display: flex;
		justify-content: flex-end;
		padding: 0 0 8px;
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
