import {
	parseGame,
	parseMessage,
	parseSession,
	gameSummary,
	type GameSummary
} from '#lib/games/model.js';
import { MEDIA_MIMES, validateResourceListBudget } from '#lib/games/resources.js';
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
import {
	contentVersion,
	releaseHash,
	parseGameVersioning,
	parseGameRelease,
	parseCreateGameReleaseResult,
	parseReleaseVerification
} from '#lib/games/versioning-validation.js';
import {
	type GameVersioning,
	type GameRelease,
	type CreateGameReleaseResult,
	type GameReleaseOptions,
	type ReleaseVerification
} from '#lib/games/versioning.js';

import {
	parseInstallRequest,
	parseInstallResult,
	parseInstallPreview,
	type InstallRequest,
	type InstallPreviewRequest,
	type InstallResult,
	type InstallPreviewEntry
} from './install.js';

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
export interface GamePatch {
	set: Record<string, unknown>;
	remove: string[];
}
export interface StorageCleanupResult {
	cleanedFiles: number;
	removedBlobs: number;
	queuedObjects: number;
	/** Count each queued object's bytes once, even if several blobs shared it. */
	reclaimableBytes: string;
	skippedEditing: number;
	skippedUnreadable: number;
}
export type StorageRequest =
	| { kind: 'cleanStorage' }
	| { kind: 'editorLease'; gameId: string; leaseId: string; action: 'renew' | 'release' }
	| InstallRequest
	| { kind: 'unlockGame'; gameId: string }
	| InstallPreviewRequest
	| { kind: 'versioning'; gameId: string; action: 'read' }
	| { kind: 'versioning'; gameId: string; action: 'getRelease'; releaseId: string }
	| { kind: 'versioning'; gameId: string; action: 'verifyRelease'; releaseId: string }
	| ({
			kind: 'versioning';
			gameId: string;
			action: 'release';
			contentVersion: string;
	  } & GameReleaseOptions)
	| { kind: 'list'; includeTrashed?: boolean }
	| { kind: 'read'; gameId: string; sessionId?: string; includeHistory?: boolean; play?: boolean }
	| { kind: 'create'; gameId: string; records: StoredRecord[] }
	| { kind: 'prune'; gameId: string; sessionId: string; eventId: string; expectedRevision: number }
	| { kind: 'trash'; gameId: string }
	| { kind: 'restore'; gameId: string }
	| { kind: 'purge'; gameId: string }
	| {
			kind: 'commit';
			gameId: string;
			version: number;
			records: StoredRecord[];
			deleteSessions: string[];
			aiLease?: string;
			gamePatch?: GamePatch;
	  };
