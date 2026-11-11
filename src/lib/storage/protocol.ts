import { parseGame, parseMessage, parseSession } from '#lib/games/model.js';
import {
	blobId,
	counter,
	identifier,
	record,
	parseGameSnapshot,
	parseMemory,
	parseSessionState,
	parseSnapshotCheckpoint,
	parseSnapshotResource,
	parseTransaction
} from '#lib/games/state/model.js';

export const tables = [
	'games',
	'sessions',
	'messages',
	'snapshots',
	'progress',
	'transactions',
	'memories',
	'blobs',
	'snapshot_resources',
	'checkpoints'
] as const;
export type Table = (typeof tables)[number];
export interface StoredRecord {
	table: Table;
	id: string;
	gameId: string;
	sessionId: string | null;
	value: unknown;
}
export interface StorageView {
	version: number;
	records: StoredRecord[];
}
export type StorageRequest =
	| { kind: 'list' }
	| { kind: 'read'; gameId: string; sessionId?: string; includeHistory?: boolean }
	| { kind: 'create'; gameId: string; records: StoredRecord[] }
	| { kind: 'prune'; gameId: string; sessionId: string; eventId: string; expectedRevision: number }
	| {
			kind: 'commit';
			gameId: string;
			version: number;
			records: StoredRecord[];
			deleteSessions: string[];
			aiLease?: string;
	  };
export interface StorageReply {
	version: number;
	records: StoredRecord[];
}
export type StorageTransport = (request: StorageRequest) => Promise<StorageReply>;
export const CONFLICT = 'STORAGE_CONFLICT';

function storedSessionId(
	table: Table,
	object: Record<string, unknown>,
	owner: { id: string; ownerSessionId?: string }
): string | null {
	if (
		table === 'games' ||
		table === 'blobs' ||
		table === 'snapshots' ||
		table === 'snapshot_resources'
	) {
		return null;
	}
	if (table === 'sessions') {
		return owner.id;
	}
	return identifier(object.sessionId);
}

/** A stored blob: game-owned immutable bytes keyed by their content fingerprint. */
function parseBlob(value: unknown) {
	const input = record(value);
	if (input.schemaVersion !== 1) {
		throw new Error('지원하지 않는 저장 데이터 버전이에요.');
	}
	return {
		schemaVersion: 1 as const,
		id: blobId(input.id),
		gameId: identifier(input.gameId),
		mime: identifier(input.mime),
		data: identifier(input.data)
	};
}

export function storedRecord(table: Table, value: unknown, ownerSessionId?: string): StoredRecord {
	const parsers = {
		games: parseGame,
		sessions: parseSession,
		messages: parseMessage,
		snapshots: parseGameSnapshot,
		progress: parseSessionState,
		transactions: parseTransaction,
		memories: parseMemory,
		blobs: parseBlob,
		snapshot_resources: parseSnapshotResource,
		checkpoints: parseSnapshotCheckpoint
	};
	const parsed = parsers[table](value);
	const object = record(parsed);
	const id = identifier(table === 'progress' ? object.sessionId : object.id);
	const gameId = table === 'games' ? id : identifier(object.gameId);
	const sessionId = storedSessionId(table, object, { id, ownerSessionId });
	return { table, id, gameId, sessionId, value: parsed };
}

function parseRecords(input: unknown, gameId?: string): StoredRecord[] {
	if (!Array.isArray(input)) {
		throw new Error('저장 요청의 형식이 올바르지 않아요.');
	}
	return input.map((value: unknown) => {
		const row = record(value);
		if (!tables.includes(row.table as Table)) {
			throw new Error('지원하지 않는 저장 항목이에요.');
		}
		const parsed = storedRecord(row.table as Table, row.value, row.sessionId as string);
		if (
			parsed.id !== row.id ||
			parsed.gameId !== row.gameId ||
			parsed.sessionId !== row.sessionId ||
			(gameId !== undefined && parsed.gameId !== gameId)
		) {
			throw new Error('저장 항목의 소유 정보가 일치하지 않아요.');
		}
		return parsed;
	});
}

function createRequest(gameId: string, records: StoredRecord[]): StorageRequest {
	if (
		records.filter((row) => row.table === 'games').length !== 1 ||
		records.filter((row) => row.table === 'sessions').length !== 1 ||
		records.length !== 2
	) {
		throw new Error('새 게임의 구성이 올바르지 않아요.');
	}
	return { kind: 'create', gameId, records };
}

export function parseRequest(value: unknown): StorageRequest {
	const input = record(value);
	if (input.kind === 'list') {
		return { kind: 'list' };
	}
	const gameId = identifier(input.gameId);
	if (input.kind === 'prune') {
		return {
			kind: 'prune',
			gameId,
			sessionId: identifier(input.sessionId),
			eventId: identifier(input.eventId),
			expectedRevision: counter(input.expectedRevision)
		};
	}
	if (input.kind === 'read') {
		return {
			kind: 'read',
			gameId,
			...(input.includeHistory === true ? { includeHistory: true } : {}),
			...(input.sessionId === undefined ? {} : { sessionId: identifier(input.sessionId) })
		};
	}
	const records = parseRecords(input.records, gameId);
	if (input.kind === 'create') {
		return createRequest(gameId, records);
	}
	if (input.kind === 'commit' && Array.isArray(input.deleteSessions)) {
		return {
			kind: 'commit',
			gameId,
			version: counter(input.version),
			records,
			deleteSessions: input.deleteSessions.map(identifier),
			...(input.aiLease === undefined ? {} : { aiLease: identifier(input.aiLease) })
		};
	}
	throw new Error('지원하지 않는 저장 요청이에요.');
}

export function parseReply(value: unknown): StorageReply {
	const input = record(value);
	return { version: counter(input.version), records: parseRecords(input.records) };
}
