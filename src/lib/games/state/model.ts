import { parseGameSettings, parseScripts, type Game } from '#lib/games/model.js';

import type { GameResources } from '../resources.js';

import { parseGameAIContent } from '../ai/prompts.js';
import { parseCodeProject } from '../code-project.js';
import { parseGameUI } from '../ui/runtime/model.js';
import { parseStateDocument } from './schema.js';
import {
	parseGameState,
	parseStateValue,
	validateStateKey,
	type GameState,
	type StateValue
} from './value.js';

/**
 * The game-content fingerprint shared by every session that plays it. Resources live in the
 * blob store and migration checkpoints in their own table; neither is part of this record.
 */
export interface GameSnapshot extends Pick<
	Game,
	'schema' | 'initialState' | 'scripts' | 'settings' | 'ui' | 'ai' | 'code'
> {
	schemaVersion: 1;
	/** Content-addressed identity: identical authored content across sessions shares one row. */
	id: string;
	gameId: string;
	createdAt: string;
}
/** One migrated historical state, keyed by the transaction it restores. */
export interface SnapshotCheckpoint {
	schemaVersion: 1;
	/** Row identity: the restored transaction's id. */
	id: string;
	transactionId: string;
	snapshotId: string;
	gameId: string;
	sessionId: string;
	state: GameState;
}
/** One stored blob plus the per-snapshot logical path it is exposed under. */
export interface SnapshotResource {
	schemaVersion: 1;
	/** Row identity: the logical path fingerprint inside its snapshot. */
	id: string;
	snapshotId: string;
	gameId: string;
	blobId: string;
	/** Stable creator-facing reference used by asset(); renaming rewrites 
ame only. */
	assetId: string;
	/** Creator-facing asset path; renaming only rewrites this reference. */
	name: string;
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
	/** Migration checkpoints for this snapshot; empty when the schema never changed under it. */
	checkpoints: SnapshotCheckpoint[];
	/** Assets referenced by this snapshot, resolved from the shared blob store. */
	resources: GameResources;
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
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('저장된 게임 진행 데이터의 형식이 올바르지 않아요.');
	}
	return value as Record<string, unknown>;
}
export function identifier(value: unknown): string {
	if (typeof value !== 'string' || !value.trim()) {
		throw new Error('게임 진행 식별자가 올바르지 않아요.');
	}
	return value;
}
export function counter(value: unknown): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		throw new Error('게임 진행 리비전이 올바르지 않아요.');
	}
	return value;
}
function timestamp(value: unknown): string {
	if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
		throw new Error('기록 시간이 올바르지 않아요.');
	}
	return value;
}
function version(value: Record<string, unknown>, supported: readonly number[] = [1]) {
	if (!supported.includes(value.schemaVersion as number)) {
		throw new Error('지원하지 않는 게임 진행 데이터 버전이에요.');
	}
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
		...(input.code === undefined ? {} : { code: parseCodeProject(input.code) }),
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
	if (input.exists === false) {
		return { exists: false };
	}
	if (input.exists !== true) {
		throw new Error('상태 변경 기록이 올바르지 않아요.');
	}
	return { exists: true, value: parseStateValue(input.value) };
}

export function parseTransaction(value: unknown): Transaction {
	const input = record(value);
	version(input, [2]);
	if (!Array.isArray(input.changes)) {
		throw new Error('상태 변경 기록이 올바르지 않아요.');
	}
	const changes = input.changes.map((value: unknown): StateChange => {
		const change = record(value);
		if (!Array.isArray(change.path) || change.path.length === 0) {
			throw new Error('상태 변경 경로가 올바르지 않아요.');
		}
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
	if (!Array.isArray(input.sourceTransactionIds) || input.sourceTransactionIds.length === 0) {
		throw new Error('기억의 근거가 필요해요.');
	}
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

export function parseSnapshotCheckpoint(value: unknown): SnapshotCheckpoint {
	const input = record(value);
	version(input);
	const transactionId = identifier(input.transactionId);
	return {
		schemaVersion: 1,
		id: identifier(input.id ?? transactionId),
		transactionId,
		snapshotId: identifier(input.snapshotId),
		gameId: identifier(input.gameId),
		sessionId: identifier(input.sessionId),
		state: parseGameState(input.state)
	};
}

export function parseSnapshotResource(value: unknown): SnapshotResource {
	const input = record(value);
	version(input);
	return {
		schemaVersion: 1,
		id: identifier(input.id),
		snapshotId: identifier(input.snapshotId),
		gameId: identifier(input.gameId),
		blobId: blobId(input.blobId),
		assetId: identifier(input.assetId),
		name: identifier(input.name)
	};
}
/** Content-addressed blob identity: 64 lowercase hex characters. */
export function blobId(value: unknown): string {
	if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
		throw new Error('리소스 지문이 올바르지 않아요.');
	}
	return value;
}

/** Canonical JSON with sorted object keys; the input of the content fingerprint. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonical).join(',')}]`;
	}
	if (value && typeof value === 'object') {
		const entries = Object.entries(value)
			.filter(([, item]) => item !== undefined)
			.sort(([left], [right]) => (left < right ? -1 : 1));
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
}
/**
 * Deterministic 256-bit fingerprint (four independent 64-bit FNV-1a rounds) of the value.
 * Runs synchronously in web and desktop with identical output; collision odds are
 * negligible at game-content scale, and a collision only costs a shared row, never
 * correctness: sessions verify schema fit when loading.
 */
export function contentHash(value: unknown): string {
	const text = canonical(value);
	let high = 0xcbf29ce484222325n;
	let low = 0x9e3779b97f4a7c15n;
	let third = 0x2545f4914f6cdd1dn;
	let fourth = 0x9e3779b185ebca87n;
	for (let index = 0; index < text.length; index += 1) {
		const byte = BigInt(text.charCodeAt(index));
		high = ((high ^ byte) * 0x100000001b3n) & 0xffffffffffffffffn;
		low = ((low ^ ((byte << 8n) & 0xffn)) * 0x100000001b3n) & 0xffffffffffffffffn;
		third = ((third ^ ((byte << 16n) & 0xffffn)) * 0x100000001b3n) & 0xffffffffffffffffn;
		fourth = ((fourth ^ ((byte << 24n) & 0xffffffn)) * 0x100000001b3n) & 0xffffffffffffffffn;
	}
	return (
		high.toString(16).padStart(16, '0') +
		low.toString(16).padStart(16, '0') +
		third.toString(16).padStart(16, '0') +
		fourth.toString(16).padStart(16, '0')
	);
}
