<script lang="ts">
	import { onMount } from 'svelte';

	import Icon from '#lib/components/Icon.svelte';

	import type { Session } from '../model.js';
	import type { GameUI } from './runtime/model.js';

	import { SessionChatController } from './sessionchat-controller.svelte.js';
	import SessionHistoryPanel from './SessionHistoryPanel.svelte';
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
	const uid = $props.id();
	const toolLabels = { running: '실행 중', completed: '완료', failed: '실패' };
	const chat = new SessionChatController(() => ({
		gameId,
		sessionId,
		gameTitle,
		draft,
		onsessionupdate,
		onsavingchange,
		blocked,
		chatStyle,
		uid,
		setDraft: (value) => {
			draft = value;
		}
	}));
	onMount(chat.mount);
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
	<div class="history-toolbar">
		<label class="model-select" for={`${chat.uid}-model`}
			>모델
			<select
				id={`${chat.uid}-model`}
				bind:value={chat.selectedModelId}
				disabled={chat.locked}
				onfocus={chat.loadModels}
			>
				{#if !chat.modelSettings.models.length}<option value="">등록된 모델 없음</option>{/if}
				{#each chat.modelSettings.models as model (model.id)}
					<option value={model.id}
						>{model.name} · {chat.modelSettings.providers.find(
							(provider) => provider.id === model.providerId
						)?.name ?? ''}</option
					>
				{/each}
			</select>
		</label>
		<button
			type="button"
			disabled={chat.loading ||
				chat.locked ||
				chat.timelineBusy ||
				chat.blocked ||
				!!chat.loadError}
			aria-controls={`${chat.uid}-timeline`}
			aria-expanded={chat.showTimeline}
			onclick={chat.toggleTimeline}>이력과 분기</button
		>
	</div>
	{#if chat.showTimeline}
		<div class="timeline-container" id={`${chat.uid}-timeline`}>
			<SessionHistoryPanel
				timeline={chat.timeline}
				busy={chat.timelineBusy || chat.locked || chat.blocked}
				error={chat.timelineError}
				onselect={async (id) => {
					await chat.changeTimeline(id);
				}}
				ondelete={(id, revision) => chat.changeTimeline(id, true, revision)}
				onreload={chat.reloadTimeline}
			/>
		</div>
	{/if}
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
				{#each chat.messages as message (message.id)}
					<article
						class={['message', { player: message.role === 'user' }]}
						aria-label={message.role === 'user' ? '플레이어 메시지' : '게임 메시지'}
					>
						<div class="avatar" aria-hidden="true">
							<Icon name={message.role === 'user' ? 'user' : 'game'} size={20} />
						</div>
						<div class="message-body">
							<h3>{message.role === 'user' ? '플레이어' : chat.gameTitle}</h3>
							<div class="message-content">{message.content}</div>
						</div>
					</article>
				{/each}
			</div>
			{#if chat.attemptStatus !== 'idle'}
				<aside class="generation" aria-label="AI 생성 진행">
					<p class="generation-status" role="status">{chat.attemptLabel}</p>
					{#if chat.streamedText && chat.attemptStatus !== 'committed'}
						<div class="message-content" aria-label="저장 전 AI 응답">{chat.streamedText}</div>
					{/if}
					{#if chat.thinking}<details>
							<summary>Thinking</summary>
							<div class="message-content">{chat.thinking}</div>
						</details>{/if}
					{#if chat.progressText}<details>
							<summary>중간 응답</summary>
							<div class="message-content" aria-label="중간 응답 내용">{chat.progressText}</div>
						</details>{/if}
					{#if chat.toolProgress.length}
						<details>
							<summary>도구 진행 · {chat.toolProgress.length}개</summary>
							<ul aria-label="도구 진행">
								{#each chat.toolProgress as tool (tool.id)}
									<li>
										{tool.name} · {toolLabels[tool.status]}
									</li>
								{/each}
							</ul>
						</details>
					{/if}
				</aside>
			{/if}
		{/if}
	</div>
	<form class="composer" onsubmit={chat.sendMessage} aria-label="메시지 작성">
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
			{#if chat.saving}<button
					type="button"
					onclick={chat.stopGeneration}
					disabled={chat.attemptStatus === 'committing' || chat.attemptStatus === 'committed'}
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
