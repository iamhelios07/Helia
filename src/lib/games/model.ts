import { parseStateDocument, type ObjectSchema } from '#lib/games/state/schema.js';
import { validateStateKey, type GameState } from '#lib/games/state/value.js';

import { parseGameAIContent, type GameAIContent } from './ai/prompts.js';
import { parseCodeProject, type CodeProject } from './code-project.js';
import { parseInstalledFrom, type InstalledFrom } from './installed-from.js';
import { parseRegexRules, type RegexRule } from './regex.js';
import { parseResources, type GameResources } from './resources.js';
import { parseGameUI, type GameUI } from './ui/runtime/model.js';
import { originalGameId } from './versioning.js';

export const GAME_TITLE_MAX_LENGTH = 120;
export const GAME_GENRE_MAX_LENGTH = 80;
export const GAME_DESCRIPTION_MAX_LENGTH = 2000;
export const SESSION_TITLE_MAX_LENGTH = 120;

export interface GameMetadata {
	title: string;
	genre: string;
	description: string;
}

/** Authoring text, kept separate from the library's display metadata. */
export interface GameSettings {
	description: string;
	firstMessage: string;
	authorNote: string;
}

export interface UpdateGameSettings extends GameSettings {
	title: string;
}

/** Creator-owned game content. Each playthrough keeps its own snapshot. */
export interface Game extends GameMetadata {
	schemaVersion: 2;
	id: string;
	originalGameId?: string;
	installedFrom?: InstalledFrom;
	activeSessionId: string;
	createdAt: string;
	updatedAt: string;
	/** Set while the game sits in the Trash; the timestamp marks when it moved there. */
	trashedAt?: string;
	settings: GameSettings;
	initialState: GameState;
	schema: ObjectSchema;
	/** Source declarations; execution is handled separately. */
	scripts: Record<
		string,
		{ language: string; source: string; compiled?: string; compiledFor?: string; artifact?: string }
	>;
	ui?: GameUI;
	ai?: GameAIContent;
	/** Current chat-processing rules, independent of session state and branch history. */
	regex?: RegexRule[];
	resources?: GameResources;
	code?: CodeProject;
}

/** Library entries never carry executable content, state or embedded media. */
export type GameSummary = Pick<
	Game,
	| 'schemaVersion'
	| 'id'
	| 'title'
	| 'genre'
	| 'description'
	| 'activeSessionId'
	| 'createdAt'
	| 'updatedAt'
	| 'trashedAt'
>;
export function gameSummary(input: unknown): GameSummary {
	if (
		!isRecord(input) ||
		input.schemaVersion !== 2 ||
		!isIdentifier(input.id) ||
		!isIdentifier(input.activeSessionId) ||
		!isTimestamp(input.createdAt) ||
		!isTimestamp(input.updatedAt)
	) {
		throw Error('Invalid game summary');
	}
	return {
		...validateGameMetadata(input),
		schemaVersion: 2,
		id: input.id,
		activeSessionId: input.activeSessionId,
		createdAt: input.createdAt,
		updatedAt: input.updatedAt,
		...(isTrashed(input.trashedAt) ? { trashedAt: input.trashedAt } : {})
	};
}

/** One independent playthrough, corresponding to a chat in a chat-based client. */
export interface Session {
	schemaVersion: 1;
	id: string;
	gameId: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	/** Total persisted messages, including archived branches. */
	messageCount?: number;
}

export interface Message {
	schemaVersion: 1;
	id: string;
	gameId: string;
	sessionId: string;
	sequence: number;
	role: 'user' | 'assistant';
	/** Authored opening or dialogue attached to a transaction. */
	kind?: 'opening' | 'dialogue';
	content: string;
	createdAt: string;
}

export interface SessionConversation {
	session: Session;
	messages: Message[];
}

export type MessageInput = Pick<Message, 'role' | 'content'>;

/** Shared validation for creator UI, scripting output and trusted storage operations. */
export function parseMessageInput(value: unknown): MessageInput {
	if (!isRecord(value) || (value.role !== 'user' && value.role !== 'assistant')) {
		throw new Error('메시지 역할은 user 또는 assistant여야 해요.');
	}
	return { role: value.role, content: validateMessageContent(value.content) };
}

