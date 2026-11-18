<script lang="ts">
	import { onMount } from 'svelte';

	import Icon from '#lib/components/Icon.svelte';
	import ItemActions from '#lib/components/ItemActions.svelte';

	import { PersonaSettingsController } from './persona-settings-controller.svelte.js';
	let { requestChange }: { requestChange: (action: () => void, dirty?: boolean) => void } =
		$props();
	const controller = new PersonaSettingsController((...args) => requestChange(...args));
	const uid = $props.id();
	onMount(() => {
		controller.load();
		return controller.dispose;
	});
	export function hasUnsavedChanges() {
		return controller.dirty;
	}
	export function discardDraft() {
		controller.discardDraft();
	}
	export function flushPending() {
		return controller.save();
	}
</script>

<svelte:window onbeforeunload={controller.beforeUnload} />

<section class="persona-settings" aria-label="페르소나 설정">
	{#if controller.error}<p class="notice" role="alert">{controller.error}</p>
		{#if controller.ready && controller.dirty}<button
				type="button"
				onclick={() => controller.save()}><Icon name="activity" size={16} />다시 저장</button
			>{/if}
	{/if}
	{#if !controller.ready}
		<button type="button" onclick={controller.load}
			><Icon name="activity" size={16} />다시 불러오기</button
		>
	{:else}
		<div class="toolbar">
			<label class="current"
				>현재 페르소나
				<select
					value={controller.settings.selectedPersonaId ?? ''}
					onchange={(event) => {
						const id = event.currentTarget.value || null;
						event.currentTarget.value = controller.settings.selectedPersonaId ?? '';
						controller.use(id);
					}}
				>
					<option value="">선택 안 함</option>
					{#each controller.settings.personas as persona (persona.id)}
						<option value={persona.id}>{persona.name}</option>
					{/each}
				</select>
			</label>
			<button
				type="button"
				disabled={controller.settings.personas.length >= 64}
				onclick={controller.create}
			>
				<Icon name="plus" size={16} />새 페르소나
			</button>
		</div>
		<p class="help">현재 페르소나를 따르는 세션에 적용돼요. 고정된 세션의 바인드는 유지돼요.</p>
		<div class="editor">
			<nav aria-label="페르소나 목록">
				{#each controller.settings.personas as persona (persona.id)}
					<div class={['persona-row', { selected: controller.draft?.id === persona.id }]}>
						<button
							class="persona-name"
							type="button"
							aria-pressed={controller.draft?.id === persona.id}
							onclick={() => controller.select(persona)}
						>
							<Icon name="user" size={17} /><span>{persona.name}</span>
							{#if persona.id === controller.settings.selectedPersonaId}<Icon
									name="check"
									size={15}
								/>{/if}
						</button>
						<ItemActions
							name={persona.name}
							onrenamevalue={(name) => controller.rename(persona.id, name)}
							ondelete={() => controller.remove(persona.id)}
							deleteMessage={`“${persona.name}” 페르소나를 삭제할까요? 이 페르소나에 고정된 세션은 사용 안 함으로 바뀝니다.`}
						/>
					</div>
				{:else}<p class="help">저장된 페르소나가 없어요.</p>
				{/each}
			</nav>
			{#if controller.draft}
				<div class="persona-form">
					<div class="editor-heading">
						<h3>{controller.saved ? '페르소나 편집' : '새 페르소나'}</h3>
						<span class="help" role="status">{controller.status}</span>
					</div>
					<label for={`${uid}-name`}
						>이름
						<input
							id={`${uid}-name`}
							bind:value={() => controller.draft!.name, (value) => controller.edit('name', value)}
							onblur={() => controller.save()}
							maxlength="120"
							autocomplete="off"
							required
						/>
					</label>
					<label for={`${uid}-description`}
						>설명
						<textarea
							id={`${uid}-description`}
							bind:value={
								() => controller.draft!.description,
								(value) => controller.edit('description', value)
							}
							onblur={() => controller.save()}
							maxlength="100000"
							rows="12"
							placeholder="플레이할 인물의 외모, 성격, 배경 등을 작성하세요."></textarea>
					</label>
					<div class="actions">
						<button
							type="button"
							disabled={controller.settings.personas.length >= 64}
							onclick={controller.duplicate}
						>
							<Icon name="plus" size={16} />복제
						</button>
						<button
							type="button"
							disabled={!controller.saved ||
								controller.settings.selectedPersonaId === controller.draft.id}
							onclick={() => controller.use(controller.draft!.id)}
							><Icon name="user" size={16} />현재 페르소나로 사용</button
						>
					</div>
				</div>
			{/if}
		</div>
	{/if}
</section>

<style>
	.persona-settings {
		min-width: 0;
	}
	.toolbar,
	.actions,
	.editor-heading {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}
	.current {
		flex: 1;
		max-width: 380px;
	}
	.toolbar {
		align-items: flex-end;
	}
	.editor {
		display: grid;
		grid-template-columns: minmax(150px, 220px) minmax(0, 1fr);
		gap: 24px;
		margin-top: 24px;
	}
	nav {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}
	.persona-row {
		display: flex;
		align-items: center;
		min-width: 0;
		border: 1px solid transparent;
		border-radius: 7px;
		padding-right: 4px;
	}
	.persona-row.selected {
		border-color: var(--border);
		background: var(--surface-active);
	}
	.persona-name {
		flex: 1;
		min-width: 0;
		justify-content: flex-start;
		background: transparent;
		border: 0;
		text-align: left;
	}
	.persona-name span {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.persona-form {
		display: flex;
		flex-direction: column;
		gap: 18px;
		min-width: 0;
	}
	h3 {
		margin: 0;
		color: var(--text-strong);
		font-size: 15px;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 8px;
		color: var(--text-muted);
		font-size: 12px;
	}
	input,
	select,
	textarea {
		width: 100%;
		box-sizing: border-box;
		min-width: 0;
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		padding: 10px;
		background: var(--background);
		color: var(--text);
		font: inherit;
	}
	textarea {
		resize: vertical;
		line-height: 1.65;
	}
	button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 7px;
		padding: 10px 12px;
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		background: var(--surface);
		color: var(--text);
		font: inherit;
		font-size: 12px;
		cursor: pointer;
	}
	button:hover:not(:disabled) {
		background: var(--surface-hover);
	}
	button:disabled {
		opacity: 0.45;
		cursor: default;
	}
	button:focus-visible,
	input:focus-visible,
	select:focus-visible,
	textarea:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.help {
		color: var(--text-muted);
		font-size: 12px;
		line-height: 1.6;
	}
	.notice {
		color: var(--danger, #ef9b9b);
		font-size: 13px;
	}
	@media (max-width: 850px) {
		.editor {
			grid-template-columns: 1fr;
		}
		nav {
			max-height: 180px;
			overflow-y: auto;
		}
	}
</style>
