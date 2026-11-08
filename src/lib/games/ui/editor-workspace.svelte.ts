import type { PathnameWithSearchOrHash } from '$app/types';

import { beforeNavigate, goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { onMount, onDestroy } from 'svelte';
import { SvelteDate } from 'svelte/reactivity';

import type { CodeDiagnostic } from '../code-authoring.js';
import type { Game } from '../model.js';
import type { GameState } from '../state/value.js';

import { parseCodeProject, compileAuthoringGame } from '../code-project.js';
import { loadAuthoringDraft, saveAuthoringDraft } from '../editor-draft-storage.js';
import { EDITOR_LAYOUT_LIMITS, loadEditorLayout, storeEditorLayout } from '../editor-layout.js';
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
import { getGameWorkspace, applyGameDraft } from '../repository.js';
import { loadSettingsDraft, clearSettingsDraft } from '../settings-draft.js';
import { generateStateTypes } from '../state/schema.js';
import { MonacoProject } from './editor/monaco-project.js';
export type DocumentId =
	| Exclude<EditorDocumentId, 'code' | 'assets'>
	| `code:${string}`
	| `asset:${string}`
	| 'types:GameState';
export type BottomPanel = 'problems' | 'logs' | 'state';
export class EditorWorkspace {
	game = $state.raw<Game | null>(null);
	draft = $state.raw<EditorDraft | null>(null);
	previewContent = $state.raw<Game | null>(null);
	previewMode = $state<'preview' | 'test'>('preview');
	runtimeState = $state.raw<GameState | null>(null);
	draftVersion = 0;
	persistedSource = '';
	saveQueue: Promise<unknown> = Promise.resolve();
	allowNavigation = false;
	loadGeneration = 0;
	draftLoaded = false;
	stateTypes = $derived.by(() => {
		try {
			return this.draft ? generateStateTypes(JSON.parse(this.draft.documents.state).schema) : '';
		} catch {
			return '';
		}
	});
	loading = $state(true);
	missing = $state(false);
	loadError = $state('');
	recoveryError = $state('');
	saveError = $state('');
	applyError = $state('');
	navigationError = $state('');
	applying = $state(false);
	discarding = $state(false);
	leaving = $state(false);
	editingBlocked = $derived(this.applying || this.discarding || this.leaving);
	saving = $state(false);
	savedLocally = $state(false);
	explorerOpen = $state(true);
	previewOpen = $state(true);
	splitOpen = $state(false);
	secondaryDocument = $state<DocumentId>('state');
	splitRatio = $state(50);
	workspaceWidth = $state(1100);
	explorerWidth = $state(200);
	previewWidth = $state(285);
	editorStackHeight = $state(600);
	bottomHeight = $state(178);
	maxBottomHeight = $derived(
		Math.max(
			EDITOR_LAYOUT_LIMITS.bottom.min,
			Math.min(EDITOR_LAYOUT_LIMITS.bottom.max, this.editorStackHeight - 145)
		)
	);
	displayedBottomHeight = $derived(Math.min(this.bottomHeight, this.maxBottomHeight));
	layoutWarning = $state('');
	maxExplorerWidth = $derived(
		Math.max(
			EDITOR_LAYOUT_LIMITS.explorer.min,
			Math.min(
				EDITOR_LAYOUT_LIMITS.explorer.max,
				this.workspaceWidth <= 800
					? this.workspaceWidth - 50
					: this.workspaceWidth - 340 - (this.previewOpen ? this.previewWidth + 5 : 0)
			)
		)
	);
	maxPreviewWidth = $derived(
		Math.max(
			EDITOR_LAYOUT_LIMITS.preview.min,
			Math.min(
				EDITOR_LAYOUT_LIMITS.preview.max,
				this.workspaceWidth <= 800
					? this.workspaceWidth - 30
					: this.workspaceWidth -
							340 -
							(this.explorerOpen ? Math.min(this.explorerWidth, this.maxExplorerWidth) + 5 : 0)
			)
		)
	);
	displayedExplorerWidth = $derived(Math.min(this.explorerWidth, this.maxExplorerWidth));
	displayedPreviewWidth = $derived(Math.min(this.previewWidth, this.maxPreviewWidth));
	bottomOpen = $state(true);
	bottomPanel = $state<BottomPanel>('problems');
	openDocuments = $state<DocumentId[]>(['info', 'instructions']);
	activeDocument = $state<DocumentId | null>('info');
	sourceDocuments = $state<string[]>([]);
	codeSelection = $state<string | null>(null);
	codeProject = $derived.by(() => {
		try {
			return this.draft ? parseCodeProject(JSON.parse(this.draft.documents.code)) : null;
		} catch {
			return null;
		}
	});
	codeDiagnostics = $state<CodeDiagnostic[]>([]);
	buildError = $state<{
		documentId: string;
		message: string;
		file?: string;
		line?: number;
		column?: number;
	} | null>(null);
	previewTimer: ReturnType<typeof setTimeout> | undefined;
	previewGeneration = 0;
	codeLocation = $state<{ line: number; column: number; sequence: number } | undefined>();
	monacoProject = new MonacoProject();
	receiveDiagnostics = (items: CodeDiagnostic[]) => {
		this.codeDiagnostics = items;
	};
	discardRequested = $state(false);
	logs = $state<{ id: number; time: string; message: string; failed: boolean }[]>([]);
	timer: ReturnType<typeof setTimeout> | undefined;
	disposed = false;
	logSequence = 0;
	validation = $derived(
		this.game && this.draft ? validateEditorDraft(this.game, this.draft) : null
	);
	changed = $derived(this.draft ? changedEditorDraft(this.draft) : false);
	baseDocuments = $derived(this.game ? createEditorDraft(this.game).documents : null);
	info = $derived(this.readFields(this.draft?.documents.info));
	instructions = $derived(this.readFields(this.draft?.documents.instructions));
	tabs = $derived(
		this.openDocuments.map((id) => ({
			id,
			title: this.documentLabel(id),
			dirty: this.documentDirty(id)
		}))
	);
	documentSource = $derived(this.activeDocument ? this.sourceFor(this.activeDocument) : '');
	problems = $derived.by(() => {
		const items = [
			...(this.validation?.problems ?? []),
			...this.codeDiagnostics.map((item) => ({
				documentId: 'code',
				message: item.message,
				file: item.module,
				line: item.line,
				column: item.column
			})),
			...(this.buildError ? [this.buildError] : [])
		];
		const unique: ((typeof items)[number] & { key: string })[] = [];
		for (const problem of items) {
			// Monaco and the build can report the same error. Keep one row per location/message.
			const key = JSON.stringify([
				problem.documentId,
				'file' in problem ? problem.file : null,
				'line' in problem ? problem.line : null,
				'column' in problem ? problem.column : null,
				problem.message
			]);
			if (!unique.some((item) => item.key === key)) {
				unique.push({ ...problem, key });
			}
		}
		return unique;
	});
	canApply = $derived(
		this.changed && !!this.validation?.game && !this.buildError && !this.editingBlocked
	);
	draftStatus = $derived.by(() => {
		if (this.saveError) {
			return '초안 저장 실패';
		}
		if (this.saving) {
			return '초안 저장 중…';
		}
		return this.savedLocally ? '초안 저장됨' : '적용된 콘텐츠';
	});
	categories: {
		title: string;
		icon: 'info' | 'book';
		documents: { id: DocumentId; file: string }[];
	}[] = [
		{
			title: '게임',
			icon: 'info',
			documents: [
				{ id: 'info', file: 'game.json' },
				{ id: 'instructions', file: 'instructions.json' }
			]
		},
		{
			title: '게임 데이터',
			icon: 'book',
			documents: [
				{ id: 'state', file: 'state.json' },
				{ id: 'lorebook', file: 'lorebook.json' }
			]
		}
	];
	panels = [
		{ id: 'problems', label: '문제' },
		{ id: 'logs', label: '실행 기록' },
		{ id: 'state', label: '상태' }
	] as const;
	readFields(source: string | undefined): Record<string, string> | null {
		if (!source) {
			return null;
		}
		try {
			const value: unknown = JSON.parse(source);
			if (!value || typeof value !== 'object' || Array.isArray(value)) {
				return null;
			}
			const entries = Object.entries(value);
			return entries.every(([, value]) => typeof value === 'string')
				? (Object.fromEntries(entries) as Record<string, string>)
				: null;
		} catch {
			return null;
		}
	}
	documentLabel = (id: string) => {
		if (id.startsWith('code:')) {
			return id.slice(5).split('/').at(-1) ?? id;
		}
		if (id.startsWith('asset:')) {
			try {
				return (
					JSON.parse(this.draft?.documents.assets ?? '{}')
						[id.slice(6)]?.name?.split('/')
						.at(-1) ?? '에셋'
				);
			} catch {
				return '에셋';
			}
		}
		if (id === 'types:GameState') {
			return 'GameState.d.ts';
		}
		return EDITOR_DOCUMENTS.find((document) => document.id === id)?.label ?? id;
	};
	documentFile = (id: string) => {
		if (id.startsWith('code:')) {
			return id.slice(5);
		}
		if (id === 'types:GameState') {
			return 'GameState.d.ts';
		}
		return (
			this.categories
				.flatMap((category) => category.documents)
				.find((document) => document.id === id)?.file ?? ''
		);
	};
	sourceFor(id: DocumentId): string {
		if (id === 'types:GameState') {
			return this.stateTypes;
		}
		if (id.startsWith('code:')) {
			return this.codeProject?.files[id.slice(5)]?.source ?? '';
		}
		if (id.startsWith('asset:')) {
			return '';
		}
		return this.draft?.documents[id as EditorDocumentId] ?? '';
	}
	documentDirty = (id: DocumentId): boolean => {
		if (!this.draft || !this.baseDocuments) {
			return false;
		}
		if (id === 'types:GameState') {
			return false;
		}
		if (id.startsWith('code:')) {
			try {
				return (
					JSON.stringify(this.codeProject?.files[id.slice(5)]) !==
					JSON.stringify(parseCodeProject(JSON.parse(this.baseDocuments.code)).files[id.slice(5)])
				);
			} catch {
				return true;
			}
		}
		if (id.startsWith('asset:')) {
			return this.draft.documents.assets !== this.baseDocuments.assets;
		}
		return (
			this.draft.documents[id as EditorDocumentId] !== this.baseDocuments[id as EditorDocumentId]
		);
	};
	updateSource = (id: DocumentId, value: string) => {
		if (id.startsWith('code:')) {
			const path = id.slice(5);
			if (this.codeProject?.files[path]) {
				this.changeDocument(
					'code',
					JSON.stringify(
						{
							...this.codeProject,
							files: {
								...this.codeProject.files,
								[path]: { ...this.codeProject.files[path], source: value }
							}
						},
						null,
						2
					)
				);
			}
		} else if (id !== 'types:GameState' && !id.startsWith('asset:')) {
			this.changeDocument(id as EditorDocumentId, value);
		}
	};
	moveCode = (before: string, after: string) => {
		const move = (id: DocumentId): DocumentId =>
			id.startsWith('code:') && (id.slice(5) === before || id.slice(5).startsWith(before + '/'))
				? (('code:' + after + id.slice(5 + before.length)) as DocumentId)
				: id;
		this.openDocuments = this.openDocuments.map(move);

		if (this.codeSelection === before || this.codeSelection?.startsWith(before + '/')) {
			this.codeSelection = after + this.codeSelection.slice(before.length);
		}
		if (this.activeDocument) {
			this.activeDocument = move(this.activeDocument);
		}
		this.secondaryDocument = move(this.secondaryDocument);
	};
	removeCode = (paths: string[]) => {
		for (const path of paths) {
			this.closeDocument('code:' + path);
		}
	};
	showProblem = (problem: {
		documentId: string;
		file?: string;
		line?: number;
		column?: number;
	}) => {
		if (problem.file) {
			this.openDocument(('code:' + problem.file) as DocumentId);
			this.codeLocation = {
				line: problem.line ?? 1,
				column: problem.column ?? 1,
				sequence: (this.codeLocation?.sequence ?? 0) + 1
			};
		} else if (problem.documentId === 'code') {
			if (this.codeProject) {
				this.openDocument(('code:' + this.codeProject.entry) as DocumentId);
			}
		} else if (problem.documentId === 'assets') {
			const id = Object.keys(JSON.parse(this.draft?.documents.assets ?? '{}'))[0];
			if (id) {
				this.openDocument(('asset:' + id) as DocumentId);
			}
		} else {
			this.openDocument(problem.documentId as DocumentId);
		}
	};
	schedulePreview = (candidate: Game) => {
		clearTimeout(this.previewTimer);
		const generation = ++this.previewGeneration;
		this.buildError = null;
		this.previewTimer = setTimeout(async () => {
			try {
				const compiled = await compileAuthoringGame(candidate);
				if (this.disposed || generation !== this.previewGeneration) {
					return;
				}
				this.previewContent = compiled;
			} catch (error) {
				if (this.disposed || generation !== this.previewGeneration) {
					return;
				}
				const detail = error as { file?: string; line?: number; column?: number };
				this.buildError = {
					documentId: 'code',
					message: error instanceof Error ? error.message : '코드를 빌드하지 못했어요.',
					file: detail.file,
					line: detail.line,
					column: detail.column
				};
			}
		}, 300);
	};
	log = (message: string, failed = false) => {
		this.logs = [
			...this.logs,
			{
				id: ++this.logSequence,
				time: new SvelteDate().toLocaleTimeString('ko-KR', { hour12: false }),
				message,
				failed
			}
		];
	};
	load = async () => {
		const generation = ++this.loadGeneration;
		this.loading = true;
		this.missing = false;
		this.loadError = '';
		this.recoveryError = '';
		try {
			const workspace = await getGameWorkspace(this.gameId);
			if (this.disposed || generation !== this.loadGeneration) {
				return;
			}
			if (!workspace) {
				this.missing = true;
				return;
			}
			this.game = workspace.game;
			await this.recoverDraft(workspace.game, generation);
		} catch {
			if (!this.disposed) {
				this.loadError = '게임을 불러오지 못했어요. 다시 시도해주세요.';
			}
		} finally {
			if (!this.disposed && generation === this.loadGeneration) {
				this.loading = false;
			}
		}
	};
	recoverCache(remote: Awaited<ReturnType<typeof loadAuthoringDraft>>) {
		let cachedText: string | null = null;
		try {
			cachedText = localStorage.getItem('helia:editor-draft:' + this.gameId);
		} catch {
			/* Durable storage remains available. */
		}
		if (cachedText === null) {
			return remote.draft;
		}
		try {
			const cache = loadEditorDraft(this.gameId);
			const revision = localStorage.getItem('helia:editor-draft-revision:' + this.gameId);
			const matches =
				revision === String(remote.version) ||
				(remote.version === 0 && revision === null && !remote.draft);
			return cache && matches ? cache : remote.draft;
		} catch (error) {
			if (!remote.draft) {
				throw error;
			}
			return remote.draft;
		}
	}
	migrateSettings(
		game: Game,
		draft: EditorDraft,
		legacy: NonNullable<ReturnType<typeof loadSettingsDraft>>
	) {
		return {
			...draft,
			documents: {
				...draft.documents,
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
	}
	async finishRecovery(legacy: ReturnType<typeof loadSettingsDraft>) {
		if (JSON.stringify(this.draft) === this.persistedSource) {
			return;
		}
		const saved = await this.persistDraft();
		if (!saved || !legacy) {
			return;
		}
		try {
			clearSettingsDraft(this.gameId, legacy);
		} catch {
			/* Durable copy is already saved. */
		}
	}
	legacySettings(recovered: EditorDraft | null, version: number) {
		if (recovered || version !== 0) {
			return null;
		}
		return loadSettingsDraft(this.gameId);
	}
	async recoverDraft(game: Game, generation: number) {
		try {
			const remote = await loadAuthoringDraft(this.gameId);
			if (this.disposed || generation !== this.loadGeneration) {
				return;
			}
			this.draftVersion = remote.version;
			this.draftLoaded = true;
			this.persistedSource = JSON.stringify(remote.draft ?? createEditorDraft(game));
			const recovered = this.recoverCache(remote);
			const legacy = this.legacySettings(recovered, remote.version);
			let next = recovered ?? createEditorDraft(game);
			if (legacy) {
				next = this.migrateSettings(game, next, legacy);
			}
			this.draft = next;
			this.previewContent = game;
			const candidate = validateEditorDraft(game, next).game;
			if (candidate) {
				this.schedulePreview(candidate);
			}
			this.savedLocally = changedEditorDraft(next) && JSON.stringify(next) === this.persistedSource;
			this.log(
				recovered || legacy ? '저장된 편집 초안을 복구했어요.' : '게임 콘텐츠를 불러왔어요.'
			);
			await this.finishRecovery(legacy);
		} catch (error) {
			if (!this.disposed && generation === this.loadGeneration) {
				this.recoveryError =
					error instanceof Error ? error.message : '편집 초안을 불러오지 못했어요.';
			}
		}
	}
	clearAppliedCache(snapshot: EditorDraft) {
		try {
			clearEditorDraft(this.gameId, snapshot);
		} catch {
			/* Old revisions cannot replace cleared durable drafts. */
		}
	}
	changeDocument = (id: EditorDocumentId, value: string) => {
		if (!this.draft || this.editingBlocked) {
			return;
		}
		this.draft = { ...this.draft, documents: { ...this.draft.documents, [id]: value } };
		if (this.game) {
			const checked = validateEditorDraft(this.game, this.draft);
			if (checked.game) {
				this.schedulePreview(checked.game);
			} else {
				clearTimeout(this.previewTimer);
				++this.previewGeneration;
			}
		}
		this.saveError = '';
		this.applyError = '';
		this.saving = true;
		this.discardRequested = false;
		clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.persistDraft();
		}, 250);
	};
	changeField = (id: 'info' | 'instructions', key: string, value: string) => {
		const fields = this.readFields(this.draft?.documents[id]);
		if (fields) {
			this.changeDocument(id, JSON.stringify({ ...fields, [key]: value }, null, 2));
		}
	};
	persistDraft = async (): Promise<boolean> => {
		clearTimeout(this.timer);
		this.timer = undefined;
		if (!this.draft) {
			return true;
		}
		const snapshot = this.draft;
		const source = JSON.stringify(snapshot);
		this.cacheDraft(snapshot);
		if (!this.disposed) {
			this.saving = true;
		}
		const operation = this.saveQueue.then(async () => {
			try {
				if (source !== this.persistedSource) {
					const saved = await saveAuthoringDraft(this.gameId, snapshot, this.draftVersion);
					this.draftVersion = saved.version;
					this.persistedSource = source;
				}
				// The latest local edit descends from this revision even if another save is queued.
				if (this.draft) {
					this.cacheDraft(this.draft);
				}
				if (!this.disposed) {
					this.saveError = '';
					this.savedLocally = this.changed && JSON.stringify(this.draft) === this.persistedSource;
				}
				return true;
			} catch (error) {
				if (!this.disposed) {
					this.saveError = error instanceof Error ? error.message : '초안을 저장하지 못했어요.';
				}
				return false;
			}
		});
		this.saveQueue = operation;
		const result = await operation;
		if (!this.disposed && this.saveQueue === operation) {
			this.saving = this.timer !== undefined;
		}
		return result;
	};
	cacheDraft = (snapshot: EditorDraft) => {
		try {
			storeEditorDraft(snapshot);
			localStorage.setItem('helia:editor-draft-revision:' + this.gameId, String(this.draftVersion));
		} catch {
			/* Recovery cache is secondary to the durable store. */
		}
	};
	codePath(id: DocumentId): string | null {
		if (id.startsWith('code:')) {
			return id.slice(5);
		}
		return id === 'types:GameState' ? 'GameState.d.ts' : null;
	}
	secondaryPath = $derived.by(() => {
		const path = this.codePath(this.secondaryDocument);
		return path ?? 'documents/' + this.secondaryDocument + '.json';
	});
	openDocument = (id: DocumentId) => {
		this.codeLocation = undefined;
		this.codeSelection = this.codePath(id);
		if (!this.openDocuments.includes(id)) {
			this.openDocuments = [...this.openDocuments, id];
		}
		this.activeDocument = id;
	};
	closeDocument = (id: string) => {
		const index = this.openDocuments.indexOf(id as DocumentId);
		this.openDocuments = this.openDocuments.filter((document) => document !== id);
		if (this.activeDocument === id) {
			this.activeDocument =
				this.openDocuments[Math.min(index, this.openDocuments.length - 1)] ?? null;
		}
	};
	toggleSource = (id: DocumentId) => {
		this.sourceDocuments = this.sourceDocuments.includes(id)
			? this.sourceDocuments.filter((document) => document !== id)
			: [...this.sourceDocuments, id];
	};
	apply = async () => {
		if (!this.draft || !this.game || this.editingBlocked || !this.changed) {
			return;
		}
		this.applying = true;
		this.applyError = '';
		try {
			if (!(await this.persistDraft()) || this.disposed) {
				return;
			}
			const snapshot = this.draft;
			const checked = validateEditorDraft(this.game, snapshot);
			if (!checked.game) {
				this.bottomOpen = true;
				this.bottomPanel = 'problems';
				return;
			}
			const updated = await applyGameDraft(this.gameId, {
				baseContent: snapshot.baseContent,
				content: editorContent(checked.game)
			});
			if (this.disposed) {
				return;
			}
			this.game = updated;
			this.draft = createEditorDraft(updated);
			this.previewContent = updated;
			this.savedLocally = false;
			try {
				const saved = await saveAuthoringDraft(this.gameId, null, this.draftVersion);
				this.draftVersion = saved.version;
				this.persistedSource = JSON.stringify(this.draft);
				this.clearAppliedCache(snapshot);
			} catch {
				this.saveError = '적용은 완료됐지만 저장된 초안을 정리하지 못했어요.';
			}
			this.log('편집한 콘텐츠를 게임에 적용했어요. 기존 플레이 기록은 유지됩니다.');
		} catch (error) {
			if (!this.disposed) {
				this.applyError =
					error instanceof Error ? error.message : '게임에 적용하지 못했어요. 초안은 유지됩니다.';
				this.log('게임 적용에 실패했어요. 초안은 유지됩니다.', true);
			}
		} finally {
			if (!this.disposed) {
				this.applying = false;
			}
		}
	};
	discard = async () => {
		if (!this.game || this.editingBlocked) {
			return;
		}
		this.discarding = true;
		try {
			clearTimeout(this.timer);
			this.timer = undefined;
			await this.saveQueue;
			if (!this.draftLoaded) {
				const remote = await loadAuthoringDraft(this.gameId);
				this.draftVersion = remote.version;
				this.draftLoaded = true;
			}
			const saved = await saveAuthoringDraft(this.gameId, null, this.draftVersion);
			this.draftVersion = saved.version;
			try {
				clearEditorDraft(this.gameId);
			} catch {
				/* The durable tombstone takes priority over an old cache. */
			}
			if (this.disposed) {
				return;
			}
			this.draft = createEditorDraft(this.game);
			clearTimeout(this.previewTimer);
			++this.previewGeneration;
			this.codeDiagnostics = [];
			this.buildError = null;
			this.persistedSource = JSON.stringify(this.draft);
			this.previewContent = this.game;
			this.savedLocally = false;
			this.saving = false;
			this.saveError = '';
			this.applyError = '';
			this.recoveryError = '';
			this.discardRequested = false;
			this.log('미적용 초안을 버리고 적용된 콘텐츠로 돌아왔어요.');
		} catch (error) {
			if (!this.disposed) {
				this.saveError =
					error instanceof Error
						? error.message
						: '저장된 초안을 정리하지 못했어요. 다시 시도해주세요.';
			}
		} finally {
			if (!this.disposed) {
				this.discarding = false;
			}
		}
	};
	returnToPlay = async (event: MouseEvent) => {
		if (this.editingBlocked) {
			event.preventDefault();
			return;
		}
		if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
			return;
		}
		event.preventDefault();
		this.navigationError = '';
		this.leaving = true;
		try {
			if ((this.draft && this.changed && !(await this.persistDraft())) || this.disposed) {
				return;
			}
			await goto(resolve('/games/[id]', { id: this.gameId }));
		} catch {
			this.navigationError = '플레이 화면을 열지 못했어요. 다시 시도해주세요.';
		} finally {
			this.leaving = false;
		}
	};
	shortcuts = (event: KeyboardEvent) => {
		if (!this.draft || this.editingBlocked || !(event.ctrlKey || event.metaKey)) {
			return;
		}
		if (event.key.toLowerCase() === 's') {
			event.preventDefault();
			this.persistDraft();
		} else if (event.key === 'Enter') {
			event.preventDefault();
			void this.apply();
		}
	};
	resizeSplit = (event: PointerEvent) => {
		const handle = event.currentTarget as HTMLElement;
		if (event.type === 'pointerdown') {
			handle.setPointerCapture(event.pointerId);
		}
		if (!handle.hasPointerCapture(event.pointerId)) {
			return;
		}
		const bounds = handle.parentElement?.getBoundingClientRect();
		if (bounds) {
			this.splitRatio = Math.max(
				25,
				Math.min(75, ((event.clientX - bounds.left) / bounds.width) * 100)
			);
		}
	};
	resizeSplitKey = (event: KeyboardEvent) => {
		if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
			return;
		}
		event.preventDefault();
		this.splitRatio = resizeValue(event.key, {
			min: 25,
			max: 75,
			current: this.splitRatio,
			step: event.key === 'ArrowRight' ? 5 : -5
		});
	};
	saveLayout = () => {
		try {
			storeEditorLayout(this.gameId, {
				explorerWidth: this.explorerWidth,
				previewWidth: this.previewWidth,
				bottomHeight: this.bottomHeight
			});
			this.layoutWarning = '';
		} catch {
			this.layoutWarning = '조절한 패널 크기를 이 기기에 저장하지 못했어요.';
		}
	};
	resizeEdge = (event: PointerEvent, edge: 'explorer' | 'preview') => {
		const handle = event.currentTarget as HTMLElement;
		if (event.type === 'pointerdown') {
			handle.setPointerCapture(event.pointerId);
		}
		if (!handle.hasPointerCapture(event.pointerId)) {
			return;
		}
		const bounds = handle.parentElement?.getBoundingClientRect();
		if (!bounds) {
			return;
		}
		if (edge === 'explorer') {
			this.explorerWidth = Math.max(
				EDITOR_LAYOUT_LIMITS.explorer.min,
				Math.min(this.maxExplorerWidth, event.clientX - bounds.left)
			);
		} else {
			this.previewWidth = Math.max(
				EDITOR_LAYOUT_LIMITS.preview.min,
				Math.min(this.maxPreviewWidth, bounds.right - event.clientX)
			);
		}
	};
	resizeEdgeKey = (event: KeyboardEvent, edge: 'explorer' | 'preview') => {
		if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
			return;
		}
		event.preventDefault();
		const minimum =
			edge === 'explorer' ? EDITOR_LAYOUT_LIMITS.explorer.min : EDITOR_LAYOUT_LIMITS.preview.min;
		const maximum = edge === 'explorer' ? this.maxExplorerWidth : this.maxPreviewWidth;
		const current = edge === 'explorer' ? this.displayedExplorerWidth : this.displayedPreviewWidth;
		const direction = edge === 'explorer' ? 1 : -1;
		const next = resizeValue(event.key, {
			min: minimum,
			max: maximum,
			current,
			step: (event.key === 'ArrowRight' ? 10 : -10) * direction
		});
		if (edge === 'explorer') {
			this.explorerWidth = next;
		} else {
			this.previewWidth = next;
		}
		this.saveLayout();
	};
	resizeBottom = (event: PointerEvent) => {
		const handle = event.currentTarget as HTMLElement;
		if (event.type === 'pointerdown') {
			if (event.button !== 0) {
				return;
			}
			event.preventDefault();
			handle.setPointerCapture(event.pointerId);
		}
		if (!handle.hasPointerCapture(event.pointerId)) {
			return;
		}
		const bounds = handle.parentElement?.getBoundingClientRect();
		if (bounds) {
			this.bottomHeight = Math.max(
				EDITOR_LAYOUT_LIMITS.bottom.min,
				Math.min(this.maxBottomHeight, bounds.bottom - event.clientY - handle.offsetHeight / 2)
			);
		}
	};
	resizeBottomKey = (event: KeyboardEvent) => {
		if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
			return;
		}
		event.preventDefault();
		this.bottomHeight = resizeValue(event.key, {
			min: EDITOR_LAYOUT_LIMITS.bottom.min,
			max: this.maxBottomHeight,
			current: this.displayedBottomHeight,
			step: event.key === 'ArrowUp' ? 10 : -10
		});
		this.saveLayout();
	};
	get gameId() {
		return this.readGameId();
	}
	constructor(private readonly readGameId: () => string) {
		this.initialize();
	}
	initialize() {
		onDestroy(() => this.monacoProject.dispose());
		$effect(() => {
			this.monacoProject.update(
				this.codeProject?.files ?? {},
				this.stateTypes,
				this.draft
					? Object.fromEntries(
							Object.entries(this.draft.documents)
								.filter(([id]) => !['code', 'assets'].includes(id))
								.map(([id, source]) => ['documents/' + id + '.json', source])
						)
					: {},
				this.receiveDiagnostics
			);
		});
		onMount(() => {
			this.restoreLayout();
			void this.load();
			return () => this.dispose();
		});
		this.watchNavigation();
	}
	restoreLayout() {
		try {
			const layout = loadEditorLayout(this.gameId);
			if (layout) {
				this.explorerWidth = layout.explorerWidth;
				this.previewWidth = layout.previewWidth;
				this.bottomHeight = layout.bottomHeight;
			}
		} catch {
			this.layoutWarning = '레이아웃 설정을 불러오지 못했어요.';
		}
		if (window.matchMedia('(max-width: 800px)').matches) {
			this.explorerOpen = false;
			this.previewOpen = false;
		}
	}
	dispose() {
		clearTimeout(this.timer);
		clearTimeout(this.previewTimer);
		++this.previewGeneration;
		if (
			this.draft &&
			this.changed &&
			!this.editingBlocked &&
			JSON.stringify(this.draft) !== this.persistedSource
		) {
			void this.persistDraft();
		}
		this.disposed = true;
	}
	watchNavigation() {
		beforeNavigate((navigation) => {
			if (this.allowNavigation) {
				this.allowNavigation = false;
				return;
			}
			if (this.applying || this.discarding) {
				navigation.cancel();
				return;
			}
			if (!this.draft || !this.changed || JSON.stringify(this.draft) === this.persistedSource) {
				return;
			}
			navigation.cancel();
			if (this.leaving) {
				return;
			}
			const target = navigation.to?.url;
			this.leaving = true;
			void (async () => {
				try {
					if (!(await this.persistDraft()) || !target || this.disposed) {
						return;
					}
					this.allowNavigation = true;
					if (navigation.willUnload) {
						window.location.assign(target.href);
					} else {
						const root = resolve('/').replace(/\/$/, '');
						await goto(
							resolve(
								`${target.pathname.slice(root.length)}${target.search}${target.hash}` as PathnameWithSearchOrHash
							)
						);
					}
				} catch {
					this.navigationError = '화면을 열지 못했어요. 초안은 유지됩니다.';
				} finally {
					this.allowNavigation = false;
					if (!this.disposed) {
						this.leaving = false;
					}
				}
			})();
		});
	}
}

function resizeValue(
	key: string,
	bounds: { min: number; max: number; current: number; step: number }
) {
	if (key === 'Home') {
		return bounds.min;
	}
	if (key === 'End') {
		return bounds.max;
	}
	return Math.max(bounds.min, Math.min(bounds.max, bounds.current + bounds.step));
}
