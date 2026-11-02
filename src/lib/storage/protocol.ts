import { parseGame, parseMessage, parseSession } from '#lib/games/model.js';
import {
	counter,
	identifier,
	record,
	parseGameSnapshot,
	parseMemory,
	parseSessionState,
	parseTransaction
} from '#lib/game-runtime/model.js';

export const tables = [
	'games',
	'sessions',
	'messages',
	'snapshots',
	'progress',
	'transactions',
	'memories'
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
	| { kind: 'read'; gameId: string; sessionId?: string }
	| { kind: 'create'; gameId: string; records: StoredRecord[] }
	| {
			kind: 'commit';
			gameId: string;
			version: number;
			records: StoredRecord[];
			deleteSessions: string[];
	  };
export interface StorageReply {
	version: number;
	records: StoredRecord[];
}
export type StorageTransport = (request: StorageRequest) => Promise<StorageReply>;
export const CONFLICT = 'STORAGE_CONFLICT';

export function storedRecord(table: Table, value: unknown, ownerSessionId?: string): StoredRecord {
	const parsers = {
		games: parseGame,
		sessions: parseSession,
		messages: parseMessage,
		snapshots: parseGameSnapshot,
		progress: parseSessionState,
		transactions: parseTransaction,
		memories: parseMemory
	};
	const parsed = parsers[table](value);
	const object = record(parsed);
	const id = identifier(table === 'progress' ? object.sessionId : object.id);
	const gameId = table === 'games' ? id : identifier(object.gameId);
	const sessionId =
		table === 'games'
			? null
			: table === 'sessions'
				? id
				: table === 'snapshots'
					? identifier(ownerSessionId)
					: identifier(object.sessionId);
	return { table, id, gameId, sessionId, value: parsed };
}

function parseRecords(input: unknown, gameId?: string): StoredRecord[] {
	if (!Array.isArray(input)) throw new Error('저장 요청의 형식이 올바르지 않아요.');
	return input.map((value: unknown) => {
		const row = record(value);
		if (!tables.includes(row.table as Table)) throw new Error('지원하지 않는 저장 항목이에요.');
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

export function parseRequest(value: unknown): StorageRequest {
	const input = record(value);
	if (input.kind === 'list') return { kind: 'list' };
	const gameId = identifier(input.gameId);
	if (input.kind === 'read')
		return {
			kind: 'read',
			gameId,
			...(input.sessionId === undefined ? {} : { sessionId: identifier(input.sessionId) })
		};
	const records = parseRecords(input.records, gameId);
	if (input.kind === 'create') {
		if (
			records.filter((row) => row.table === 'games').length !== 1 ||
			records.filter((row) => row.table === 'sessions').length !== 1 ||
			records.length !== 2
		)
			throw new Error('새 게임의 구성이 올바르지 않아요.');
		return { kind: 'create', gameId, records };
	}
	if (input.kind === 'commit' && Array.isArray(input.deleteSessions))
		return {
			kind: 'commit',
			gameId,
			version: counter(input.version),
			records,
			deleteSessions: input.deleteSessions.map(identifier)
		};
	throw new Error('지원하지 않는 저장 요청이에요.');
}

export function parseReply(value: unknown): StorageReply {
	const input = record(value);
	return { version: counter(input.version), records: parseRecords(input.records) };
}
