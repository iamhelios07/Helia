import {
	parseGame,
	parseGameSettings,
	parseScripts,
	validateGameMetadata,
	type Game
} from './model.js';
import { parseObjectSchema, parseStateDocument } from './state/schema.js';
import { parseGameUI } from './ui/runtime/model.js';
import { parseGameAIContent } from './ai/prompts.js';

export const EDITOR_DOCUMENTS = [
	{ id: 'info', label: '게임 정보' },
	{ id: 'instructions', label: '게임 지침' },
	{ id: 'schema', label: '상태 스키마' },
	{ id: 'state', label: '초기 상태' },
	{ id: 'scripts', label: '로직' },
	{ id: 'ui', label: '화면' },
	{ id: 'lorebook', label: '로어북' }
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
>;
export interface EditorDraft {
	version: 1;
	gameId: string;
	baseContent: GameEditorContent;
	documents: Record<EditorDocumentId, string>;
}
export interface EditorProblem {
	documentId: EditorDocumentId;
	message: string;
}

const prefix = 'helia:editor-draft:';
const MAX_DRAFT_LENGTH = 4 * 1024 * 1024;
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
		...(game.ai ? { ai: game.ai } : {})
	});
}

function documents(content: GameEditorContent): EditorDraft['documents'] {
	return {
		info: format({ title: content.title, genre: content.genre, description: content.description }),
		instructions: format(content.settings),
		schema: format(content.schema),
		state: format(content.initialState),
		scripts: format(content.scripts),
		ui: format(content.ui ?? null),
		lorebook: format(content.ai ?? { version: 1, lorebook: [] })
	};
}
export function createEditorDraft(game: Game): EditorDraft {
	const baseContent = editorContent(game);
	return { version: 1, gameId: game.id, baseContent, documents: documents(baseContent) };
}
export function changedEditorDraft(draft: EditorDraft): boolean {
	const initial = documents(draft.baseContent);
	return EDITOR_DOCUMENTS.some(({ id }) => draft.documents[id] !== initial[id]);
}

function readDraft(text: string, gameId: string): EditorDraft {
	if (text.length > MAX_DRAFT_LENGTH) throw new Error('편집 초안이 너무 커요.');
	const value: unknown = JSON.parse(text);
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('잘못된 초안');
	const row = value as Record<string, unknown>;
	if (
		row.version !== 1 ||
		row.gameId !== gameId ||
		!row.documents ||
		typeof row.documents !== 'object' ||
		Array.isArray(row.documents)
	)
		throw new Error('잘못된 초안');
	const source = row.documents as Record<string, unknown>;
	if (EDITOR_DOCUMENTS.some(({ id }) => typeof source[id] !== 'string'))
		throw new Error('잘못된 초안');
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
		version: 1,
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
		return text === null ? null : readDraft(text, gameId);
	} catch {
		throw new Error('편집 초안을 불러오지 못했어요. 저장된 초안은 유지됩니다.');
	}
}
export function storeEditorDraft(draft: EditorDraft): void {
	try {
		const text = JSON.stringify(draft);
		readDraft(text, draft.gameId);
		localStorage.setItem(prefix + draft.gameId, text);
	} catch {
		throw new Error('편집 초안을 저장하지 못했어요. 입력 내용은 화면에 유지됩니다.');
	}
}
export function clearEditorDraft(gameId: string, expectedDraft?: EditorDraft): void {
	if (expectedDraft && localStorage.getItem(prefix + gameId) !== JSON.stringify(expectedDraft))
		return;
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
				message:
					error instanceof SyntaxError
						? 'JSON 형식을 확인해주세요.'
						: error instanceof Error && !error.message.startsWith('AI 응답')
							? error.message
							: '입력 형식을 확인해주세요.'
			});
			return undefined;
		}
	}
	const info = check('info', validateGameMetadata);
	const settings = check('instructions', parseGameSettings);
	const schema = check('schema', parseObjectSchema);
	const state = check('state', (value) => value);
	const scripts = check('scripts', parseScripts);
	const ui = check('ui', (value) => (value === null ? null : parseGameUI(value)));
	const ai = check('lorebook', parseGameAIContent);
	let stateDocument: ReturnType<typeof parseStateDocument> | undefined;
	if (schema !== undefined && state !== undefined) {
		try {
			stateDocument = parseStateDocument({ schema, initialState: state });
		} catch (error) {
			problems.push({
				documentId: 'state',
				message: error instanceof Error ? error.message : '스키마와 초기 상태를 확인해주세요.'
			});
		}
	}
	if (
		problems.length ||
		!info ||
		!settings ||
		!stateDocument ||
		!scripts ||
		ui === undefined ||
		!ai
	)
		return { game: null, problems };
	return {
		game: parseGame({
			...game,
			...info,
			settings,
			...stateDocument,
			scripts,
			ui: ui ?? undefined,
			ai
		}),
		problems
	};
}
