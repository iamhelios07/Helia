<script lang="ts">
	import { onMount } from 'svelte';
	import { beforeNavigate, goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import Icon from '#lib/components/Icon.svelte';
	import { getGameWorkspace, applyGameDraft } from '../repository.js';
	import {
		EDITOR_DOCUMENTS,
		createEditorDraft,
		loadEditorDraft,
		storeEditorDraft,
		clearEditorDraft,
		validateEditorDraft,
		changedEditorDraft,
		editorContent,
		type EditorDraft,
		type EditorDocumentId
	} from '../editor.js';
	import { loadSettingsDraft, clearSettingsDraft } from '../settings-draft.js';
	import type { Game } from '../model.js';
	import EditorTabs from './editor/EditorTabs.svelte';
	import SourceEditor from './editor/SourceEditor.svelte';
	import { EDITOR_LAYOUT_LIMITS, loadEditorLayout, storeEditorLayout } from '../editor-layout.js';

	type DocumentId = EditorDocumentId | 'assets';
	type BottomPanel = 'problems' | 'logs' | 'state';
	let { gameId }: { gameId: string } = $props();
	let game = $state.raw<Game | null>(null);
	let draft = $state.raw<EditorDraft | null>(null);
	let loading = $state(true);
	let missing = $state(false);
	let loadError = $state('');
	let recoveryError = $state('');
	let saveError = $state('');
	let applyError = $state('');
	let navigationError = $state('');
	let applying = $state(false);
	let leaving = $state(false);
	let saving = $state(false);
	let savedLocally = $state(false);
	let explorerOpen = $state(true);
	let previewOpen = $state(true);
	let splitOpen = $state(false);
	let secondaryDocument = $state<EditorDocumentId>('state');
	let splitRatio = $state(50);
	let workspaceWidth = $state(1100);
	let explorerWidth = $state(200);
	let previewWidth = $state(285);
	let editorStackHeight = $state(600);
	let bottomHeight = $state(178);
	let maxBottomHeight = $derived(
		Math.max(
			EDITOR_LAYOUT_LIMITS.bottom.min,
			Math.min(EDITOR_LAYOUT_LIMITS.bottom.max, editorStackHeight - 145)
		)
	);
	let displayedBottomHeight = $derived(Math.min(bottomHeight, maxBottomHeight));
	let layoutWarning = $state('');
	let maxExplorerWidth = $derived(
		Math.max(
			EDITOR_LAYOUT_LIMITS.explorer.min,
			Math.min(
				EDITOR_LAYOUT_LIMITS.explorer.max,
				workspaceWidth <= 800
					? workspaceWidth - 50
					: workspaceWidth - 340 - (previewOpen ? previewWidth + 5 : 0)
			)
		)
	);
	let maxPreviewWidth = $derived(
		Math.max(
			EDITOR_LAYOUT_LIMITS.preview.min,
			Math.min(
				EDITOR_LAYOUT_LIMITS.preview.max,
				workspaceWidth <= 800
					? workspaceWidth - 30
					: workspaceWidth -
							340 -
							(explorerOpen ? Math.min(explorerWidth, maxExplorerWidth) + 5 : 0)
			)
		)
	);
	let displayedExplorerWidth = $derived(Math.min(explorerWidth, maxExplorerWidth));
	let displayedPreviewWidth = $derived(Math.min(previewWidth, maxPreviewWidth));
	let bottomOpen = $state(true);
	let bottomPanel = $state<BottomPanel>('problems');
	let openDocuments = $state<DocumentId[]>(['info', 'instructions']);
	let activeDocument = $state<DocumentId | null>('info');
	let sourceDocuments = $state<EditorDocumentId[]>([]);
	let discardRequested = $state(false);
	let logs = $state<{ id: number; time: string; message: string; failed: boolean }[]>([]);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;
	let logSequence = 0;
	let validation = $derived(game && draft ? validateEditorDraft(game, draft) : null);
	let changed = $derived(draft ? changedEditorDraft(draft) : false);
	let baseDocuments = $derived(game ? createEditorDraft(game).documents : null);
	let info = $derived(readFields(draft?.documents.info));
	let instructions = $derived(readFields(draft?.documents.instructions));
	let tabs = $derived(
		openDocuments.map((id) => ({
			id,
			title: documentLabel(id),
			dirty: id !== 'assets' && !!draft && draft.documents[id] !== baseDocuments?.[id]
		}))
	);
	let documentSource = $derived(
		activeDocument && activeDocument !== 'assets' ? (draft?.documents[activeDocument] ?? '') : ''
	);
	let problems = $derived(validation?.problems ?? []);
	let canApply = $derived(changed && !!validation?.game && !applying && !leaving);
	let draftStatus = $derived(
		saveError
			? '초안 저장 실패'
			: saving
				? '초안 저장 중…'
				: savedLocally
					? '초안 저장됨'
					: '적용된 콘텐츠'
	);
	const categories: {
		title: string;
		icon: 'info' | 'book' | 'activity' | 'tool' | 'grid' | 'image';
		documents: { id: DocumentId; file: string }[];
	}[] = [
		{ title: '게임 정보', icon: 'info', documents: [{ id: 'info', file: 'game.json' }] },
		{
			title: '게임 지침',
			icon: 'book',
			documents: [{ id: 'instructions', file: 'instructions.json' }]
		},
		{
			title: '상태',
			icon: 'activity',
			documents: [
				{ id: 'schema', file: 'schema.json' },
				{ id: 'state', file: 'initial-state.json' }
			]
		},
		{ title: '로직', icon: 'tool', documents: [{ id: 'scripts', file: 'scripts.json' }] },
		{ title: '화면', icon: 'grid', documents: [{ id: 'ui', file: 'ui.json' }] },
		{ title: '로어북', icon: 'book', documents: [{ id: 'lorebook', file: 'lorebook.json' }] },
		{ title: '에셋', icon: 'image', documents: [{ id: 'assets', file: '참조 안내' }] }
	];
	const panels = [
		{ id: 'problems', label: '문제' },
		{ id: 'logs', label: '실행 기록' },
		{ id: 'state', label: '상태' }
	] as const;

	onMount(() => {
		try {
			const layout = loadEditorLayout(gameId);
			if (layout) {
				explorerWidth = layout.explorerWidth;
				previewWidth = layout.previewWidth;
				bottomHeight = layout.bottomHeight;
			}
		} catch {
			layoutWarning = '레이아웃 설정을 불러오지 못했어요.';
		}
		if (window.matchMedia('(max-width: 800px)').matches) {
			explorerOpen = false;
			previewOpen = false;
		}
		void load();
		return () => {
			clearTimeout(timer);
			if (draft && changed) persistDraft();
			disposed = true;
		};
	});
	beforeNavigate((navigation) => {
		if (applying || (draft && changed && !persistDraft())) navigation.cancel();
	});
	function readFields(source: string | undefined): Record<string, string> | null {
		if (!source) return null;
		try {
			const value: unknown = JSON.parse(source);
			if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
			const entries = Object.entries(value);
			return entries.every(([, value]) => typeof value === 'string')
				? (Object.fromEntries(entries) as Record<string, string>)
				: null;
		} catch {
			return null;
		}
	}
	function documentLabel(id: DocumentId) {
		return id === 'assets'
			? '에셋'
			: (EDITOR_DOCUMENTS.find((document) => document.id === id)?.label ?? id);
	}
	function documentFile(id: DocumentId) {
		return (
			categories.flatMap((category) => category.documents).find((document) => document.id === id)
				?.file ?? ''
		);
	}
	function log(message: string, failed = false) {
		logs = [
			...logs,
			{
				id: ++logSequence,
				time: new Date().toLocaleTimeString('ko-KR', { hour12: false }),
				message,
				failed
			}
		];
	}
	async function load() {
		loading = true;
		missing = false;
		loadError = '';
		recoveryError = '';
		try {
			const workspace = await getGameWorkspace(gameId);
			if (disposed) return;
			if (!workspace) {
				missing = true;
				return;
			}
			game = workspace.game;
			try {
				const recovered = loadEditorDraft(gameId);
				let next = recovered ?? createEditorDraft(game);
				if (!recovered) {
					const legacy = loadSettingsDraft(gameId);
					if (legacy) {
						next = {
							...next,
							documents: {
								...next.documents,
								info: JSON.stringify(
									{ title: legacy.title, genre: game.genre, description: game.description },
									null,
									2
								),
								instructions: JSON.stringify(
									{
										description: legacy.description,
										firstMessage: legacy.firstMessage,
										authorNote: legacy.authorNote
									},
									null,
									2
								)
							}
						};
						storeEditorDraft(next);
						clearSettingsDraft(gameId, legacy);
					}
				}
				draft = next;
				savedLocally = !!recovered || changedEditorDraft(next);
				log(savedLocally ? '저장된 편집 초안을 복구했어요.' : '게임 콘텐츠를 불러왔어요.');
			} catch (error) {
				recoveryError = error instanceof Error ? error.message : '편집 초안을 불러오지 못했어요.';
			}
		} catch {
			if (!disposed) loadError = '게임을 불러오지 못했어요. 다시 시도해주세요.';
		} finally {
			if (!disposed) loading = false;
		}
	}
	function changeDocument(id: EditorDocumentId, value: string) {
		if (!draft || applying) return;
		draft = { ...draft, documents: { ...draft.documents, [id]: value } };
		saveError = '';
		applyError = '';
		saving = true;
		discardRequested = false;
		clearTimeout(timer);
		timer = setTimeout(persistDraft, 250);
	}
	function changeField(id: 'info' | 'instructions', key: string, value: string) {
		const fields = readFields(draft?.documents[id]);
		if (fields) changeDocument(id, JSON.stringify({ ...fields, [key]: value }, null, 2));
	}
	function persistDraft(): boolean {
		clearTimeout(timer);
		if (!draft) return true;
		try {
			storeEditorDraft(draft);
			saveError = '';
			saving = false;
			savedLocally = true;
			return true;
		} catch (error) {
			saveError = error instanceof Error ? error.message : '편집 초안을 저장하지 못했어요.';
			saving = false;
			return false;
		}
	}
	function openDocument(id: DocumentId) {
		if (!openDocuments.includes(id)) openDocuments = [...openDocuments, id];
		activeDocument = id;
	}
	function closeDocument(id: string) {
		const index = openDocuments.indexOf(id as DocumentId);
		openDocuments = openDocuments.filter((document) => document !== id);
		if (activeDocument === id)
			activeDocument = openDocuments[Math.min(index, openDocuments.length - 1)] ?? null;
	}
	function toggleSource(id: EditorDocumentId) {
		sourceDocuments = sourceDocuments.includes(id)
			? sourceDocuments.filter((document) => document !== id)
			: [...sourceDocuments, id];
	}
	async function apply() {
		if (!draft || !game || applying || !changed) return;
		if (!persistDraft()) return;
		const checked = validateEditorDraft(game, draft);
		if (!checked.game) {
			bottomOpen = true;
			bottomPanel = 'problems';
			return;
		}
		const snapshot = draft;
		applying = true;
		applyError = '';
		try {
			const updated = await applyGameDraft(gameId, {
				baseContent: snapshot.baseContent,
				content: editorContent(checked.game)
			});
			if (disposed) return;
			game = updated;
			draft = createEditorDraft(updated);
			savedLocally = false;
			try {
				clearEditorDraft(gameId, snapshot);
			} catch {
				saveError = '적용은 완료됐지만 저장된 초안을 정리하지 못했어요.';
			}
			log('편집한 콘텐츠를 게임에 적용했어요. 기존 플레이 기록은 유지됩니다.');
		} catch (error) {
			if (!disposed) {
				applyError =
					error instanceof Error ? error.message : '게임에 적용하지 못했어요. 초안은 유지됩니다.';
				log('게임 적용에 실패했어요. 초안은 유지됩니다.', true);
			}
		} finally {
			if (!disposed) applying = false;
		}
	}
	function discard() {
		if (!game || applying) return;
		try {
			clearTimeout(timer);
			clearEditorDraft(gameId);
			draft = createEditorDraft(game);
			savedLocally = false;
			saving = false;
			saveError = '';
			applyError = '';
			recoveryError = '';
			discardRequested = false;
			log('미적용 초안을 버리고 적용된 콘텐츠로 돌아왔어요.');
		} catch {
			saveError = '저장된 초안을 정리하지 못했어요. 다시 시도해주세요.';
		}
	}
	async function returnToPlay(event: MouseEvent) {
		if (applying || leaving) {
			event.preventDefault();
			return;
		}
		if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
			return;
		event.preventDefault();
		navigationError = '';
		if (draft && changed && !persistDraft()) return;
		leaving = true;
		try {
			await goto(resolve('/games/[id]', { id: gameId }));
		} catch {
			navigationError = '플레이 화면을 열지 못했어요. 다시 시도해주세요.';
		} finally {
			leaving = false;
		}
	}
	function shortcuts(event: KeyboardEvent) {
		if (!draft || !(event.ctrlKey || event.metaKey)) return;
		if (event.key.toLowerCase() === 's') {
			event.preventDefault();
			persistDraft();
		} else if (event.key === 'Enter') {
			event.preventDefault();
			void apply();
		}
	}
	function resizeSplit(event: PointerEvent) {
		const handle = event.currentTarget as HTMLElement;
		if (event.type === 'pointerdown') handle.setPointerCapture(event.pointerId);
		if (!handle.hasPointerCapture(event.pointerId)) return;
		const bounds = handle.parentElement?.getBoundingClientRect();
		if (bounds)
			splitRatio = Math.max(25, Math.min(75, ((event.clientX - bounds.left) / bounds.width) * 100));
	}
	function resizeSplitKey(event: KeyboardEvent) {
		if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
		event.preventDefault();
		splitRatio =
			event.key === 'Home'
				? 25
				: event.key === 'End'
					? 75
					: Math.max(25, Math.min(75, splitRatio + (event.key === 'ArrowRight' ? 5 : -5)));
	}
	function saveLayout() {
		try {
			storeEditorLayout(gameId, { explorerWidth, previewWidth, bottomHeight });
			layoutWarning = '';
		} catch {
			layoutWarning = '조절한 패널 크기를 이 기기에 저장하지 못했어요.';
		}
	}
	function resizeEdge(event: PointerEvent, edge: 'explorer' | 'preview') {
		const handle = event.currentTarget as HTMLElement;
		if (event.type === 'pointerdown') handle.setPointerCapture(event.pointerId);
		if (!handle.hasPointerCapture(event.pointerId)) return;
		const bounds = handle.parentElement?.getBoundingClientRect();
		if (!bounds) return;
		if (edge === 'explorer')
			explorerWidth = Math.max(
				EDITOR_LAYOUT_LIMITS.explorer.min,
				Math.min(maxExplorerWidth, event.clientX - bounds.left)
			);
		else
			previewWidth = Math.max(
				EDITOR_LAYOUT_LIMITS.preview.min,
				Math.min(maxPreviewWidth, bounds.right - event.clientX)
			);
	}
	function resizeEdgeKey(event: KeyboardEvent, edge: 'explorer' | 'preview') {
		if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
		event.preventDefault();
		const minimum =
			edge === 'explorer' ? EDITOR_LAYOUT_LIMITS.explorer.min : EDITOR_LAYOUT_LIMITS.preview.min;
		const maximum = edge === 'explorer' ? maxExplorerWidth : maxPreviewWidth;
		const current = edge === 'explorer' ? displayedExplorerWidth : displayedPreviewWidth;
		const direction = edge === 'explorer' ? 1 : -1;
		const next =
			event.key === 'Home'
				? minimum
				: event.key === 'End'
					? maximum
					: Math.max(
							minimum,
							Math.min(maximum, current + (event.key === 'ArrowRight' ? 10 : -10) * direction)
						);
		if (edge === 'explorer') explorerWidth = next;
		else previewWidth = next;
		saveLayout();
	}
	function resizeBottom(event: PointerEvent) {
		const handle = event.currentTarget as HTMLElement;
		if (event.type === 'pointerdown') {
			if (event.button !== 0) return;
			event.preventDefault();
			handle.setPointerCapture(event.pointerId);
		}
		if (!handle.hasPointerCapture(event.pointerId)) return;
		const bounds = handle.parentElement?.getBoundingClientRect();
		if (bounds)
			bottomHeight = Math.max(
				EDITOR_LAYOUT_LIMITS.bottom.min,
				Math.min(maxBottomHeight, bounds.bottom - event.clientY - handle.offsetHeight / 2)
			);
	}
	function resizeBottomKey(event: KeyboardEvent) {
		if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
		event.preventDefault();
		bottomHeight =
			event.key === 'Home'
				? EDITOR_LAYOUT_LIMITS.bottom.min
				: event.key === 'End'
					? maxBottomHeight
					: Math.max(
							EDITOR_LAYOUT_LIMITS.bottom.min,
							Math.min(
								maxBottomHeight,
								displayedBottomHeight + (event.key === 'ArrowUp' ? 10 : -10)
							)
						);
		saveLayout();
	}
</script>

<svelte:head><title>{game?.title ?? '게임'} 편집기 · Helia</title></svelte:head>
<svelte:window
	onkeydown={shortcuts}
	onpagehide={() => {
		if (draft && changed) persistDraft();
	}}
/>
<main class="game-editor" aria-label="게임 편집기">
	<header class="editor-header">
		<div class="title-group">
			<Icon name="edit" size={17} />
			<h1>게임 편집기</h1>
			<span class="slash">/</span><span class="game-title"
				>{info?.title ?? game?.title ?? '불러오는 중'}</span
			>
		</div>
		{#if draft}<span class={['save-status', { failed: !!saveError }]} role="status"
				><span class="status-dot"></span>{draftStatus}{#if changed}<span class="unapplied"
						>미적용</span
					>{/if}</span
			>{/if}
		<div class="header-actions">
			<button
				class="icon-button"
				type="button"
				aria-label="편집기 좌우 분할"
				aria-pressed={splitOpen}
				onclick={() => (splitOpen = !splitOpen)}
				title="편집기 좌우 분할"><span aria-hidden="true">◫</span></button
			>
			<button
				class="icon-button"
				type="button"
				aria-label="탐색기"
				aria-expanded={explorerOpen}
				onclick={() => (explorerOpen = !explorerOpen)}
				title="탐색기"><Icon name="folder" size={16} /></button
			>
			<button
				class="icon-button"
				type="button"
				aria-label="미리보기"
				aria-expanded={previewOpen}
				onclick={() => (previewOpen = !previewOpen)}
				title="미리보기"><Icon name="grid" size={16} /></button
			>
			{#if draft}<button
					class="apply"
					type="button"
					disabled={!canApply}
					onclick={apply}
					title="게임에 적용 (Ctrl+Enter)"
					><Icon name="check" size={14} />{applying ? '적용 중…' : '적용'}</button
				>{/if}
			<a
				class="return-link"
				aria-label="플레이로 돌아가기"
				href={resolve('/games/[id]', { id: gameId })}
				aria-disabled={applying || leaving}
				onclick={returnToPlay}><Icon name="arrow-left" size={15} /><span>플레이로 돌아가기</span></a
			>
		</div>
	</header>
	{#if navigationError}<div class="error-banner" role="alert">{navigationError}</div>{/if}
	{#if loading}<div class="load-state" role="status">게임을 불러오는 중…</div>
	{:else if loadError}<div class="load-state">
			<p role="alert">{loadError}</p>
			<button type="button" onclick={load}>다시 불러오기</button>
		</div>
	{:else if missing}<div class="load-state"><h2>게임을 찾을 수 없어요</h2></div>
	{:else if recoveryError}<div class="load-state">
			<p role="alert">{recoveryError}</p>
			<div>
				<button type="button" onclick={load}>초안 다시 읽기</button><button
					type="button"
					onclick={() => (discardRequested = true)}>적용된 콘텐츠로 다시 시작</button
				>
			</div>
			{#if discardRequested}<p>저장된 초안을 버릴까요?</p>
				<button type="button" onclick={discard}>초안 버리기</button>{/if}
		</div>
	{:else if draft && game}
		{#if saveError}<div class="error-banner" role="alert">
				{saveError}<button type="button" onclick={persistDraft}>초안 저장 다시 시도</button>
			</div>{/if}
		{#if applyError}<div class="error-banner" role="alert">{applyError}</div>{/if}
		{#if discardRequested}<div class="discard-banner" role="alert">
				<span>미적용 초안을 버리고 적용된 콘텐츠로 돌아갈까요?</span><button
					type="button"
					onclick={discard}>초안 버리기</button
				><button type="button" onclick={() => (discardRequested = false)}>계속 편집</button>
			</div>{/if}
		<div
			class="workspace"
			bind:clientWidth={workspaceWidth}
			style:--explorer-width="{displayedExplorerWidth}px"
			style:--preview-width="{displayedPreviewWidth}px"
		>
			{#if explorerOpen}<aside class="explorer" aria-label="게임 탐색기">
					<div class="section-heading">
						<span>탐색기</span><span class="local-label">로컬 초안</span>
					</div>
					<div class="project-title">
						<Icon name="folder" size={14} /><span>{info?.title ?? game.title}</span>
					</div>
					<nav aria-label="게임 문서">
						{#each categories as category (category.title)}<section class="explorer-category">
								<h2><Icon name={category.icon} size={13} />{category.title}</h2>
								{#each category.documents as document (document.id)}<button
										type="button"
										class={['file', { selected: activeDocument === document.id }]}
										aria-current={activeDocument === document.id ? 'page' : undefined}
										onclick={() => openDocument(document.id)}
										><span class="file-mark">{document.id === 'assets' ? '↗' : '{}'}</span><span
											>{document.file}</span
										>{#if document.id !== 'assets' && draft.documents[document.id] !== baseDocuments?.[document.id]}<span
												class="modified-dot"
												aria-label="미적용 변경">●</span
											>{/if}</button
									>{/each}
							</section>{/each}
					</nav>
					<div class="explorer-note">
						<span>적용 전 변경은 이 기기에 초안으로 저장돼요.</span>{#if changed}<button
								type="button"
								disabled={applying}
								onclick={() => (discardRequested = true)}>변경 취소</button
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
					aria-valuemax={Math.round(maxExplorerWidth)}
					aria-valuenow={Math.round(displayedExplorerWidth)}
					onpointerdown={(event) => resizeEdge(event, 'explorer')}
					onpointermove={(event) => resizeEdge(event, 'explorer')}
					onpointerup={saveLayout}
					onpointercancel={saveLayout}
					onkeydown={(event) => resizeEdgeKey(event, 'explorer')}
				></div>{/if}
			<div
				class="editor-stack"
				bind:clientHeight={editorStackHeight}
				style:--bottom-height="{displayedBottomHeight}px"
			>
				<div class="document-workspace">
					<EditorTabs
						{tabs}
						active={activeDocument}
						onselect={(id) => (activeDocument = id as DocumentId)}
						onclose={closeDocument}
					/>
					{#if activeDocument}<div class="document-breadcrumb">
							<span>게임</span><Icon name="arrow-right" size={11} /><span
								>{documentLabel(activeDocument)}</span
							><span class="breadcrumb-file">{documentFile(activeDocument)}</span
							>{#if activeDocument === 'info' || activeDocument === 'instructions'}<button
									type="button"
									aria-pressed={sourceDocuments.includes(activeDocument)}
									onclick={() =>
										activeDocument && activeDocument !== 'assets' && toggleSource(activeDocument)}
									>{sourceDocuments.includes(activeDocument)
										? '폼으로 편집'
										: 'JSON으로 편집'}</button
								>{/if}
						</div>{/if}
					<div class={['document-panes', { split: splitOpen }]} style:--split="{splitRatio}%">
						<div
							class="document"
							id="editor-document"
							role="tabpanel"
							aria-labelledby={activeDocument ? `editor-tab-${activeDocument}` : undefined}
							tabindex="0"
						>
							{#if !activeDocument}<div class="empty-editor">
									<Icon name="edit" size={36} />
									<h2>편집할 문서를 열어주세요</h2>
									<p>왼쪽 탐색기에서 문서를 선택하세요.<br />문서를 닫아도 초안은 유지돼요.</p>
								</div>
							{:else if activeDocument === 'assets'}<div class="form-document">
									<p class="eyebrow">에셋</p>
									<h2>게임의 미디어 참조</h2>
									<p class="document-help">
										현재 게임 형식에는 별도의 에셋 목록이 없어요. 화면에서 사용하는 이미지와 미디어
										경로는 화면 소스에서 관리할 수 있어요.
									</p>
									<button type="button" class="inline-action" onclick={() => openDocument('ui')}
										>화면 문서 열기<Icon name="arrow-right" size={13} /></button
									>
								</div>
							{:else if activeDocument === 'info' && !sourceDocuments.includes('info') && info}<div
									class="form-document"
								>
									<h2>게임 정보</h2>
									<p class="document-help">라이브러리에 표시되는 게임의 기본 정보예요.</p>
									<fieldset disabled={applying}>
										<label for="editor-name">이름</label><input
											id="editor-name"
											value={info.title ?? ''}
											oninput={(event) => changeField('info', 'title', event.currentTarget.value)}
										/>
										<label for="editor-genre">장르</label><input
											id="editor-genre"
											value={info.genre ?? ''}
											oninput={(event) => changeField('info', 'genre', event.currentTarget.value)}
											placeholder="게임의 장르"
										/>
										<label for="editor-introduction">소개</label><textarea
											id="editor-introduction"
											rows="5"
											value={info.description ?? ''}
											oninput={(event) =>
												changeField('info', 'description', event.currentTarget.value)}></textarea>
										<p class="field-help">플레이어가 게임을 고를 때 보는 소개예요.</p>
									</fieldset>
									<div class="form-footnote">
										<Icon name="info" size={14} /><span
											>초안은 자동 저장되며, 적용을 눌러야 게임에 반영돼요.</span
										>
									</div>
								</div>
							{:else if activeDocument === 'instructions' && !sourceDocuments.includes('instructions') && instructions}<div
									class="form-document"
								>
									<h2>게임 지침</h2>
									<p class="document-help">AI가 사용하는 게임 설명과 대화의 시작을 작성해요.</p>
									<fieldset disabled={applying}>
										<label for="editor-description">게임 설명</label><textarea
											id="editor-description"
											rows="6"
											value={instructions.description ?? ''}
											oninput={(event) =>
												changeField('instructions', 'description', event.currentTarget.value)}
										></textarea>
										<label for="editor-opening">첫 메시지</label><textarea
											id="editor-opening"
											rows="6"
											value={instructions.firstMessage ?? ''}
											oninput={(event) =>
												changeField('instructions', 'firstMessage', event.currentTarget.value)}
										></textarea>
										<label for="editor-note">작가 노트</label><textarea
											id="editor-note"
											rows="4"
											value={instructions.authorNote ?? ''}
											oninput={(event) =>
												changeField('instructions', 'authorNote', event.currentTarget.value)}
										></textarea>
									</fieldset>
								</div>
							{:else}<SourceEditor
									value={documentSource}
									label="{documentLabel(activeDocument)} 소스"
									disabled={applying}
									onchange={(value) =>
										activeDocument &&
										activeDocument !== 'assets' &&
										changeDocument(activeDocument, value)}
								/>{/if}
						</div>
						{#if splitOpen}
							<div
								class="split-handle"
								role="slider"
								tabindex="0"
								aria-label="편집기 분할 크기"
								aria-orientation="horizontal"
								aria-valuemin="25"
								aria-valuemax="75"
								aria-valuenow={Math.round(splitRatio)}
								onpointerdown={resizeSplit}
								onpointermove={resizeSplit}
								onkeydown={resizeSplitKey}
							></div>
							<section class="secondary-document" aria-label="보조 편집기">
								<div class="secondary-header">
									<label for="secondary-document">문서</label><select
										id="secondary-document"
										bind:value={secondaryDocument}
										>{#each EDITOR_DOCUMENTS as document (document.id)}<option value={document.id}
												>{document.label}</option
											>{/each}</select
									><button
										class="icon-button"
										type="button"
										aria-label="보조 편집기 닫기"
										onclick={() => (splitOpen = false)}><Icon name="close" size={13} /></button
									>
								</div>
								<SourceEditor
									value={draft.documents[secondaryDocument]}
									label="보조 {documentLabel(secondaryDocument)} 소스"
									disabled={applying}
									onchange={(value) => changeDocument(secondaryDocument, value)}
								/>
							</section>
						{/if}
					</div>
				</div>
				{#if bottomOpen}
					<div
						class="bottom-handle"
						role="slider"
						tabindex="0"
						aria-label="검사 패널 높이 조절"
						aria-orientation="vertical"
						aria-valuemin={EDITOR_LAYOUT_LIMITS.bottom.min}
						aria-valuemax={Math.round(maxBottomHeight)}
						aria-valuenow={Math.round(displayedBottomHeight)}
						onpointerdown={resizeBottom}
						onpointermove={resizeBottom}
						onpointerup={saveLayout}
						onpointercancel={saveLayout}
						onkeydown={resizeBottomKey}
					></div>
				{/if}
				<section class={['bottom-panel', { collapsed: !bottomOpen }]} aria-label="편집기 검사">
					<div class="bottom-header">
						<div role="tablist" aria-label="검사 패널">
							{#each panels as panel (panel.id)}<button
									type="button"
									role="tab"
									aria-selected={bottomPanel === panel.id && bottomOpen}
									aria-controls="editor-inspector"
									onclick={() => {
										bottomPanel = panel.id;
										bottomOpen = true;
									}}
									>{panel.label}{#if panel.id === 'problems' && validation}<span class="count"
											>{problems.length}</span
										>{/if}</button
								>{/each}
						</div>
						<button
							type="button"
							class="icon-button"
							aria-label={bottomOpen ? '검사 패널 접기' : '검사 패널 펼치기'}
							aria-expanded={bottomOpen}
							onclick={() => (bottomOpen = !bottomOpen)}
							><Icon name={bottomOpen ? 'minus' : 'plus'} size={14} /></button
						>
					</div>
					{#if bottomOpen}<div
							class="inspector-content"
							id="editor-inspector"
							role="tabpanel"
							aria-label={bottomPanel === 'problems'
								? '문제'
								: bottomPanel === 'logs'
									? '실행 기록'
									: '상태'}
						>
							{#if bottomPanel === 'problems'}{#if validation && problems.length === 0}<p
										class="inspection-clear"
									>
										<Icon name="check" size={14} />문서 형식 검사를 통과했어요.<span
											>소스 실행은 이 검사에 포함되지 않아요.</span
										>
									</p>{:else}<ul class="problem-list">
										{#each problems as problem (`${problem.documentId}:${problem.message}`)}<li>
												<button type="button" onclick={() => openDocument(problem.documentId)}
													><span class="problem-marker">!</span><span>{problem.message}</span><span
														class="problem-document">{documentLabel(problem.documentId)}</span
													></button
												>
											</li>{/each}
									</ul>{/if}
							{:else if bottomPanel === 'logs'}<p class="inspector-hint">
									편집기의 불러오기·적용 기록
								</p>
								<ul class="log-list">
									{#each logs as entry (entry.id)}<li class={{ failed: entry.failed }}>
											<time>{entry.time}</time><span>{entry.message}</span>
										</li>{/each}
								</ul>
							{:else}<pre class="state-inspection">{draft.documents.state}</pre>{/if}
						</div>{/if}
				</section>
			</div>
			{#if previewOpen}<div
					class="edge-handle preview-handle"
					role="slider"
					tabindex="0"
					aria-label="미리보기 너비 조절"
					aria-orientation="horizontal"
					aria-valuemin={EDITOR_LAYOUT_LIMITS.preview.min}
					aria-valuemax={Math.round(maxPreviewWidth)}
					aria-valuenow={Math.round(displayedPreviewWidth)}
					onpointerdown={(event) => resizeEdge(event, 'preview')}
					onpointermove={(event) => resizeEdge(event, 'preview')}
					onpointerup={saveLayout}
					onpointercancel={saveLayout}
					onkeydown={(event) => resizeEdgeKey(event, 'preview')}
				></div>
				<aside class="preview" aria-label="초안 미리보기">
					<div class="section-heading">
						<span>미리보기</span><button
							type="button"
							class="icon-button"
							aria-label="미리보기 닫기"
							onclick={() => (previewOpen = false)}><Icon name="close" size={14} /></button
						>
					</div>
					<div class="preview-body">
						<p class="preview-caption">
							<span class="status-dot"></span>현재 초안 · 콘텐츠 미리보기
						</p>
						<div class="preview-game">
							<span class="preview-genre">{info?.genre || '장르 미지정'}</span>
							<h2>{info?.title || '이름 없는 게임'}</h2>
							{#if info?.description}<p class="preview-introduction">{info.description}</p>{/if}
						</div>
						<div class="preview-divider">첫 메시지</div>
						{#if instructions?.firstMessage}<div class="opening-preview">
								{instructions.firstMessage}
							</div>{:else}<p class="preview-empty">
								첫 메시지를 작성하면 여기에 표시돼요.
							</p>{/if}{#if instructions?.description}<details>
								<summary>게임 설명</summary>
								<p class="preview-text">{instructions.description}</p>
							</details>{/if}{#if instructions?.authorNote}<details>
								<summary>작가 노트</summary>
								<p class="preview-text">{instructions.authorNote}</p>
							</details>{/if}
						<div class="preview-bottom">
							<Icon name="info" size={13} /><span
								>입력한 콘텐츠만 표시해요. 게임 로직과 화면 소스는 실행하지 않아요.</span
							>
						</div>
					</div>
				</aside>{/if}
		</div>
		<footer class="status-bar">
			{#if layoutWarning}<span title={layoutWarning}>패널 크기 저장 안 됨</span>{/if}
			<span><Icon name="edit" size={11} />로컬 편집</span><span
				>{changed ? '게임에 적용되지 않은 변경이 있어요' : '적용된 콘텐츠와 일치해요'}</span
			><span class="status-right"
				>{activeDocument && activeDocument !== 'assets'
					? `${documentSource.length.toLocaleString()}자 · JSON`
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
	a,
	input,
	textarea {
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
	.eyebrow {
		font-size: 10px;
		letter-spacing: 0.12em;
		color: var(--text-muted);
		margin-bottom: 10px;
		opacity: 0.7;
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
	.inline-action {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 8px 10px;
		border: 1px solid var(--border-strong);
		font-size: 11px;
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
	.bottom-panel {
		height: var(--bottom-height);
		flex-shrink: 0;
		border-top: 1px solid var(--border);
		display: flex;
		flex-direction: column;
	}
	.bottom-panel.collapsed {
		height: 35px;
	}
	.bottom-handle {
		height: 5px;
		flex-shrink: 0;
		cursor: row-resize;
		touch-action: none;
		user-select: none;
	}
	.bottom-handle:hover,
	.bottom-handle:focus-visible {
		background: var(--border-strong);
		outline: none;
	}
	.bottom-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 0 10px 0 12px;
		height: 35px;
		min-height: 35px;
	}
	.bottom-header [role='tablist'] {
		display: flex;
		gap: 15px;
		height: 100%;
	}
	.bottom-header [role='tab'] {
		display: flex;
		align-items: center;
		gap: 7px;
		border-radius: 0;
		border-bottom: 1px solid transparent;
		padding: 0 4px;
		font-size: 11px;
		color: var(--text-muted);
	}
	.bottom-header [aria-selected='true'] {
		border-bottom-color: var(--text);
		color: var(--text-strong);
	}
	.count {
		display: inline-grid;
		place-items: center;
		background: var(--surface-active);
		border-radius: 7px;
		min-width: 15px;
		height: 14px;
		font-size: 10px;
	}
	.inspector-content {
		flex: 1;
		overflow: auto;
		font-size: 11px;
	}
	.inspection-clear {
		padding: 18px;
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--text-muted);
	}
	.inspection-clear span {
		opacity: 0.65;
		margin-left: 8px;
	}
	.problem-list,
	.log-list {
		margin: 0;
		padding: 5px 0;
		list-style: none;
	}
	.problem-list button {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		border-radius: 0;
		padding: 7px 18px;
		text-align: left;
		font-size: 11px;
	}
	.problem-marker {
		display: grid;
		place-items: center;
		width: 13px;
		height: 13px;
		border: 1px solid var(--text-muted);
		border-radius: 50%;
		font-size: 10px;
	}
	.problem-document {
		margin-left: auto;
		opacity: 0.6;
		font-size: 11px;
	}
	.inspector-hint {
		padding: 10px 18px 3px;
		color: var(--text-muted);
		font-size: 11px;
	}
	.log-list li {
		display: flex;
		gap: 14px;
		padding: 5px 18px;
		line-height: 1.7;
		font-size: 11px;
	}
	.log-list time {
		color: var(--text-muted);
		font-family: Consolas, monospace;
	}
	.state-inspection {
		padding: 10px 18px;
		margin: 0;
		font:
			11px/1.7 Consolas,
			monospace;
		white-space: pre-wrap;
	}
	.failed {
		color: #eab4ae;
	}
	.preview {
		width: var(--preview-width);
		flex-shrink: 0;
		border-left: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		background: color-mix(in srgb, var(--surface) 60%, var(--background));
	}
	.preview-body {
		overflow: auto;
		padding: 18px;
		flex: 1;
	}
	.preview-caption {
		display: flex;
		gap: 6px;
		align-items: center;
		font-size: 10px;
		color: var(--text-muted);
		margin-bottom: 22px;
	}
	.preview-game {
		padding-bottom: 22px;
	}
	.preview-genre {
		font-size: 11px;
		color: var(--text-muted);
	}
	.preview-game h2 {
		font-size: 20px;
		font-weight: 550;
		line-height: 1.5;
		margin-top: 7px;
		overflow-wrap: anywhere;
		color: var(--text-strong);
	}
	.preview-introduction {
		margin-top: 10px;
		white-space: pre-wrap;
		font-size: 11px;
		color: var(--text-muted);
		line-height: 1.9;
		overflow-wrap: anywhere;
	}
	.preview-divider {
		font-size: 11px;
		color: var(--text-muted);
		border-top: 1px solid var(--border);
		padding-top: 17px;
		margin-bottom: 11px;
	}
	.opening-preview {
		padding: 13px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--background);
		font-size: 11px;
		line-height: 1.95;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.preview-empty {
		font-size: 11px;
		color: var(--text-muted);
		line-height: 1.8;
		padding: 8px 0 16px;
	}
	.preview details {
		border-top: 1px solid var(--border);
		margin-top: 18px;
		padding-top: 13px;
		font-size: 11px;
		color: var(--text-muted);
	}
	.preview summary {
		cursor: pointer;
	}
	.preview-text {
		font-size: 11px;
		line-height: 1.9;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		margin-top: 12px;
	}
	.preview-bottom {
		display: flex;
		align-items: flex-start;
		gap: 7px;
		color: var(--text-muted);
		font-size: 11px;
		line-height: 1.8;
		border-top: 1px solid var(--border);
		margin-top: 22px;
		padding-top: 14px;
	}
	.preview-bottom :global(svg) {
		margin-top: 2px;
		flex-shrink: 0;
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
	.error-banner,
	.discard-banner {
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
	.discard-banner button,
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
		.inspection-clear {
			flex-wrap: wrap;
		}
		.inspection-clear span {
			margin-left: 22px;
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
		.form-document {
			padding: 22px 20px 35px;
		}
		.breadcrumb-file {
			display: none;
		}
		.status-bar {
			gap: 14px;
		}
		.status-bar > span:nth-child(2) {
			display: none;
		}
		.document-breadcrumb {
			padding-inline: 12px;
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
		.inspection-clear span {
			margin-left: 0;
		}
	}
</style>
