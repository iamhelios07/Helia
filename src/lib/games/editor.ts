import { parseGameAIContent } from './ai/prompts.js';
import { createCodeProject, parseCodeProject } from './code-project.js';
import { parseGame, parseGameSettings, validateGameMetadata, type Game } from './model.js';
import { parseResources } from './resources.js';
import { parseStateDocument } from './state/schema.js';

export const EDITOR_DOCUMENTS = [
	{ id: 'info', label: '게임 정보' },
	{ id: 'instructions', label: '게임 지침' },
	{ id: 'state', label: '상태' },
	{ id: 'code', label: '코드' },
	{ id: 'lorebook', label: '로어북' },
	{ id: 'assets', label: '에셋' }
] as const;
export type EditorDocumentId = (typeof EDITOR_DOCUMENTS)[number]['id'];
export type GameEditorContent = Pick<
	Game,
	| 'title'
	| 'genre'
	| 'description'
	| 'settings'
	| 'schema'
	| 'initialState'
	| 'scripts'
	| 'ui'
	| 'ai'
	| 'resources'
	| 'code'
>;
export interface EditorDraft {
	version: 3;
	gameId: string;
	baseContent: GameEditorContent;
	documents: Record<EditorDocumentId, string>;
}
export interface EditorProblem {
	documentId: EditorDocumentId;
	message: string;
}

const prefix = 'helia:editor-draft:';
const MAX_DRAFT_LENGTH = 16 * 1024 * 1024;
const format = (value: unknown) => JSON.stringify(value, null, 2);

/** Content comparison intentionally excludes active session and timestamps. */
export function editorContent(game: Game): GameEditorContent {
	return structuredClone({
		title: game.title,
		genre: game.genre,
		description: game.description,
		settings: game.settings,
		schema: game.schema,
		initialState: game.initialState,
		scripts: game.scripts,
		...(game.ui ? { ui: game.ui } : {}),
		...(game.ai ? { ai: game.ai } : {}),
		...(game.resources ? { resources: game.resources } : {}),
		...(game.code ? { code: game.code } : {})
	});
}

function documents(content: GameEditorContent): EditorDraft['documents'] {
	return {
		info: format({ title: content.title, genre: content.genre, description: content.description }),
		instructions: format(content.settings),
		state: format({ schema: content.schema, initialState: content.initialState }),
		code: format(createCodeProject(content)),
		lorebook: format(content.ai ?? { version: 1, lorebook: [] }),
		assets: format(content.resources ?? {})
	};
}
export function createEditorDraft(game: Game): EditorDraft {
	const baseContent = editorContent(game);
	return { version: 3, gameId: game.id, baseContent, documents: documents(baseContent) };
}
export function changedEditorDraft(draft: EditorDraft): boolean {
	const initial = documents(draft.baseContent);
	return EDITOR_DOCUMENTS.some(({ id }) => draft.documents[id] !== initial[id]);
}

