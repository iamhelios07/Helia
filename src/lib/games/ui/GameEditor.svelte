<script lang="ts">
	import { resolve } from '$app/paths';

	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import { isDesktopBuild } from '#lib/platform/index.js';

	import { EDITOR_LAYOUT_LIMITS } from '../editor-layout.js';
	import { EditorWorkspace, type DocumentId } from './editor-workspace.svelte.js';
	import AssetExplorer from './editor/AssetExplorer.svelte';
	import CodeExplorer from './editor/CodeExplorer.svelte';
	import EditorDocumentWorkspace from './editor/EditorDocumentWorkspace.svelte';
	import EditorInspectorPanel from './editor/EditorInspectorPanel.svelte';
	import EditorPlayground from './editor/EditorPlayground.svelte';
	let { gameId }: { gameId: string } = $props();
	const editor = new EditorWorkspace(() => gameId);
</script>

<svelte:head><title>{editor.game?.title ?? '게임'} 편집기 · Helia</title></svelte:head>
<svelte:window
	onkeydown={editor.shortcuts}
	onpagehide={() => {
		if (editor.draft && editor.changed && !editor.editingBlocked) {
			void editor.persistDraft();
		}
	}}
/>
<main class="game-editor" aria-label="게임 편집기">
	<header class="editor-header">
		<div class="title-group">
			<Icon name="edit" size={17} />
			<h1>게임 편집기</h1>
			<span class="slash">/</span><span class="game-title"
				>{editor.info?.title ?? editor.game?.title ?? '불러오는 중'}</span
			>
		</div>
		{#if editor.draft}<span class={['save-status', { failed: !!editor.saveError }]} role="status"
				><span class="status-dot"></span>{editor.draftStatus}{#if editor.changed}<span
						class="unapplied">미적용</span
					>{/if}</span
			>{/if}
		<div class="header-actions">
			<button
				class="icon-button"
				type="button"
				aria-label="편집기 좌우 분할"
				aria-pressed={editor.splitOpen}
				onclick={() => (editor.splitOpen = !editor.splitOpen)}
				title="편집기 좌우 분할"><span aria-hidden="true">◫</span></button
			>
			<button
				class="icon-button"
				type="button"
				aria-label="탐색기"
				aria-expanded={editor.explorerOpen}
				onclick={() => (editor.explorerOpen = !editor.explorerOpen)}
				title="탐색기"><Icon name="folder" size={16} /></button
			>
			<button
				class="icon-button"
				type="button"
				aria-label="미리보기"
				aria-expanded={editor.previewOpen}
				onclick={() => (editor.previewOpen = !editor.previewOpen)}
				title="미리보기"><Icon name="grid" size={16} /></button
			>
			{#if editor.draft}<button
					class="apply"
					type="button"
					disabled={!editor.canApply}
					onclick={editor.apply}
					title="게임에 적용 (Ctrl+Enter)"
					><Icon name="check" size={14} />{editor.applying ? '적용 중…' : '적용'}</button
				>{/if}
			<a
				class="return-link"
				aria-label="플레이로 돌아가기"
				href={resolve('/games/[id]', { id: editor.gameId })}
				aria-disabled={editor.editingBlocked}
				onclick={editor.returnToPlay}
				><Icon name="arrow-left" size={15} /><span>플레이로 돌아가기</span></a
			>
		</div>
	</header>
	{#if editor.discardRequested}<ConfirmDialog
			title="초안 버리기"
			message="저장된 미적용 초안을 모두 버리고 적용된 콘텐츠로 돌아갈까요?"
			confirmLabel="초안 버리기"
			disabled={editor.editingBlocked}
			onconfirm={editor.discard}
			oncancel={() => (editor.discardRequested = false)}
		/>{/if}
	{#if editor.navigationError}<div class="error-banner" role="alert">
			{editor.navigationError}
		</div>{/if}
	{#if editor.loading}<div class="load-state" role="status">게임을 불러오는 중…</div>
	{:else if editor.loadError}<div class="load-state">
			<p role="alert">{editor.loadError}</p>
			<button type="button" onclick={editor.load}>다시 불러오기</button>
		</div>
	{:else if editor.missing}<div class="load-state"><h2>게임을 찾을 수 없어요</h2></div>
	{:else if editor.recoveryError}<div class="load-state">
			<p role="alert">{editor.recoveryError}</p>
			{#if editor.saveError}<p role="alert">{editor.saveError}</p>{/if}
			<div>
				<button type="button" onclick={editor.load}>초안 다시 읽기</button><button
					type="button"
					onclick={() => (editor.discardRequested = true)}>적용된 콘텐츠로 다시 시작</button
				>
			</div>
		</div>
	{:else if editor.draft && editor.game}
		{#if editor.saveError}<div class="error-banner" role="alert">
				{editor.saveError}<button type="button" onclick={editor.persistDraft}
					>초안 저장 다시 시도</button
				>
			</div>{/if}
		{#if editor.applyError}<div class="error-banner" role="alert">{editor.applyError}</div>{/if}
		<div
			class="workspace"
			bind:clientWidth={editor.workspaceWidth}
			style:--explorer-width="{editor.displayedExplorerWidth}px"
			style:--preview-width="{editor.displayedPreviewWidth}px"
		>
			{#if editor.explorerOpen}<aside class="explorer" aria-label="게임 탐색기">
					<div class="section-heading">
						<span>탐색기</span><span class="local-label"
							>{isDesktopBuild ? '기기 저장' : '서버 저장'}</span
						>
					</div>
					<div class="project-title">
						<Icon name="folder" size={14} /><span>{editor.info?.title ?? editor.game.title}</span>
					</div>
					<nav aria-label="게임 문서">
						{#each editor.categories as category (category.title)}<section
								class="explorer-category"
							>
								<h2><Icon name={category.icon} size={13} />{category.title}</h2>
								{#each category.documents as document (document.id)}<button
										type="button"
										class={['file', { selected: editor.activeDocument === document.id }]}
										aria-current={editor.activeDocument === document.id ? 'page' : undefined}
										onclick={() => editor.openDocument(document.id)}
										><span class="file-mark" aria-hidden="true">{'{}'}</span><span
											>{document.file}</span
										>{#if editor.documentDirty(document.id)}<span
												class="modified-dot"
												aria-label="미적용 변경">●</span
											>{/if}</button
									>{/each}
							</section>{/each}
						<AssetExplorer
							source={editor.draft.documents.assets}
							active={editor.activeDocument?.startsWith('asset:')
								? editor.activeDocument.slice(6)
								: null}
							disabled={editor.editingBlocked}
							onselect={(id) => editor.openDocument(('asset:' + id) as DocumentId)}
							onchange={(value) => editor.changeDocument('assets', value)}
						/>
						<CodeExplorer
							source={editor.draft.documents.code}
							active={editor.codeSelection}
							disabled={editor.editingBlocked}
							onselect={(path) => {
								if (path) {
									const id = editor.documentForPath(path);
									if (id) {
										editor.openDocument(id);
									}
								} else {
									editor.codeSelection = null;
								}
							}}
							onchange={(value) => editor.changeDocument('code', value)}
							onmove={editor.moveCode}
							onremove={editor.removeCode}
						/>
					</nav>
					<div class="explorer-note">
						<span>변경은 초안으로 저장되며 적용을 눌러야 게임에 반영돼요.</span
						>{#if editor.changed}<button
								type="button"
								disabled={editor.editingBlocked}
								onclick={() => (editor.discardRequested = true)}>변경 취소</button
							>{/if}
					</div>
				</aside>
				<div
					class="edge-handle explorer-handle"
					role="slider"
					tabindex="0"
					aria-label="탐색기 너비 조절"
					aria-orientation="horizontal"
					aria-valuemin={EDITOR_LAYOUT_LIMITS.explorer.min}
					aria-valuemax={Math.round(editor.maxExplorerWidth)}
					aria-valuenow={Math.round(editor.displayedExplorerWidth)}
					onpointerdown={(event) => editor.resizeEdge(event, 'explorer')}
					onpointermove={(event) => editor.resizeEdge(event, 'explorer')}
					onpointerup={editor.saveLayout}
					onpointercancel={editor.saveLayout}
					onkeydown={(event) => editor.resizeEdgeKey(event, 'explorer')}
				></div>{/if}
			<div
				class="editor-stack"
				bind:clientHeight={editor.editorStackHeight}
				style:--bottom-height="{editor.displayedBottomHeight}px"
			>
				<EditorDocumentWorkspace {editor} />
				<EditorInspectorPanel {editor} />
			</div>
			{#if editor.previewOpen}<div
					class="edge-handle preview-handle"
					role="slider"
					tabindex="0"
					aria-label="미리보기 너비 조절"
					aria-orientation="horizontal"
					aria-valuemin={EDITOR_LAYOUT_LIMITS.preview.min}
					aria-valuemax={Math.round(editor.maxPreviewWidth)}
					aria-valuenow={Math.round(editor.displayedPreviewWidth)}
					onpointerdown={(event) => editor.resizeEdge(event, 'preview')}
					onpointermove={(event) => editor.resizeEdge(event, 'preview')}
					onpointerup={editor.saveLayout}
					onpointercancel={editor.saveLayout}
					onkeydown={(event) => editor.resizeEdgeKey(event, 'preview')}
				></div>{/if}
			<aside
				class="preview"
				aria-label="초안 미리보기"
				style:display={editor.previewOpen ? undefined : 'none'}
			>
				<div class="section-heading">
					<span>미리보기</span><button
						type="button"
						class="icon-button"
						aria-label="미리보기 닫기"
						onclick={() => (editor.previewOpen = false)}><Icon name="close" size={14} /></button
					>
				</div>
				<div class="playground-tabs">
					<button
						type="button"
						aria-pressed={editor.previewMode === 'preview'}
						onclick={() => (editor.previewMode = 'preview')}>실행 미리보기</button
					>
					<button
						type="button"
						aria-pressed={editor.previewMode === 'test'}
						onclick={() => (editor.previewMode = 'test')}>테스트 플레이</button
					>
				</div>
				<div class="preview-body">
					{#if editor.previewContent}<EditorPlayground
							game={editor.previewContent}
							mode={editor.previewMode}
							ondiagnostic={(entry) =>
								editor.log(
									entry.detail ? entry.message + '\n' + entry.detail : entry.message,
									entry.failed
								)}
							onstate={(state) => (editor.runtimeState = state)}
						/>{/if}
				</div>
			</aside>
		</div>
		<footer class="status-bar">
			{#if editor.layoutWarning}<span title={editor.layoutWarning}>패널 크기 저장 안 됨</span>{/if}
			<span><Icon name="edit" size={11} />{isDesktopBuild ? '기기 저장' : '서버 저장'}</span><span
				>{editor.changed ? '게임에 적용되지 않은 변경이 있어요' : '적용된 콘텐츠와 일치해요'}</span
			><span class="status-right"
				>{editor.activeDocument && !editor.activeDocument.startsWith('asset:')
					? `${editor.documentSource.length.toLocaleString()}자 · ${editor.activeDocument.startsWith('code:') || editor.activeDocument.startsWith('types:') ? '코드' : 'JSON'}`
					: '게임 편집기'}</span
			>
		</footer>
	{/if}
</main>

<style>
	.game-editor {
		height: 100dvh;
		min-height: 420px;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		color: var(--text);
		background: var(--background);
		font-size: 12px;
	}
	button,
	a {
		font: inherit;
	}
	button,
	a {
		color: inherit;
	}
	button {
		border: 0;
		background: transparent;
	}
	button:disabled {
		opacity: 0.4;
	}
	button:not(:disabled):hover,
	a:hover {
		background: var(--surface-hover);
	}
	button:focus-visible,
	a:focus-visible {
		outline: 1px solid var(--text);
		outline-offset: -2px;
	}
	p,
	h1,
	h2 {
		margin: 0;
	}
	button,
	a {
		border-radius: 4px;
	}
	.editor-header {
		display: flex;
		align-items: center;
		gap: 18px;
		height: 53px;
		flex-shrink: 0;
		padding: 0 15px;
		border-bottom: 1px solid var(--border);
		background: var(--surface);
	}
	.title-group {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}
	.title-group > :global(svg) {
		flex-shrink: 0;
		color: var(--text-muted);
	}
	h1 {
		font-size: 12px;
		font-weight: 550;
		white-space: nowrap;
	}
	.slash {
		color: var(--border-strong);
	}
	.game-title {
		font-size: 12px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 230px;
		color: var(--text-muted);
	}
	.save-status {
		display: flex;
		align-items: center;
		gap: 7px;
		font-size: 11px;
		color: var(--text-muted);
		white-space: nowrap;
	}
	.status-dot {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		display: inline-block;
		background: var(--text-muted);
		flex-shrink: 0;
	}
	.unapplied {
		padding: 2px 5px;
		border: 1px solid var(--border);
		border-radius: 3px;
		font-size: 10px;
	}
	.header-actions {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 6px;
		flex-shrink: 0;
	}
	.icon-button {
		display: inline-grid;
		place-items: center;
		width: 27px;
		height: 27px;
		padding: 0;
		color: var(--text-muted);
	}
	.apply {
		display: flex;
		align-items: center;
		gap: 5px;
		border: 1px solid var(--border-strong);
		background: var(--text);
		color: var(--on-accent);
		padding: 6px 12px;
		min-width: 68px;
		justify-content: center;
		font-size: 11px;
	}
	.apply:not(:disabled):hover {
		background: var(--text-strong);
	}
	.return-link {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 7px 9px;
		text-decoration: none;
		font-size: 11px;
		color: var(--text-muted);
	}
	.return-link[aria-disabled='true'] {
		opacity: 0.4;
	}
	.workspace {
		display: flex;
		flex: 1;
		min-height: 0;
		min-width: 0;
		position: relative;
	}
	.game-editor :global(*) {
		scrollbar-width: thin;
		scrollbar-color: var(--border-strong) transparent;
	}
	.game-editor :global(*::-webkit-scrollbar) {
		width: 6px;
		height: 6px;
	}
	.game-editor :global(*::-webkit-scrollbar-track) {
		background: transparent;
	}
	.game-editor :global(*::-webkit-scrollbar-thumb) {
		background: var(--border-strong);
		border-radius: 6px;
	}
	.game-editor :global(*::-webkit-scrollbar-thumb:hover) {
		background: var(--text-muted);
	}
	@supports selector(::-webkit-scrollbar) {
		.game-editor :global(*) {
			scrollbar-width: auto;
			scrollbar-color: auto;
		}
		.game-editor :global(*::-webkit-scrollbar-button) {
			display: none;
			width: 0;
			height: 0;
		}
	}
	.edge-handle {
		width: 4px;
		flex-shrink: 0;
		cursor: col-resize;
		touch-action: none;
	}
	.edge-handle:hover,
	.edge-handle:focus-visible {
		background: var(--surface-active);
	}
	.explorer {
		width: var(--explorer-width);
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		border-right: 1px solid var(--border);
		background: color-mix(in srgb, var(--surface) 70%, var(--background));
		overflow: auto;
		overflow-x: hidden;
	}
	.section-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		height: 39px;
		min-height: 39px;
		padding: 0 14px;
		color: var(--text-muted);
		font-size: 11px;
		border-bottom: 1px solid var(--border);
	}
	.local-label {
		font-size: 10px;
		color: var(--text-muted);
		opacity: 0.7;
	}
	.project-title {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 16px 12px 11px;
		font-size: 11px;
		font-weight: 550;
	}
	.project-title span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.project-title :global(svg) {
		flex-shrink: 0;
	}
	.explorer nav {
		padding-bottom: 16px;
	}
	.explorer-category {
		padding: 4px 0;
	}
	.explorer-category h2 {
		font-size: 11px;
		display: flex;
		align-items: center;
		gap: 7px;
		font-weight: 500;
		color: var(--text-muted);
		padding: 5px 19px;
	}
	.file {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 29px;
		width: 100%;
		border-radius: 0;
		text-align: left;
		padding: 5px 16px 5px 39px;
		font-size: 11px;
	}
	.file > span:nth-child(2) {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.file-mark {
		flex-shrink: 0;
	}
	.file.selected {
		background: var(--surface-active);
		color: var(--text-strong);
	}
	.file-mark {
		font-family: Consolas, monospace;
		font-size: 11px;
		color: var(--text-muted);
	}
	.modified-dot {
		font-size: 6px;
		margin-left: auto;
		color: var(--text-muted);
	}
	.explorer-note {
		margin-top: auto;
		padding: 14px 16px;
		border-top: 1px solid var(--border);
		color: var(--text-muted);
		font-size: 11px;
		line-height: 1.7;
	}
	.explorer-note button {
		display: block;
		margin-top: 10px;
		padding: 4px 7px;
		border: 1px solid var(--border);
		font-size: 11px;
	}
	.editor-stack {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
		min-height: 0;
	}
	.failed {
		color: #eab4ae;
	}
	.preview {
		width: var(--preview-width);
		min-width: 0;
		min-height: 0;
		flex-shrink: 0;
		border-left: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		background: color-mix(in srgb, var(--surface) 60%, var(--background));
	}
	.preview-body {
		overflow: auto;
		min-height: 0;
		flex: 1;
	}
	.playground-tabs {
		display: flex;
		gap: 4px;
		padding: 6px 8px;
		border-bottom: 1px solid var(--border);
		flex-shrink: 0;
	}
	.playground-tabs button {
		flex: 1;
		padding: 7px 4px;
		font-size: 11px;
	}
	.playground-tabs button[aria-pressed='true'] {
		background: var(--surface-hover);
		color: var(--text-strong);
	}
	.status-bar {
		min-height: 25px;
		display: flex;
		align-items: center;
		gap: 22px;
		border-top: 1px solid var(--border);
		padding: 0 13px;
		font-size: 10px;
		color: var(--text-muted);
		background: var(--surface);
	}
	.status-bar > span {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.status-right {
		margin-left: auto;
	}
	.error-banner {
		display: flex;
		align-items: center;
		gap: 14px;
		padding: 10px 18px;
		font-size: 11px;
		line-height: 1.7;
		border-bottom: 1px solid var(--border);
		background: var(--surface);
	}
	.error-banner {
		color: #eab4ae;
	}
	.error-banner button,
	.load-state button {
		border: 1px solid var(--border-strong);
		padding: 5px 8px;
		font-size: 11px;
	}
	.load-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 20px;
		flex: 1;
		padding: 30px;
		text-align: center;
	}
	.load-state div {
		display: flex;
		gap: 10px;
	}
	.load-state h2 {
		font-size: 17px;
		font-weight: 500;
	}
	@media (max-width: 1100px) {
		.game-title {
			max-width: 140px;
		}
		.save-status .unapplied {
			display: none;
		}
		.file {
			padding-left: 29px;
		}
		.header-actions {
			gap: 3px;
		}
		.editor-header {
			gap: 12px;
			padding: 0 10px;
		}
		.return-link span {
			display: none;
		}
	}
	@media (max-width: 800px) {
		.preview-handle {
			position: absolute;
			right: var(--preview-width);
			top: 0;
			bottom: 0;
			z-index: 3;
		}
		.preview {
			position: absolute;
			right: 0;
			top: 0;
			bottom: 0;
			width: var(--preview-width);
			z-index: 2;
			background: var(--background);
			box-shadow: -14px 0 25px #0003;
		}
		.game-title,
		.slash {
			display: none;
		}
		.status-bar {
			gap: 14px;
		}
		.status-bar > span:nth-child(2) {
			display: none;
		}
	}
	@media (max-width: 500px) {
		.explorer-handle {
			position: absolute;
			left: var(--explorer-width);
			top: 0;
			bottom: 0;
			z-index: 4;
		}
		.editor-header {
			height: auto;
			min-height: 52px;
			flex-wrap: wrap;
			padding: 10px;
			gap: 8px;
		}
		.title-group {
			gap: 6px;
		}
		.save-status {
			margin-left: auto;
		}
		.header-actions {
			width: 100%;
			justify-content: flex-end;
		}
		.header-actions > button:first-child {
			margin-right: auto;
		}
		.explorer {
			position: absolute;
			left: 0;
			top: 0;
			bottom: 0;
			z-index: 3;
			width: var(--explorer-width);
			box-shadow: 12px 0 20px #0003;
			background: var(--background);
		}
		.status-right {
			font-size: 10px;
		}
	}
</style>
