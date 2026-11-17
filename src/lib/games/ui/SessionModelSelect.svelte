<script lang="ts">
	import type { SessionChatController } from './sessionchat-controller.svelte.js';
	let { chat, blocked = false }: { chat: SessionChatController | null; blocked?: boolean } =
		$props();
</script>

<div class="model-region">
	<label>
		<span>모델</span>
		<select
			aria-label="모델"
			value={chat?.selectedModelId ?? ''}
			disabled={!chat || blocked || chat.locked}
			onfocus={() => chat?.loadModels()}
			onchange={(event) => {
				if (chat) {
					chat.selectedModelId = event.currentTarget.value;
				}
			}}
		>
			{#if !chat || !chat.modelSettings.models.length}<option value=""
					>{chat?.modelsLoading ? '모델 불러오는 중…' : '등록된 모델 없음'}</option
				>{/if}
			{#each chat?.modelSettings.models ?? [] as model (model.id)}
				<option value={model.id}
					>{model.name} · {chat?.modelSettings.providers.find(
						(provider) => provider.id === model.providerId
					)?.name ?? ''}</option
				>
			{/each}
		</select>
	</label>
</div>

<style>
	.model-region {
		flex-shrink: 0;
		min-width: 0;
		border-top: 1px solid var(--border);
		margin-top: 12px;
		padding-top: 12px;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 7px;
		color: var(--text-muted);
		font-size: 11px;
	}
	select {
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
	select:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	select:disabled {
		opacity: 0.5;
	}
</style>
