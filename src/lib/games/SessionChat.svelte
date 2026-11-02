<script lang="ts">
	import { onMount, tick } from 'svelte';
	import Icon from '#lib/components/Icon.svelte';
	import { appendUserMessage, getSessionConversation } from './repository.js';
	import type { Message, Session } from './model.js';

	let {
		gameId,
		sessionId,
		gameTitle,
		draft = $bindable(''),
		onsessionupdate,
		onsavingchange
	}: {
		gameId: string;
		sessionId: string;
		gameTitle: string;
		draft?: string;
		onsessionupdate: (session: Session) => void;
		onsavingchange: (saving: boolean) => void;
	} = $props();

	let messages = $state.raw<Message[]>([]);
	let loading = $state(true);
	let saving = $state(false);
	let loadError = $state('');
	let saveError = $state('');
	let history: HTMLDivElement | undefined;
	let composer: HTMLTextAreaElement | undefined;
	let disposed = false;

	onMount(() => {
		void loadConversation();
		return () => {
			disposed = true;
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
		loading = true;
		loadError = '';
		try {
			const conversation = await getSessionConversation(gameId, sessionId);
			if (disposed) return;
			messages = conversation.messages;
			onsessionupdate(conversation.session);
			void scrollToEnd();
		} catch {
			if (!disposed) loadError = '채팅 기록을 불러오지 못했어요.';
		} finally {
			if (!disposed) loading = false;
		}
	}

	async function sendMessage(event?: SubmitEvent) {
		event?.preventDefault();
		if (loading || saving || loadError || !draft.trim()) return;
		saving = true;
		saveError = '';
		onsavingchange(true);
		const content = draft;
		try {
			const saved = await appendUserMessage(gameId, sessionId, content);
			if (disposed) return;
			messages = [...messages, saved.message];
			draft = '';
			onsessionupdate(saved.session);
			void scrollToEnd();
			composer?.focus();
		} catch {
			if (!disposed) saveError = '메시지를 저장하지 못했어요. 다시 전송해주세요.';
		} finally {
			if (!disposed) {
				saving = false;
				onsavingchange(false);
			}
		}
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229)
			return;
		event.preventDefault();
		void sendMessage();
	}
</script>

<section class="chat" aria-label="채팅">
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
				readonly={saving}
				onkeydown={handleKeydown}></textarea>
			<button
				class="send"
				type="submit"
				aria-label="메시지 전송"
				title="전송"
				disabled={loading || saving || !!loadError || !draft.trim()}
			>
				<Icon name="send" size={20} />
			</button>
		</div>
	</form>
</section>

<style>
	.chat {
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
		background: var(--surface);
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
		color: var(--text);
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
