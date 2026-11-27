<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';

	import type { SettingsDialogController } from './settings-dialog-controller.svelte.js';

	let { controller }: { controller: SettingsDialogController } = $props();
</script>

{#if controller.modelDraft}
	<dialog
		class="settings-editor-dialog"
		{@attach controller.openModal}
		aria-labelledby="model-editor-heading"
		oncancel={(event) => {
			event.preventDefault();
			controller.cancelModel();
		}}
	>
		<div class="editor-heading">
			<h2 id="model-editor-heading">
				{controller.settings.models.some((model) => model.id === controller.modelDraft?.id)
					? '모델 편집'
					: '모델 추가'}
			</h2>
			<button
				class="icon-button"
				type="button"
				aria-label="모델 편집 닫기"
				onclick={controller.cancelModel}
			>
				<Icon name="close" size={18} />
			</button>
		</div>
		<form onsubmit={controller.saveModel} novalidate>
			<label for="model-name">표시 이름</label>
			<input
				id="model-name"
				bind:value={controller.modelDraft.name}
				placeholder="내가 알아보기 쉬운 이름"
				autocomplete="off"
				required
			/>
			<label for="model-provider">API 연결</label>
			<select id="model-provider" bind:value={controller.modelDraft.providerId}>
				{#each controller.settings.providers as provider (provider.id)}
					<option value={provider.id}>{provider.name}</option>
				{/each}
			</select>
			<label for="model-id">모델 ID</label>
			<input
				id="model-id"
				bind:value={controller.modelDraft.modelId}
				placeholder="서비스에서 제공하는 모델 ID"
				autocomplete="off"
				spellcheck="false"
				required
			/>
			<label for="model-max-tokens">최대 출력 토큰</label>
			<input
				id="model-max-tokens"
				type="number"
				min="1"
				max="65536"
				bind:value={controller.modelDraft.maxOutputTokens}
				placeholder="기본 설정 사용"
			/>
			<p class="field-help">같은 모델도 다른 이름으로 여러 번 추가할 수 있어요.</p>
			{#if controller.modelError}
				<p class="notice" role="alert">{controller.modelError}</p>
			{/if}
			<div class="form-actions">
				<button class="secondary-button" type="button" onclick={controller.cancelModel}>취소</button
				>
				<button class="primary-button" type="submit">모델 저장</button>
			</div>
		</form>
	</dialog>
{/if}

<style>
	/*
	 * Dialog frame, ::backdrop, button styles, disabled opacity and the form
	 * primitives (p/label/input/select) come from the shared rules in
	 * SettingsDialog.svelte, scoped to .settings-editor-dialog. Only
	 * editor-specific rules remain here.
	 */
	.settings-editor-dialog {
		width: min(440px, calc(100vw - 32px));
		max-height: calc(100dvh - 32px);
		padding: 27px;
		border-radius: 13px;
		overflow-y: auto;
	}
	.icon-button {
		display: grid;
		width: 31px;
		height: 31px;
		padding: 0;
		flex-shrink: 0;
		place-items: center;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--text-muted);
	}
	.icon-button:hover {
		background: var(--surface-hover);
		color: var(--text-strong);
	}
	.field-help {
		margin-bottom: 23px;
		color: var(--text-muted);
		font-size: 11px;
		line-height: 1.8;
	}
	.editor-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 15px;
		margin-bottom: 24px;
	}
	.editor-heading h2 {
		font-size: 18px;
		font-weight: 550;
		color: var(--text-strong);
		margin: 0;
	}
	.form-actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 8px;
	}
	@media (max-width: 600px) {
		.primary-button {
			padding: 8px 11px;
		}
	}
</style>