export interface StorageReply {
	version: number;
	records: StoredRecord[];
	games?: GameSummary[];
	versioning?: GameVersioning;
	release?: GameRelease;
	releaseResult?: CreateGameReleaseResult;
	releaseVerification?: ReleaseVerification;
	installResult?: InstallResult;
	installPreview?: InstallPreviewEntry[];
	storageCleanup?: StorageCleanupResult;
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
export function parseBlob(value: unknown) {
	const input = record(value);
	if (input.schemaVersion === 2) {
		const id = blobId(input.id);
		const size = counter(input.size);
		if (size === 0) {
			throw new Error('미디어 크기가 올바르지 않아요.');
		}
		const mime = identifier(input.mime);
		if (!MEDIA_MIMES.has(mime)) {
			throw new Error('지원하는 이미지·오디오·비디오 파일을 선택해주세요.');
		}
		return {
			schemaVersion: 2 as const,
			id,
			gameId: identifier(input.gameId),
			mime,
			object: blobId(input.object),
			size
		};
	}
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

function parseRecords(input: unknown, gameId?: string, portable = false): StoredRecord[] {
	if (!Array.isArray(input)) {
		throw new Error('저장 요청의 형식이 올바르지 않아요.');
	}
	return input.map((value: unknown) => {
		const row = record(value);
		if (!tables.includes(row.table as Table)) {
			throw new Error('지원하지 않는 저장 항목이에요.');
		}
		const parsed = storedRecord(row.table as Table, row.value, row.sessionId as string);
		if (portable && parsed.table === 'games') {
			validateResourceListBudget((parsed.value as { resources?: unknown }).resources ?? {});
			assertPortableResources(parsed.value);
		}
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

/** Reads take optional history and session scoping. */
function parseReadRequest(gameId: string, input: Record<string, unknown>): StorageRequest {
	return {
		kind: 'read',
		gameId,
		...(input.includeHistory === true ? { includeHistory: true } : {}),
		...(input.play === true ? { play: true } : {}),
		...(input.sessionId === undefined ? {} : { sessionId: identifier(input.sessionId) })
	};
}

/** Commits carry the version guard, changed records and removed sessions. */
function parseCommitRequest(
	gameId: string,
	input: Record<string, unknown>,
	records: StoredRecord[]
): StorageRequest {
	return {
		kind: 'commit',
		gameId,
		version: counter(input.version),
		records,
		deleteSessions: (input.deleteSessions as string[]).map(identifier),
		...(input.aiLease === undefined ? {} : { aiLease: identifier(input.aiLease) }),
		...(input.gamePatch === undefined ? {} : { gamePatch: parseGamePatch(input.gamePatch) })
	};
}
export function parseGamePatch(value: unknown): GamePatch {
	const row = record(value),
		set = record(row.set);
	if (
		!Array.isArray(row.remove) ||
		row.remove.some((key) => typeof key !== 'string') ||
		Object.keys(set).some((key) => ['__proto__', 'prototype', 'constructor'].includes(key))
	) {
		throw Error('Invalid game patch');
	}
	return { set, remove: row.remove as string[] };
}
export function patchedGame(value: unknown, patch: GamePatch): ReturnType<typeof parseGame> {
	const next = { ...record(value), ...patch.set };
	for (const key of patch.remove) {
		delete next[key];
	}
	const game = parseGame(next);
	validateResourceListBudget(game.resources ?? {});
	assertPortableResources(game);
	return game;
}
function assertPortableResources(value: unknown) {
	const resources = (value as { resources?: Record<string, { data: string }> }).resources;
	// Inline media stays portable until U13; v2 media travels as a game-owned reference.
	if (
		Object.values(resources ?? {}).some(
			(asset) => !asset.data.startsWith('data:') && !/^helia-asset:[a-f0-9]{64}$/.test(asset.data)
		)
	) {
		throw Error('Stored resources must contain portable media');
	}
}

function parseEditorLease(input: Record<string, unknown>): StorageRequest {
	const { action, leaseId } = input;
	if (
		Object.keys(input).length !== 4 ||
		(action !== 'renew' && action !== 'release') ||
		typeof leaseId !== 'string' ||
		!/^[a-f0-9]{32}$/.test(leaseId)
	) {
		throw Error('Invalid editor lease request');
	}
	return { kind: 'editorLease', gameId: identifier(input.gameId), action, leaseId };
}

export function parseRequest(value: unknown): StorageRequest {
	const input = record(value);
	switch (input.kind) {
		case 'install':
		case 'installPreview':
			return parseInstallRequest(input);
		case 'list':
			return { kind: 'list', ...(input.includeTrashed === true ? { includeTrashed: true } : {}) };
		case 'cleanStorage':
			if (Object.keys(input).length !== 1) {
				throw Error('Invalid storage cleanup request');
			}
			return { kind: 'cleanStorage' };
		case 'editorLease':
			return parseEditorLease(input);
	}
	const gameId = identifier(input.gameId);
	switch (input.kind) {
		case 'unlockGame':
			return { kind: 'unlockGame', gameId };
		case 'versioning':
			return parseVersioningRequest(gameId, input);
		case 'trash':
		case 'restore':
		case 'purge':
			return { kind: input.kind, gameId };
		case 'prune':
			return {
				kind: 'prune',
				gameId,
				sessionId: identifier(input.sessionId),
				eventId: identifier(input.eventId),
				expectedRevision: counter(input.expectedRevision)
			};
		case 'read':
			return parseReadRequest(gameId, input);
		case 'create':
			return createRequest(gameId, parseRecords(input.records, gameId, true));
		case 'commit':
			if (Array.isArray(input.deleteSessions)) {
				return parseCommitRequest(gameId, input, parseRecords(input.records, gameId, true));
			}
			break;
	}
	throw new Error('지원하지 않는 저장 요청이에요.');
}

function parseStorageCleanup(value: unknown): StorageCleanupResult {
	const input = record(value);
	if (
		typeof input.reclaimableBytes !== 'string' ||
		!/^(0|[1-9][0-9]{0,38})$/.test(input.reclaimableBytes)
	) {
		throw Error('Invalid storage cleanup result');
	}
	return {
		cleanedFiles: counter(input.cleanedFiles),
		removedBlobs: counter(input.removedBlobs),
		queuedObjects: counter(input.queuedObjects),
		reclaimableBytes: input.reclaimableBytes,
		skippedEditing: counter(input.skippedEditing),
		skippedUnreadable: counter(input.skippedUnreadable)
	};
}

export function parseReply(value: unknown): StorageReply {
	const input = record(value);
	if (input.games !== undefined && !Array.isArray(input.games)) {
		throw Error('Invalid game list');
	}
	return {
		version: counter(input.version),
		records: parseRecords(input.records),
		...(input.storageCleanup === undefined
			? {}
			: { storageCleanup: parseStorageCleanup(input.storageCleanup) }),
		...(input.installResult === undefined
			? {}
			: { installResult: parseInstallResult(input.installResult) }),
		...(input.installPreview === undefined
			? {}
			: { installPreview: parseInstallPreview(input.installPreview) }),
		...(Array.isArray(input.games) ? { games: input.games.map(gameSummary) } : {}),
		...(input.versioning === undefined
			? {}
			: { versioning: parseGameVersioning(input.versioning) }),
		...(input.release === undefined ? {} : { release: parseGameRelease(input.release) }),
		...(input.releaseVerification === undefined
			? {}
			: { releaseVerification: parseReleaseVerification(input.releaseVerification) }),
		...(input.releaseResult === undefined
			? {}
			: { releaseResult: parseCreateGameReleaseResult(input.releaseResult) })
	};
}

function parseVersioningRequest(gameId: string, input: Record<string, unknown>): StorageRequest {
	if (input.action === 'read') {
		return { kind: 'versioning', gameId, action: 'read' };
	}
	if (input.action === 'getRelease' || input.action === 'verifyRelease') {
		return {
			kind: 'versioning',
			gameId,
			action: input.action,
			releaseId: identifier(input.releaseId)
		};
	}
	if (input.action !== 'release' || typeof input.contentVersion !== 'string') {
		throw Error('Invalid release request');
	}
	contentVersion(input.contentVersion);
	if (input.ignoreConflict !== undefined && typeof input.ignoreConflict !== 'boolean') {
		throw Error('Invalid conflict override');
	}
	if (input.ignoreConflict === true && input.expectedContentHash === undefined) {
		throw Error('Conflict override requires expected content hash');
	}
	const expectedContentHash =
		input.expectedContentHash === undefined ? undefined : releaseHash(input.expectedContentHash);
	return {
		kind: 'versioning',
		gameId,
		action: 'release',
		contentVersion: input.contentVersion,
		...(input.ignoreConflict === undefined ? {} : { ignoreConflict: input.ignoreConflict }),
		...(expectedContentHash === undefined ? {} : { expectedContentHash })
	};
}
