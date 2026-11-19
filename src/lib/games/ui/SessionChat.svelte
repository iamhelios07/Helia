<script lang="ts">
	import { onMount } from 'svelte';

	import Icon from '#lib/components/Icon.svelte';

	import type { Session } from '../model.js';
	import type { RegexRule } from '../regex.js';
	import type { GameUI } from './runtime/model.js';

	import GenerationStatus from './GenerationStatus.svelte';
	import { RegexDisplay } from './message-regex.svelte.js';
	import MessageContent from './MessageContent.svelte';
	import { SessionChatController } from './sessionchat-controller.svelte.js';
	let {
		gameId,
		sessionId,
		gameTitle,
		draft = $bindable(''),
		onsessionupdate,
		onsavingchange,
		blocked = false,
		chatStyle,
		oncontroller,
		regex
	}: {
		gameId: string;
		sessionId: string;
		gameTitle: string;
		regex?: RegexRule[];
		draft?: string;
		onsessionupdate: (session: Session) => void;
		onsavingchange: (saving: boolean) => void;
		blocked?: boolean;
		chatStyle?: GameUI['chatStyle'];
		oncontroller?: (controller: SessionChatController) => () => void;
	} = $props();
	const chat = new SessionChatController(() => ({
		gameId,
		sessionId,
		gameTitle,
		draft,
		onsessionupdate,
		onsavingchange,
		blocked,
		chatStyle,
		setDraft: (value) => {
			draft = value;
		}
	}));
	const display = new RegexDisplay(() => ({ messages: chat.messages, rules: regex }));
	onMount(() => {
		const dispose = chat.mount();
		const detach = oncontroller?.(chat);
		return () => {
			detach?.();
			dispose();
		};
	});
</script>

<svelte:window onfocus={chat.loadModels} onstorage={chat.loadModels} />

<section
	class="chat"
	aria-label="채팅"
	style:--chat-background={chat.theme?.background}
	style:--chat-color={chat.theme?.color}
	style:--chat-font={chat.theme?.fontFamily}
	style:--chat-user-background={chat.theme?.userBackground}
	style:--chat-assistant-background={chat.theme?.assistantBackground}
>
	<div class="history" {@attach chat.attachHistory}>
		{#if chat.loading}
			<p class="status" role="status">채팅 기록을 불러오는 중…</p>
		{:else if chat.loadError}
			<div class="error">
				<p role="alert">{chat.loadError}</p>
				<button type="button" onclick={chat.loadConversation}>다시 불러오기</button>
			</div>
		{:else}
			<div
				class="messages"
				role="log"
				aria-label="채팅 메시지"
				aria-live="polite"
				aria-relevant="additions"
			>
				{#each display.messages as message (message.id)}
					<article
						class={['message', { player: message.role === 'user' }]}
						aria-label={message.role === 'user' ? '플레이어 메시지' : '게임 메시지'}
					>
						<div class="avatar" aria-hidden="true">
							<Icon name={message.role === 'user' ? 'user' : 'game'} size={20} />
						</div>
						<div class="message-body">
							<h3>
								{message.role === 'user'
									? (chat.persona.persona?.name ?? '플레이어')
									: chat.gameTitle}
							</h3>
							<div class="message-content">
								<MessageContent
									content={message.content}
									context={chat.displayContext}
									appearance={chat.theme}
									onresize={chat.messageResized}
								/>
							</div>
						</div>
					</article>
				{/each}
			</div>
		{/if}
	</div>
	<div class="chat-controls">
		{#if chat.attemptStatus !== 'idle'}
			<GenerationStatus
				context={chat.displayContext}
				monitor={chat.monitor}
				status={chat.attemptStatus}
				label={chat.attemptLabel}
				tools={chat.toolProgress}
				thinking={chat.thinking}
				progressText={chat.progressText}
				appearance={chat.theme}
				onstop={chat.saving ? chat.stopGeneration : undefined}
				onretry={chat.canRetry
					? () => {
							void chat.sendMessage();
						}
					: undefined}
			/>
		{/if}
		<form class="composer" onsubmit={chat.sendMessage} aria-label="메시지 작성">
			{#if display.error}<p class="save-error" role="alert">{display.error}</p>{/if}
			{#if chat.modelError}<p class="save-error" role="alert">{chat.modelError}</p>
			{:else if !chat.selectedModelId}<p class="save-error">
					앱 설정에서 API 연결과 모델을 등록해주세요.
				</p>{/if}
			{#if chat.saveError}<p class="save-error" role="alert">{chat.saveError}</p>{/if}
			<div class="input-row">
				<textarea
					{@attach chat.attachComposer}
					bind:value={chat.draft}
					aria-label="메시지"
					placeholder="메시지 입력"
					rows="1"
					readonly={chat.locked || chat.timelineBusy || chat.blocked}
					onkeydown={chat.handleKeydown}></textarea>
				<button
					class="send"
					type="submit"
					aria-label="메시지 전송"
					title="전송"
					disabled={chat.loading ||
						chat.locked ||
						chat.timelineBusy ||
						chat.blocked ||
						!!chat.loadError ||
						!!chat.modelError ||
						!chat.selectedModelId ||
						!chat.draft.trim()}
				>
					<Icon name="send" size={20} />
				</button>
			</div>
		</form>
	</div>
</section>

<style>
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
	.chat-controls {
		display: flex;
		flex-shrink: 0;
		flex-direction: column;
		gap: 10px;
		box-sizing: border-box;
		width: min(100%, 892px);
		margin-inline: auto;
		padding: 12px 16px;
		padding-bottom: max(12px, env(safe-area-inset-bottom, 0px));
	}
	.composer {
		width: 100%;
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
		.chat-controls {
			padding-inline: 12px;
		}
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