export function readEditorDraft(text: string, gameId: string): EditorDraft {
	if (text.length > MAX_DRAFT_LENGTH) {
		throw new Error('편집 초안이 너무 커요.');
	}
	const value: unknown = JSON.parse(text);
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('잘못된 초안');
	}
	const row = value as Record<string, unknown>;
	if (
		(row.version !== 1 && row.version !== 2 && row.version !== 3) ||
		row.gameId !== gameId ||
		!row.documents ||
		typeof row.documents !== 'object' ||
		Array.isArray(row.documents)
	) {
		throw new Error('잘못된 초안');
	}
	const source = row.documents as Record<string, unknown>;
	migrateDraftDocuments(source, row.version as number);
	if (EDITOR_DOCUMENTS.some(({ id }) => typeof source[id] !== 'string')) {
		throw new Error('잘못된 초안');
	}
	// Rebuild the stored base with the same runtime validators used by persisted games.
	const base = parseGame({
		...(row.baseContent as object),
		schemaVersion: 2,
		id: gameId,
		activeSessionId: 'editor-base',
		createdAt: '2000-01-01T00:00:00.000Z',
		updatedAt: '2000-01-01T00:00:00.000Z'
	});
	return {
		version: 3,
		gameId,
		baseContent: editorContent(base),
		documents: Object.fromEntries(
			EDITOR_DOCUMENTS.map(({ id }) => [id, source[id]])
		) as EditorDraft['documents']
	};
}
export function loadEditorDraft(gameId: string): EditorDraft | null {
	try {
		const text = localStorage.getItem(prefix + gameId);
		return text === null ? null : readEditorDraft(text, gameId);
	} catch {
		throw new Error('편집 초안을 불러오지 못했어요. 저장된 초안은 유지됩니다.');
	}
}
export function storeEditorDraft(draft: EditorDraft): void {
	try {
		const text = JSON.stringify(draft);
		readEditorDraft(text, draft.gameId);
		localStorage.setItem(prefix + draft.gameId, text);
	} catch {
		throw new Error('편집 초안을 저장하지 못했어요. 입력 내용은 화면에 유지됩니다.');
	}
}
export function clearEditorDraft(gameId: string, expectedDraft?: EditorDraft): void {
	if (expectedDraft && localStorage.getItem(prefix + gameId) !== JSON.stringify(expectedDraft)) {
		return;
	}
	localStorage.removeItem(prefix + gameId);
}

/** Invalid source remains in the draft while each document gets an actionable problem. */
export function validateEditorDraft(
	game: Game,
	draft: EditorDraft
): { game: Game | null; problems: EditorProblem[] } {
	const problems: EditorProblem[] = [];
	function check<T>(id: EditorDocumentId, validate: (value: unknown) => T): T | undefined {
		try {
			return validate(JSON.parse(draft.documents[id]) as unknown);
		} catch (error) {
			problems.push({
				documentId: id,
				message: draftProblem(error)
			});
			return undefined;
		}
	}
	const info = check('info', validateGameMetadata);
	const settings = check('instructions', parseGameSettings);
	const stateDocument = check('state', parseStateDocument);
	const code = check('code', parseCodeProject);
	const ai = check('lorebook', parseGameAIContent);
	const resources = check('assets', parseResources);
	if (problems.length || !info || !settings || !stateDocument || !code || !ai || !resources) {
		return { game: null, problems };
	}
	return {
		game: parseGame({
			...game,
			...info,
			settings,
			...stateDocument,
			code,
			ai,
			resources
		}),
		problems
	};
}

function migrateDraftDocuments(source: Record<string, unknown>, version: number) {
	if (version === 1) {
		if (typeof source.schema !== 'string' || typeof source.state !== 'string') {
			throw new Error('잘못된 초안');
		}
		// Wrap unfinished text verbatim too: migration must never discard an incomplete edit.
		const combined = `{\n"schema": ${source.schema},\n"initialState": ${source.state}\n}`;
		try {
			source.state = format(JSON.parse(combined));
		} catch {
			source.state = combined;
		}
	}
	if (source.assets === undefined) {
		source.assets = '{}';
	}

	migrateDraftCode(source, version);
}
function migrateDraftCode(source: Record<string, unknown>, version: number) {
	if (version !== 3) {
		if (typeof source.scripts !== 'string' || typeof source.ui !== 'string') {
			throw new Error('잘못된 초안');
		}
		try {
			source.code = format(
				createCodeProject({
					scripts: JSON.parse(source.scripts),
					ui: JSON.parse(source.ui) ?? undefined
				})
			);
		} catch {
			throw new Error('이전 코드 초안을 변환하지 못했어요. 저장된 원본은 유지됩니다.');
		}
	}
}
function draftProblem(error: unknown) {
	if (error instanceof SyntaxError) {
		return 'JSON 형식을 확인해주세요.';
	}
	if (error instanceof Error && !error.message.startsWith('AI 응답')) {
		return error.message;
	}
	return '입력 형식을 확인해주세요.';
}
