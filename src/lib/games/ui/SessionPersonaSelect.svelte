<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';

	import type { SessionChatController } from './sessionchat-controller.svelte.js';
	let { chat, blocked = false }: { chat: SessionChatController | null; blocked?: boolean } =
		$props();
</script>

<section class="persona-region" aria-label="세션 페르소나">
	<label>
		<span><Icon name="user" size={14} />페르소나 바인드</span>
		<select
			aria-label="페르소나 바인드"
			value={chat?.persona.selection ?? ':current'}
			disabled={!chat || blocked || chat.locked || !chat.persona.ready}
			onfocus={() => chat?.persona.load()}
			onchange={(event) => chat?.persona.select(event.currentTarget.value)}
		>
			<option value=":current"
				>현재 페르소나 사용 ({chat?.persona.currentName ?? '선택 안 함'})</option
			>
			<option value=":none">사용 안 함</option>
			{#each chat?.persona.settings.personas ?? [] as persona (persona.id)}
				<option value={persona.id}>{persona.name}</option>
			{/each}
		</select>
	</label>
	{#if chat?.persona.error}
		<p class="error" role="alert">{chat.persona.error}</p>
		<button type="button" onclick={chat.persona.load}
			><Icon name="activity" size={14} />다시 불러오기</button
		>
	{:else}
		<div class="bound-persona">
			<Icon name="user" size={17} />
			<span>{chat?.persona.persona?.name ?? '페르소나 사용 안 함'}</span>
			{#if chat && ![':current', ':none'].includes(chat.persona.selection)}<Icon
					name="check"
					size={14}
				/>{/if}
		</div>
	{/if}
</section>

<style>
	.persona-region {
		flex-shrink: 0;
		min-width: 0;
		margin-top: 18px;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 7px;
		color: var(--text-muted);
		font-size: 11px;
	}
	label > span {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	select,
	button {
		width: 100%;
		min-width: 0;
		padding: 9px 8px;
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		background: var(--surface);
		color: var(--text);
		font: inherit;
		font-size: 12px;
	}
	select:disabled {
		opacity: 0.5;
	}
	select:focus-visible,
	button:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.bound-persona {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: 12px 9px;
		margin-top: 8px;
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--text);
		font-size: 12px;
	}
	.bound-persona span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.error {
		color: var(--danger, #ef9b9b);
		font-size: 12px;
	}
	button {
		display: flex;
		justify-content: center;
		align-items: center;
		gap: 6px;
		cursor: pointer;
	}
</style>
