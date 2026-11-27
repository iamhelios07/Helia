<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';

	import type { SettingsDialogController } from './settings-dialog-controller.svelte.js';

	import { selectAuxiliaryModel, selectDefaultModel } from './model.js';
	import ModelPicker from './ModelPicker.svelte';

	let { controller }: { controller: SettingsDialogController } = $props();
</script>

<div class="global-models">
	<label for="auxiliary-model"><Icon name="chat" size={14} /> 보조 모델</label>
	<select
		id="auxiliary-model"
		value={controller.settings.auxiliaryModelId ?? ''}
		disabled={controller.busy}
		onchange={(event) => {
			const id = event.currentTarget.value;
			void controller.persist(
				() => selectAuxiliaryModel(controller.settings, id || null),
				'보조 모델을 변경했어요.'
			);
		}}
	>
		<option value="">선택 안 함</option>
		{#each controller.settings.models as model (model.id)}
			<option value={model.id}>{model.name}</option>
		{/each}
	</select>
	<ModelPicker
		models={controller.settings.models}
		providers={controller.settings.providers}
		defaultModelId={controller.settings.defaultModelId}
		busy={controller.busy}
		onadd={controller.addModel}
		onedit={controller.editModel}
		ondelete={controller.deleteModel}
		ondefault={(id) => {
			controller.persist(
				() => selectDefaultModel(controller.settings, id),
				'기본 모델을 변경했어요.'
			);
		}}
	/>
	{#if !controller.settings.providers.length}
		<button
			class="secondary-button"
			type="button"
			onclick={() => {
				controller.switchSection('connections');
				controller.beginConnection();
			}}
		>
			API 연결 추가
		</button>
	{/if}
</div>

<style>
	/* Scoped to this panel's own wrapper so no bare element selector leaks
	   into nested components. */
	.global-models label {
		display: block;
		margin-bottom: 9px;
		color: var(--text);
		font-size: 12px;
	}
	.global-models select {
		width: 100%;
		min-width: 0;
		min-height: 41px;
		margin: 0 0 24px;
		padding: 10px 11px;
		border: 1px solid var(--border-strong);
		border-radius: 7px;
		background: var(--background);
		color: var(--text-strong);
		font-size: 12px;
	}
	.global-models select:focus {
		border-color: var(--text-muted);
	}
	.global-models {
		max-width: 920px;
		padding: 27px;
		border: 1px solid var(--border);
		border-radius: 12px;
	}
	.global-models > button {
		display: flex;
		margin: 18px auto 0;
	}
	@media (max-width: 600px) {
		.global-models {
			padding: 20px;
		}
	}
</style>