export interface GameWorkspace {
	game: Game;
	sessions: Session[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateGameTitle(value: string): string {
	const title = value.trim();
	if (!title) {
		throw new Error('게임 이름을 입력해주세요.');
	}
	if (title.length > GAME_TITLE_MAX_LENGTH) {
		throw new Error(`게임 이름은 ${GAME_TITLE_MAX_LENGTH}자까지 입력할 수 있어요.`);
	}
	return title;
}

export function validateGameMetadata(value: unknown): GameMetadata {
	if (
		!isRecord(value) ||
		typeof value.title !== 'string' ||
		typeof value.genre !== 'string' ||
		typeof value.description !== 'string'
	) {
		throw new Error('게임 기본 정보의 형식이 올바르지 않아요.');
	}
	const title = validateGameTitle(value.title);
	const genre = value.genre.trim();
	const description = value.description.trim();
	if (genre.length > GAME_GENRE_MAX_LENGTH) {
		throw new Error(`장르는 ${GAME_GENRE_MAX_LENGTH}자까지 입력할 수 있어요.`);
	}
	if (description.length > GAME_DESCRIPTION_MAX_LENGTH) {
		throw new Error(`소개는 ${GAME_DESCRIPTION_MAX_LENGTH}자까지 입력할 수 있어요.`);
	}
	return { title, genre, description };
}

export function parseGameSettings(value: unknown): GameSettings {
	if (
		!isRecord(value) ||
		typeof value.description !== 'string' ||
		typeof value.firstMessage !== 'string' ||
		typeof value.authorNote !== 'string'
	) {
		throw new Error('게임 설정의 형식이 올바르지 않아요.');
	}
	// Whitespace and line breaks can carry meaning in authoring text.
	return {
		description: value.description,
		firstMessage: value.firstMessage,
		authorNote: value.authorNote
	};
}

export function validateGameSettings(value: unknown): UpdateGameSettings {
	if (!isRecord(value) || typeof value.title !== 'string') {
		throw new Error('게임 설정의 형식이 올바르지 않아요.');
	}
	const title = validateGameTitle(value.title);
	return { title, ...parseGameSettings(value) };
}

export function validateSessionTitle(value: unknown): string {
	if (typeof value !== 'string' || !value.trim()) {
		throw new Error('세션 이름을 입력해주세요.');
	}
	const title = value.trim();
	if (title.length > SESSION_TITLE_MAX_LENGTH) {
		throw new Error(`세션 이름은 ${SESSION_TITLE_MAX_LENGTH}자까지 입력할 수 있어요.`);
	}
	return title;
}

function isIdentifier(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

function isTimestamp(value: unknown): value is string {
	return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function parseGame(value: unknown): Game {
	if (
		!isRecord(value) ||
		value.schemaVersion !== 2 ||
		!isIdentifier(value.id) ||
		!isIdentifier(value.activeSessionId) ||
		!isTimestamp(value.createdAt) ||
		!isTimestamp(value.updatedAt)
	) {
		throw new Error('저장된 게임 정보를 읽을 수 없어요.');
	}
	return {
		...validateGameMetadata(value),
		schemaVersion: 2,
		id: value.id,
		...(value.originalGameId === undefined
			? {}
			: { originalGameId: originalGameId(value.originalGameId) }),
		activeSessionId: value.activeSessionId,
		...(value.installedFrom === undefined
			? {}
			: { installedFrom: parseInstalledFrom(value.installedFrom) }),
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
		...(isTrashed(value.trashedAt) ? { trashedAt: value.trashedAt } : {}),
		...parseStateDocument({ schema: value.schema, initialState: value.initialState }),
		scripts: parseScripts(value.scripts),
		...(value.code === undefined ? {} : { code: parseCodeProject(value.code) }),
		...(value.ui === undefined ? {} : { ui: parseGameUI(value.ui) }),
		...(value.ai === undefined ? {} : { ai: parseGameAIContent(value.ai) }),
		...(value.regex === undefined ? {} : { regex: parseRegexRules(value.regex) }),
		...(value.resources === undefined ? {} : { resources: parseResources(value.resources) }),
		settings: parseGameSettings(value.settings)
	};
}

/** A trashed timestamp is stored as-is; anything else counts as never trashed. */
function isTrashed(value: unknown): value is string {
	return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/** Scripts saved before TypeScript-only support load as TypeScript instead of being rejected. */
function scriptLanguage(value: string): string {
	return ['javascript', 'js'].includes(value) ? 'typescript' : value;
}

function validateScriptBuild(script: Record<string, unknown>): void {
	if (
		script.compiled !== undefined &&
		(typeof script.compiled !== 'string' || script.compiled.length > 1024 * 1024)
	) {
		throw Error('Invalid compiled script');
	}
	if (
		script.artifact !== undefined &&
		(typeof script.artifact !== 'string' || !/^[a-f0-9]{64}$/.test(script.artifact))
	) {
		throw Error('Invalid script artifact');
	}
	if (
		script.compiledFor !== undefined &&
		(typeof script.compiledFor !== 'string' || !/^[a-f0-9]{64}$/.test(script.compiledFor))
	) {
		throw Error('Invalid script source fingerprint');
	}
}

export function parseScripts(value: unknown): Game['scripts'] {
	if (!isRecord(value)) {
		throw new Error('게임 스크립트의 형식이 올바르지 않아요.');
	}
	const scripts: Game['scripts'] = {};
	for (const [id, script] of Object.entries(value)) {
		validateStateKey(id);
		if (
			!id.trim() ||
			!isRecord(script) ||
			typeof script.language !== 'string' ||
			!script.language.trim() ||
			typeof script.source !== 'string'
		) {
			throw new Error('게임 스크립트의 형식이 올바르지 않아요.');
		}
		validateScriptBuild(script);
		scripts[id] = {
			language: scriptLanguage(script.language),
			source: script.source,
			...(script.compiled === undefined ? {} : { compiled: script.compiled as string }),
			...(typeof script.compiledFor === 'string' ? { compiledFor: script.compiledFor } : {}),
			...(script.artifact === undefined ? {} : { artifact: script.artifact as string })
		};
	}
	return scripts;
}

export function parseSession(value: unknown): Session {
	if (
		!isRecord(value) ||
		value.schemaVersion !== 1 ||
		!isIdentifier(value.id) ||
		!isIdentifier(value.gameId) ||
		!isIdentifier(value.title) ||
		value.title.length > SESSION_TITLE_MAX_LENGTH ||
		!isTimestamp(value.createdAt) ||
		!isTimestamp(value.updatedAt) ||
		(value.messageCount !== undefined &&
			(typeof value.messageCount !== 'number' ||
				!Number.isSafeInteger(value.messageCount) ||
				value.messageCount < 0))
	) {
		throw new Error('저장된 세션 정보를 읽을 수 없어요.');
	}
	return {
		schemaVersion: 1,
		id: value.id,
		gameId: value.gameId,
		title: value.title,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
		...(value.messageCount === undefined ? {} : { messageCount: value.messageCount as number })
	};
}

export function validateMessageContent(value: unknown): string {
	if (typeof value !== 'string' || !value.trim()) {
		throw new Error('메시지를 입력해주세요.');
	}
	return value;
}

export function parseMessage(value: unknown): Message {
	if (
		!isRecord(value) ||
		value.schemaVersion !== 1 ||
		!isIdentifier(value.id) ||
		!isIdentifier(value.gameId) ||
		!isIdentifier(value.sessionId) ||
		typeof value.sequence !== 'number' ||
		!Number.isSafeInteger(value.sequence) ||
		value.sequence < 1 ||
		(value.role !== 'user' && value.role !== 'assistant') ||
		(value.kind !== undefined && value.kind !== 'opening' && value.kind !== 'dialogue') ||
		(value.kind === 'opening' && value.role !== 'assistant') ||
		!isTimestamp(value.createdAt)
	) {
		throw new Error('저장된 메시지를 읽을 수 없어요.');
	}
	return {
		schemaVersion: 1,
		id: value.id,
		gameId: value.gameId,
		sessionId: value.sessionId,
		sequence: value.sequence,
		role: value.role,
		...(value.kind === undefined ? {} : { kind: value.kind }),
		content: validateMessageContent(value.content),
		createdAt: value.createdAt
	};
}
