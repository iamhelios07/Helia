<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';

	import type { EditorWorkspace } from '../editor-workspace.svelte.js';
	import type { DocumentId } from '../editor-workspace.svelte.js';

	import AssetEditor from './AssetEditor.svelte';
	import EditorTabs from './EditorTabs.svelte';
	import SourceEditor from './SourceEditor.svelte';
	import StateEditor from './StateEditor.svelte';
	let { editor }: { editor: EditorWorkspace } = $props();
</script>

{#if editor.draft}<div class="document-workspace">
		<EditorTabs
			tabs={editor.tabs}
			active={editor.activeDocument}
			onselect={(id) => editor.openDocument(id as DocumentId)}
			onclose={editor.closeDocument}
		/>
		{#if editor.activeDocument}<div class="document-breadcrumb">
				<span>게임</span><Icon name="arrow-right" size={11} /><span
					>{editor.documentLabel(editor.activeDocument)}</span
				><span class="breadcrumb-file">{editor.documentFile(editor.activeDocument)}</span
				>{#if !editor.activeDocument.startsWith('code:') && !editor.activeDocument.startsWith('asset:') && editor.activeDocument !== 'types:GameState' && editor.activeDocument !== 'types:HeliaRuntime'}<button
						type="button"
						aria-pressed={editor.sourceDocuments.includes(editor.activeDocument)}
						onclick={() => editor.activeDocument && editor.toggleSource(editor.activeDocument)}
						>{editor.sourceDocuments.includes(editor.activeDocument)
							? 'GUI로 편집'
							: 'JSON으로 편집'}</button
					>{/if}
			</div>{/if}
		<div
			class={['document-panes', { split: editor.splitOpen }]}
			style:--split="{editor.splitRatio}%"
		>
			<div
				class="document"
				id="editor-document"
				role="tabpanel"
				aria-labelledby={editor.activeDocument ? `editor-tab-${editor.activeDocument}` : undefined}
				tabindex="0"
			>
				{#if !editor.activeDocument}<div class="empty-editor">
						<Icon name="edit" size={36} />
						<h2>편집할 문서를 열어주세요</h2>
						<p>왼쪽 탐색기에서 문서를 선택하세요.<br />문서를 닫아도 초안은 유지돼요.</p>
					</div>
				{:else if editor.activeDocument.startsWith('asset:')}
					<AssetEditor
						source={editor.draft.documents.assets}
						selectedId={editor.activeDocument.slice(6)}
						disabled={editor.editingBlocked}
						onchange={(value) => editor.changeDocument('assets', value)}
					/>
				{:else if editor.activeDocument === 'state' && !editor.sourceDocuments.includes('state')}
					<StateEditor
						source={editor.draft.documents.state}
						disabled={editor.editingBlocked}
						onchange={(value) => editor.changeDocument('state', value)}
					/>
				{:else if editor.activeDocument.startsWith('code:') || editor.activeDocument === 'types:GameState' || editor.activeDocument === 'types:HeliaRuntime'}
					<SourceEditor
						project={editor.monacoProject}
						path={editor.codePath(editor.activeDocument) ?? ''}
						value={editor.documentSource}
						label={editor.documentFile(editor.activeDocument) + ' 소스'}
						language={editor.activeDocument.startsWith('code:')
							? (editor.codeProject?.files[editor.activeDocument.slice(5)]?.language ??
								'TypeScript')
							: 'TypeScript'}
						readonly={!editor.activeDocument.startsWith('code:')}
						disabled={editor.editingBlocked}
						location={editor.codeLocation}
						onchange={(value) =>
							editor.activeDocument && editor.updateSource(editor.activeDocument, value)}
					/>
				{:else if editor.activeDocument === 'info' && !editor.sourceDocuments.includes('info') && editor.info}<div
						class="form-document"
					>
						<h2>게임 정보</h2>
						<p class="document-help">라이브러리에 표시되는 게임의 기본 정보예요.</p>
						<fieldset disabled={editor.editingBlocked}>
							<label for="editor-name">이름</label><input
								id="editor-name"
								value={editor.info.title ?? ''}
								oninput={(event) => editor.changeField('info', 'title', event.currentTarget.value)}
							/>
							<label for="editor-genre">장르</label><input
								id="editor-genre"
								value={editor.info.genre ?? ''}
								oninput={(event) => editor.changeField('info', 'genre', event.currentTarget.value)}
								placeholder="게임의 장르"
							/>
							<label for="editor-introduction">소개</label><textarea
								id="editor-introduction"
								rows="5"
								value={editor.info.description ?? ''}
								oninput={(event) =>
									editor.changeField('info', 'description', event.currentTarget.value)}></textarea>
							<p class="field-help">플레이어가 게임을 고를 때 보는 소개예요.</p>
						</fieldset>
						<div class="form-footnote">
							<Icon name="info" size={14} /><span
								>초안은 자동 저장되며, 적용을 눌러야 게임에 반영돼요.</span
							>
						</div>
					</div>
				{:else if editor.activeDocument === 'instructions' && !editor.sourceDocuments.includes('instructions') && editor.instructions}<div
						class="form-document"
					>
						<h2>게임 지침</h2>
						<p class="document-help">AI가 사용하는 게임 설명과 대화의 시작을 작성해요.</p>
						<fieldset disabled={editor.editingBlocked}>
							<label for="editor-description">게임 설명</label><textarea
								id="editor-description"
								rows="6"
								value={editor.instructions.description ?? ''}
								oninput={(event) =>
									editor.changeField('instructions', 'description', event.currentTarget.value)}
							></textarea>
							<label for="editor-opening">첫 메시지</label><textarea
								id="editor-opening"
								rows="6"
								value={editor.instructions.firstMessage ?? ''}
								oninput={(event) =>
									editor.changeField('instructions', 'firstMessage', event.currentTarget.value)}
							></textarea>
							<label for="editor-note">작가 노트</label><textarea
								id="editor-note"
								rows="4"
								value={editor.instructions.authorNote ?? ''}
								oninput={(event) =>
									editor.changeField('instructions', 'authorNote', event.currentTarget.value)}
							></textarea>
						</fieldset>
					</div>
				{:else}<SourceEditor
						project={editor.monacoProject}
						path={'documents/' + editor.activeDocument + '.json'}
						value={editor.documentSource}
						label="{editor.documentLabel(editor.activeDocument)} 소스"
						disabled={editor.editingBlocked}
						onchange={(value) =>
							editor.activeDocument && editor.updateSource(editor.activeDocument, value)}
					/>{/if}
			</div>
			{#if editor.splitOpen}
				<div
					class="split-handle"
					role="slider"
					tabindex="0"
					aria-label="편집기 분할 크기"
					aria-orientation="horizontal"
					aria-valuemin="25"
					aria-valuemax="75"
					aria-valuenow={Math.round(editor.splitRatio)}
					onpointerdown={editor.resizeSplit}
					onpointermove={editor.resizeSplit}
					onkeydown={editor.resizeSplitKey}
				></div>
				<section class="secondary-document" aria-label="보조 편집기">
					<div class="secondary-header">
						<label for="secondary-document">문서</label><select
							id="secondary-document"
							bind:value={editor.secondaryDocument}
							>{#each [...editor.categories
									.flatMap((category) => category.documents)
									.map( (document) => ({ id: document.id, label: document.file }) ), ...Object.keys(editor.codeProject?.files ?? {}).map( (path) => ({ id: 'code:' + path, label: path }) ), { id: 'types:GameState', label: 'GameState.d.ts' }, { id: 'types:HeliaRuntime', label: '.helia/runtime.d.ts' }] as document (document.id)}<option
									value={document.id}>{document.label}</option
								>{/each}</select
						><button
							class="icon-button"
							type="button"
							aria-label="보조 편집기 닫기"
							onclick={() => (editor.splitOpen = false)}><Icon name="close" size={13} /></button
						>
					</div>
					<SourceEditor
						project={editor.monacoProject}
						viewId="secondary"
						path={editor.secondaryPath}
						value={editor.sourceFor(editor.secondaryDocument)}
						readonly={editor.secondaryDocument === 'types:GameState' ||
							editor.secondaryDocument === 'types:HeliaRuntime'}
						language={editor.secondaryLanguage}
						label="보조 {editor.documentLabel(editor.secondaryDocument)} 소스"
						disabled={editor.editingBlocked}
						onchange={(value) => editor.updateSource(editor.secondaryDocument, value)}
					/>
				</section>
			{/if}
		</div>
	</div>
{/if}

<style>
	button,
	input,
	textarea {
		font: inherit;
	}
	button {
		color: inherit;
	}
	button {
		border: 0;
		background: transparent;
	}
	button:disabled {
		opacity: 0.4;
	}
	button:not(:disabled):hover {
		background: var(--surface-hover);
	}
	button:focus-visible {
		outline: 1px solid var(--text);
		outline-offset: -2px;
	}
	p,
	h2 {
		margin: 0;
	}
	button {
		border-radius: 4px;
	}
	.icon-button {
		display: inline-grid;
		place-items: center;
		width: 27px;
		height: 27px;
		padding: 0;
		color: var(--text-muted);
	}
	.document-workspace {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		min-width: 0;
	}
	.document-breadcrumb {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 33px;
		flex-shrink: 0;
		padding: 0 18px;
		color: var(--text-muted);
		font-size: 11px;
		border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
	}
	.breadcrumb-file {
		margin-left: 5px;
		opacity: 0.6;
		font-family: Consolas, monospace;
	}
	.document-breadcrumb button {
		margin-left: auto;
		font-size: 11px;
		padding: 4px 6px;
		white-space: nowrap;
	}
	.document {
		flex: 1;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
		outline-offset: -2px;
	}
	.document-panes {
		display: flex;
		flex: 1;
		min-width: 0;
		min-height: 0;
	}
	.document-panes.split > .document {
		flex: 0 0 var(--split);
		min-width: 0;
	}
	.secondary-document {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
		min-height: 0;
	}
	.secondary-document :global(.source-editor) {
		flex: 1;
		height: 0;
	}
	.secondary-header {
		display: flex;
		align-items: center;
		gap: 8px;
		height: 34px;
		padding: 0 8px;
		border-bottom: 1px solid var(--border);
		font-size: 11px;
	}
	.secondary-header label {
		color: var(--text-muted);
	}
	.secondary-header select {
		min-width: 0;
		flex: 1;
		border: 0;
		background: var(--background);
		color: var(--text);
		font: inherit;
	}
	.split-handle {
		width: 5px;
		flex-shrink: 0;
		cursor: col-resize;
		touch-action: none;
		border-left: 1px solid var(--border);
	}
	.split-handle:hover,
	.split-handle:focus-visible {
		background: var(--surface-active);
	}
	.form-document {
		height: 100%;
		overflow: auto;
		padding: 24px clamp(20px, 3vw, 32px) 35px;
	}
	.form-document h2 {
		font-size: 19px;
		font-weight: 550;
		color: var(--text-strong);
	}
	.document-help {
		font-size: 11px;
		color: var(--text-muted);
		line-height: 1.9;
		max-width: 580px;
		margin: 10px 0 28px;
	}
	.form-document fieldset {
		padding: 0;
		border: 0;
		margin: 0;
		max-width: 700px;
	}
	.form-document label {
		display: block;
		font-size: 11px;
		margin: 22px 0 8px;
		color: var(--text);
	}
	.form-document input,
	.form-document textarea {
		width: 100%;
		border: 1px solid var(--border-strong);
		background: color-mix(in srgb, var(--background) 90%, #000);
		color: var(--text);
		padding: 10px 11px;
		border-radius: 4px;
		font-size: 12px;
		line-height: 1.8;
		outline-offset: -1px;
	}
	.form-document textarea {
		resize: vertical;
		min-height: 85px;
	}
	.form-document input::placeholder {
		color: var(--text-muted);
		opacity: 0.6;
	}
	.field-help {
		font-size: 11px;
		color: var(--text-muted);
		margin-top: 8px;
	}
	.form-footnote {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 30px;
		padding-top: 18px;
		border-top: 1px solid var(--border);
		font-size: 11px;
		color: var(--text-muted);
		max-width: 700px;
	}
	.empty-editor {
		height: 100%;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 16px;
		color: var(--text-muted);
	}
	.empty-editor > :global(svg) {
		opacity: 0.3;
	}
	.empty-editor h2 {
		font-size: 14px;
		font-weight: 500;
	}
	.empty-editor p {
		font-size: 11px;
		text-align: center;
		line-height: 1.9;
	}
	@media (max-width: 800px) {
		.form-document {
			padding: 22px 20px 35px;
		}
		.breadcrumb-file {
			display: none;
		}
		.document-breadcrumb {
			padding-inline: 12px;
		}
	}
</style>
