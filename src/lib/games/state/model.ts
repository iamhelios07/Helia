import {
	parseGameState,
	parseStateValue,
	validateStateKey,
	type GameState,
	type StateValue
} from './value.js';
import { parseGameSettings, parseScripts, type Game } from '#lib/games/model.js';
import { parseStateDocument } from './schema.js';
import { parseGameUI } from '../ui/runtime/model.js';
import { parseGameAIContent } from '../ai/prompts.js';
import { parseResources } from '../resources.js';

export interface GameSnapshot extends Pick<
	Game,
	'schema' | 'initialState' | 'scripts' | 'settings' | 'ui' | 'ai' | 'resources'
> {
	schemaVersion: 1;
	id: string;
	gameId: string;
	createdAt: string;
	/** Validated restoration checkpoints produced by a content migration; recorded events stay immutable. */
	restoredStates?: Record<string, GameState>;
	migrationFrom?: string;
}

export type StateSlot = { exists: false } | { exists: true; value: StateValue };
export interface StateChange {
	path: string[];
	before: StateSlot;
	after: StateSlot;
}

export interface Action {
	/** Creator-defined action name; independent of its execution mechanism. */
	name: string;
	args: GameState;
}

export interface Transaction {
	schemaVersion: 2;
	id: string;
	gameId: string;
	sessionId: string;
	parentId: string | null;
	createdAt: string;
	createdRevision: number;
	action: Action;
	changes: StateChange[];
	messageId?: string;
	/** Optional creator-authored display summary. */
	description?: string;
}

export interface SessionState {
	schemaVersion: 2;
	sessionId: string;
	gameId: string;
	snapshotId: string;
	headId: string | null;
	/** Monotonic across checkouts as well as commits, to reject stale AI results. */
	revision: number;
	state: GameState;
}

export interface SessionHistory {
	snapshot: GameSnapshot;
	progress: SessionState;
	transactions: Transaction[];
}

export interface Memory {
	schemaVersion: 1;
	id: string;
	gameId: string;
	sessionId: string;
	sourceTransactionIds: string[];
	content: string;
	createdAt: string;
}

export function record(value: unknown): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		throw new Error('저장된 게임 진행 데이터의 형식이 올바르지 않아요.');
	return value as Record<string, unknown>;
}
export function identifier(value: unknown): string {
	if (typeof value !== 'string' || !value.trim())
		throw new Error('게임 진행 식별자가 올바르지 않아요.');
	return value;
}
export function counter(value: unknown): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
		throw new Error('게임 진행 리비전이 올바르지 않아요.');
	return value;
}
function timestamp(value: unknown): string {
	if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
		throw new Error('기록 시간이 올바르지 않아요.');
	return value;
}
function version(value: Record<string, unknown>, supported: readonly number[] = [1]) {
	if (!supported.includes(value.schemaVersion as number))
		throw new Error('지원하지 않는 게임 진행 데이터 버전이에요.');
}

export function parseGameSnapshot(value: unknown): GameSnapshot {
	const input = record(value);
	version(input);
	return {
		schemaVersion: 1,
		id: identifier(input.id),
		gameId: identifier(input.gameId),
		createdAt: timestamp(input.createdAt),
		...parseStateDocument({ schema: input.schema, initialState: input.initialState }),
		scripts: parseScripts(input.scripts),
		...(input.ui === undefined ? {} : { ui: parseGameUI(input.ui) }),
		...(input.ai === undefined ? {} : { ai: parseGameAIContent(input.ai) }),
		...(input.resources === undefined ? {} : { resources: parseResources(input.resources) }),
		...(input.restoredStates === undefined
			? {}
			: {
					restoredStates: Object.fromEntries(
						Object.entries(record(input.restoredStates)).map(([id, state]) => [
							identifier(id),
							parseGameState(state)
						])
					),
					migrationFrom: identifier(input.migrationFrom)
				}),
		settings: parseGameSettings(input.settings)
	};
}

export function parseSessionState(value: unknown): SessionState {
	const input = record(value);
	version(input, [2]);
	return {
		schemaVersion: 2,
		sessionId: identifier(input.sessionId),
		gameId: identifier(input.gameId),
		snapshotId: identifier(input.snapshotId),
		headId: input.headId === null ? null : identifier(input.headId),
		revision: counter(input.revision),
		state: parseGameState(input.state)
	};
}

export function parseAction(value: unknown): Action {
	const input = record(value);
	return { name: identifier(input.name), args: parseGameState(input.args) };
}

function parseSlot(value: unknown): StateSlot {
	const input = record(value);
	if (input.exists === false) return { exists: false };
	if (input.exists !== true) throw new Error('상태 변경 기록이 올바르지 않아요.');
	return { exists: true, value: parseStateValue(input.value) };
}

export function parseTransaction(value: unknown): Transaction {
	const input = record(value);
	version(input, [2]);
	if (!Array.isArray(input.changes)) throw new Error('상태 변경 기록이 올바르지 않아요.');
	const changes = input.changes.map((value: unknown): StateChange => {
		const change = record(value);
		if (!Array.isArray(change.path) || change.path.length === 0)
			throw new Error('상태 변경 경로가 올바르지 않아요.');
		const path = change.path.map((key: unknown) => {
			validateStateKey(key);
			return key;
		});
		return { path, before: parseSlot(change.before), after: parseSlot(change.after) };
	});
	return {
		schemaVersion: 2,
		id: identifier(input.id),
		gameId: identifier(input.gameId),
		sessionId: identifier(input.sessionId),
		parentId: input.parentId === null ? null : identifier(input.parentId),
		createdAt: timestamp(input.createdAt),
		createdRevision: counter(input.createdRevision),
		action: parseAction(input.action),
		changes,
		...(input.messageId === undefined ? {} : { messageId: identifier(input.messageId) }),
		...(input.description === undefined ? {} : { description: identifier(input.description) })
	};
}

export function parseMemory(value: unknown): Memory {
	const input = record(value);
	version(input);
	if (!Array.isArray(input.sourceTransactionIds) || input.sourceTransactionIds.length === 0)
		throw new Error('기억의 근거가 필요해요.');
	return {
		schemaVersion: 1,
		id: identifier(input.id),
		gameId: identifier(input.gameId),
		sessionId: identifier(input.sessionId),
		sourceTransactionIds: [...new Set(input.sourceTransactionIds.map(identifier))],
		content: identifier(input.content),
		createdAt: timestamp(input.createdAt)
	};
}
