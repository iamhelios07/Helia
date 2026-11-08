<script lang="ts">
	import { onMount } from 'svelte';

	import Icon from '#lib/components/Icon.svelte';

	import { PROMPT_TYPE_LABELS } from './prompt-labels.js';
	import { PromptSettingsController } from './prompt-settings-controller.svelte.js';
	import PromptBlockEditor from './PromptBlockEditor.svelte';
	let {
		requestChange,
		requestConfirmation
	}: {
		requestChange: (action: () => void, dirty?: boolean) => void;
		requestConfirmation: (
			heading: string,
			message: string,
			label: string,
			action: () => void
		) => void;
	} = $props();
	const controller = new PromptSettingsController(
		(...args) => requestChange(...args),
		(...args) => requestConfirmation(...args)
	);
	const uid = $props.id();
	onMount(() => {
		controller.load();
		return controller.dispose;
	});
	export function hasUnsavedChanges() {
		return controller.draftDirty;
	}
	export function isBusy() {
		return controller.readingFile;
	}
	export function discardDraft() {
		controller.discardDraft();
	}
</script>

<section class="prompt-settings" aria-label="프롬프트 설정" aria-busy={controller.readingFile}>
	{#if !controller.ready}
		{#if controller.error}<p class="notice" role="alert">{controller.error}</p>
			<button type="button" onclick={controller.load}>프롬프트 다시 불러오기</button>{:else}<p
				class="help"
				role="status"
			>
				프롬프트를 불러오는 중…
			</p>{/if}
	{:else if controller.draft}
		<div class="preset-toolbar">
			<label class="preset-select" for={`${uid}-presets`}
				>편집할 프리셋<select
					id={`${uid}-presets`}
					value={controller.draft.id}
					disabled={controller.readingFile}
					onchange={(event) => {
						const id = event.currentTarget.value;
						event.currentTarget.value = controller.draft?.id ?? '';
						const preset = controller.settings.presets.find((preset) => preset.id === id);
						if (preset) {
							requestChange(() => controller.setDraft(preset));
						}
					}}
				>
					{#if !controller.savedDraft}<option value={controller.draft.id}
							>{controller.draft.name} · 저장 전</option
						>{/if}
					{#each controller.settings.presets as preset (preset.id)}<option value={preset.id}
							>{preset.name}{preset.id === controller.settings.selectedPresetId
								? ' · 사용 중'
								: ''}</option
						>{/each}
				</select></label
			>
			<button
				type="button"
				disabled={controller.readingFile || controller.settings.presets.length >= 64}
				onclick={controller.newPreset}><Icon name="plus" size={15} />새 프리셋</button
			>
			<button
				type="button"
				disabled={controller.readingFile || controller.settings.presets.length >= 64}
				onclick={controller.duplicatePreset}>복제</button
			>
			<button
				type="button"
				disabled={controller.readingFile || controller.settings.presets.length >= 64}
				onclick={() => controller.importFileInput?.click()}>가져오기</button
			>
			<input
				type="file"
				hidden
				aria-label="프롬프트 파일"
				accept=".json,.preset,.risupreset,.risup,application/json"
				disabled={controller.readingFile}
				{@attach controller.attachImportFile}
				onchange={controller.readImportFile}
			/>
		</div>
		{#if controller.importError}<p class="notice" role="alert">{controller.importError}</p>{/if}
		{#if controller.readingFile}<p class="help" role="status">프리셋을 가져오는 중…</p>{/if}
		<form onsubmit={controller.savePreset} novalidate>
			<fieldset disabled={controller.readingFile}>
				<div class="editor-heading">
					<h3>{controller.savedDraft ? '프리셋 편집' : '새 프리셋'}</h3>
					{#if controller.activeDraft}<span class="badge">사용 중</span
						>{/if}{#if controller.draftDirty}<span class="help">저장하지 않은 변경 사항</span>{/if}
				</div>
				<label for={`${uid}-name`}
					>프리셋 이름<input
						id={`${uid}-name`}
						bind:value={controller.draft.name}
						maxlength="120"
						autocomplete="off"
					/></label
				>
				<div class="blocks-heading">
					<div>
						<h3>프롬프트 순서</h3>
						<p class="help">위에서 아래 순서로 구성해요. 끈 블록은 전송하지 않아요.</p>
					</div>
					<button
						type="button"
						disabled={controller.blocks.length >= 128}
						onclick={controller.addBlock}>블록 추가</button
					>
				</div>
				<ol class="blocks" aria-label="프롬프트 블록 순서">
					{#each controller.blocks as entry, index (entry.id)}<li class="block">
							<section aria-label={`${index + 1}번 프롬프트 블록`}>
								<div class="block-header">
									<button
										type="button"
										class="block-toggle"
										aria-expanded={controller.openBlockIds.includes(entry.id)}
										aria-controls={`${uid}-block-${entry.id}`}
										onclick={() =>
											(controller.openBlockIds = controller.openBlockIds.includes(entry.id)
												? controller.openBlockIds.filter((id) => id !== entry.id)
												: [...controller.openBlockIds, entry.id])}
										>{entry.value.name || PROMPT_TYPE_LABELS[entry.value.type]}</button
									>
									<label class="block-enabled" title="프롬프트 사용"
										><input
											type="checkbox"
											aria-label={`${index + 1}번 블록 사용`}
											bind:checked={
												() => entry.value.enabled !== false,
												(enabled: boolean) => (entry.value.enabled = enabled)
											}
										/></label
									>
									<div class="block-actions">
										<button
											type="button"
											aria-label={`${index + 1}번 블록 삭제`}
											onclick={() =>
												(controller.blocks = controller.blocks.filter(
													(block) => block.id !== entry.id
												))}><Icon name="close" size={18} /></button
										><button
											type="button"
											aria-label={`${index + 1}번 블록 아래로`}
											disabled={index === controller.blocks.length - 1}
											onclick={() => controller.moveBlock(index, 1)}>↓</button
										><button
											type="button"
											aria-label={`${index + 1}번 블록 위로`}
											disabled={index === 0}
											onclick={() => controller.moveBlock(index, -1)}>↑</button
										>
									</div>
								</div>
								{#if controller.openBlockIds.includes(entry.id)}<div
										id={`${uid}-block-${entry.id}`}
									>
										<PromptBlockEditor bind:block={entry.value} />
									</div>{/if}
							</section>
						</li>{:else}<li class="help">블록을 추가해 프롬프트를 구성하세요.</li>{/each}
				</ol>
				<details class="section-details">
					<summary>생성 옵션</summary>
					<div class="section-content">
						<div class="field-grid">
							<label for={`${uid}-tokens`}
								>최대 출력 토큰<input
									id={`${uid}-tokens`}
									type="number"
									min="1"
									max="65536"
									step="1"
									bind:value={controller.draft.config.maxTokens}
								/></label
							><label for={`${uid}-context`}
								>최대 컨텍스트 글자 수<input
									id={`${uid}-context`}
									type="number"
									min="1024"
									max="2097152"
									step="1"
									bind:value={controller.draft.config.maxContextChars}
								/></label
							>
						</div>
						<label class="check"
							><input type="checkbox" bind:checked={controller.draft.config.jailbreakEnabled} />탈옥
							프롬프트 사용</label
						><label class="check"
							><input type="checkbox" bind:checked={controller.draft.config.cotEnabled} />생각의
							사슬 사용</label
						><label class="check"
							><input
								type="checkbox"
								bind:checked={controller.draft.config.promptSettings.sendChatAsSystem}
							/>시스템으로 채팅 보내기</label
						>
						<label for={`${uid}-end-format`}
							>엔드 뒤 프롬프트<textarea
								id={`${uid}-end-format`}
								bind:value={controller.draft.config.promptSettings.postEndInnerFormat}
								rows="3"></textarea></label
						>
						<label for={`${uid}-prefill`}
							>어시스턴트 프리필<textarea
								id={`${uid}-prefill`}
								bind:value={controller.draft.config.promptSettings.assistantPrefill}
								rows="3"></textarea></label
						>
					</div>
				</details>
				{#if controller.error}<p class="notice" role="alert">{controller.error}</p>{/if}
				<p class="save-status" role="status">{controller.status}</p>
				<div class="form-actions">
					<button type="submit" class="primary" disabled={!controller.draftDirty}
						>프리셋 저장</button
					><button
						type="button"
						disabled={!controller.savedDraft || controller.activeDraft}
						onclick={controller.usePreset}>기본 프롬프트로 사용</button
					><button
						type="button"
						disabled={!controller.savedDraft || controller.settings.presets.length < 2}
						onclick={controller.deletePreset}>프리셋 삭제</button
					><button type="button" onclick={controller.exportPreset}>JSON 내보내기</button>
				</div>
				<p class="help">
					사용 중인 프리셋은 모든 게임의 다음 AI 요청에 적용돼요. 게임의 설명·작가 노트·로어북은
					해당 게임에서 가져와요.
				</p>
			</fieldset>
		</form>
		{#if controller.exportText}<section class="json-panel" aria-label="프롬프트 JSON 내보내기">
				<h3>현재 프리셋 내보내기</h3>
				<label for={`${uid}-export`}
					>내보낼 프롬프트 JSON<textarea
						id={`${uid}-export`}
						value={controller.exportText}
						readonly
						rows="8"
						spellcheck="false"></textarea></label
				><button type="button" onclick={controller.downloadPreset}>JSON 파일 다운로드</button>
			</section>{/if}
	{/if}
</section>

<style>
	.prompt-settings {
		display: grid;
		gap: 22px;
		max-width: 1040px;
	}
	.preset-toolbar,
	.editor-heading,
	.blocks-heading,
	.block-actions,
	.form-actions {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}
	.preset-toolbar {
		align-items: flex-end;
	}
	.preset-select {
		flex: 1 1 250px;
	}
	label {
		display: grid;
		gap: 7px;
		color: var(--text);
		font-size: 12px;
		line-height: 1.65;
		min-width: 0;
	}
	input,
	select,
	textarea {
		box-sizing: border-box;
		width: 100%;
		min-width: 0;
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		padding: 10px;
		background: var(--background);
		color: var(--text-strong);
		font: inherit;
		font-size: 12px;
	}
	input:focus,
	select:focus,
	textarea:focus,
	button:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	textarea {
		resize: vertical;
		line-height: 1.7;
	}
	button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		min-height: 36px;
		border: 1px solid var(--border-strong);
		border-radius: 7px;
		padding: 8px 12px;
		background: var(--surface);
		color: var(--text);
		font: inherit;
		font-size: 12px;
	}
	button:hover:not(:disabled) {
		background: var(--surface-hover);
	}
	button:disabled {
		opacity: 0.4;
	}
	button.primary {
		background: var(--accent);
		color: var(--on-accent);
		border-color: var(--accent);
	}
	form,
	fieldset,
	.section-content,
	.json-panel {
		display: grid;
		gap: 18px;
		min-width: 0;
	}
	fieldset {
		border: 0;
		padding: 0;
		margin: 0;
	}
	h3 {
		margin: 0;
		font-size: 14px;
		color: var(--text-strong);
		font-weight: 550;
	}
	.help,
	.save-status {
		margin: 0;
		color: var(--text-muted);
		font-size: 11px;
		line-height: 1.8;
	}
	.save-status:empty {
		display: none;
	}
	.notice {
		margin: 0;
		padding: 12px;
		border: 1px solid var(--border-strong);
		border-radius: 7px;
		font-size: 12px;
		line-height: 1.8;
	}
	.badge {
		border: 1px solid var(--border-strong);
		border-radius: 4px;
		padding: 2px 6px;
		font-size: 10px;
	}
	.section-details,
	.json-panel {
		border: 1px solid var(--border);
		border-radius: 9px;
		background: var(--surface);
	}
	summary {
		padding: 15px 18px;
		cursor: pointer;
		color: var(--text-strong);
		font-size: 12px;
		overflow-wrap: anywhere;
	}
	.section-content,
	.json-panel {
		padding: 18px;
	}
	.section-details[open] > summary {
		border-bottom: 1px solid var(--border);
	}
	.blocks-heading {
		justify-content: space-between;
		margin-top: 4px;
	}
	.blocks-heading .help {
		margin-top: 5px;
	}
	.blocks {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 12px;
	}
	.block {
		border: 1px solid var(--border);
		border-radius: 9px;
		background: var(--surface);
		overflow: hidden;
		min-width: 0;
	}
	.block-header {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 14px;
	}
	.block-toggle {
		flex: 1;
		min-width: 0;
		padding: 7px 3px;
		border: 0;
		background: transparent;
		text-align: left;
		justify-content: flex-start;
		color: var(--text-strong);
		font-weight: 550;
		overflow-wrap: anywhere;
	}
	.block-toggle:hover:not(:disabled) {
		background: transparent;
		color: var(--text);
	}
	.block-enabled {
		display: flex;
		align-items: center;
		opacity: 0.65;
	}
	.block-enabled input {
		width: 13px;
		height: 13px;
		margin: 0;
		accent-color: var(--accent);
	}
	.block-actions {
		gap: 1px;
		flex-wrap: nowrap;
	}
	.block-actions button {
		min-height: 28px;
		width: 25px;
		padding: 3px;
		border: 0;
		background: transparent;
		font-size: 22px;
		line-height: 1;
	}
	.check {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.check input {
		width: 15px;
		height: 15px;
		flex-shrink: 0;
		margin: 0;
		accent-color: var(--accent);
	}
	.field-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 16px;
	}
	@media (max-width: 600px) {
		.field-grid {
			grid-template-columns: minmax(0, 1fr);
		}
		.preset-toolbar > button {
			flex: 1;
		}
		.form-actions > button {
			flex: 1 1 130px;
		}
		.preset-select {
			flex-basis: 100%;
		}
		.section-content,
		.json-panel {
			padding: 14px;
		}
	}
</style>
