import type { StorageUnit } from '#lib/storage/unit.js';

import { parseSemVer } from '../semver.js';
import { identifier, record } from './model.js';
import { parseGameState, type GameState } from './value.js';

export interface BaselineEpoch {
	schemaVersion: 1;
	id: string;
	gameId: string;
	epochId: string;
	releaseId: string;
	openedAt: string;
}
export interface BaselineHeader {
	schemaVersion: 1;
	id: string;
	gameId: string;
	sessionId: string;
	epochId: string;
	releaseId: string;
	fromVersion: string;
	snapshotId: string;
	capturedAt: string;
}
export interface BaselineState {
	schemaVersion: 1;
	id: string;
	gameId: string;
	sessionId: string;
	transactionId: string;
	epochId: string;
	state: GameState;
}
export type BaselineUse =
	| { kind: 'none' }
	| { kind: 'capture' }
	| { kind: 'use'; header: BaselineHeader; states: ReadonlyMap<string, GameState> };
export type BaselineSelection = ReadonlyMap<string, BaselineUse>;
export interface MigrationSource {
	readonly unit: StorageUnit;
	readonly baselines: BaselineSelection;
}
export const NO_BASELINES: BaselineSelection = new Map();

function base(value: unknown) {
	const input = record(value);
	if (input.schemaVersion !== 1) {
		throw Error('지원하지 않는 기준본 버전이에요.');
	}
	return {
		input,
		common: {
			schemaVersion: 1 as const,
			id: identifier(input.id),
			gameId: identifier(input.gameId),
			epochId: identifier(input.epochId)
		}
	};
}
function time(value: unknown): string {
	if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
		throw Error('기준본 시간이 올바르지 않아요.');
	}
	return value;
}
function assertIdentity(id: string, owner: string) {
	if (id !== owner) {
		throw Error('기준본 식별자가 일치하지 않아요.');
	}
}
export function parseBaselineEpoch(value: unknown): BaselineEpoch {
	const { input, common } = base(value);
	assertIdentity(common.id, common.gameId);
	return { ...common, releaseId: identifier(input.releaseId), openedAt: time(input.openedAt) };
}
export function parseBaselineHeader(value: unknown): BaselineHeader {
	const { input, common } = base(value);
	const sessionId = identifier(input.sessionId);
	assertIdentity(common.id, sessionId);
	const fromVersion = identifier(input.fromVersion);
	parseSemVer(fromVersion);
	return {
		...common,
		sessionId,
		releaseId: identifier(input.releaseId),
		fromVersion,
		snapshotId: identifier(input.snapshotId),
		capturedAt: time(input.capturedAt)
	};
}
export function parseBaselineState(value: unknown): BaselineState {
	const { input, common } = base(value);
	const transactionId = identifier(input.transactionId);
	assertIdentity(common.id, transactionId);
	return {
		...common,
		sessionId: identifier(input.sessionId),
		transactionId,
		state: parseGameState(input.state)
	};
}
