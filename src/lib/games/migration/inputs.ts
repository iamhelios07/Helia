import type { StorageUnit } from '#lib/storage/unit.js';

import type { BaselineUse, MigrationSource } from '../state/baseline.js';
import type {
	GameSnapshot,
	SessionHistory,
	SessionState,
	SnapshotCheckpoint,
	Transaction
} from '../state/model.js';
import type { GameState } from '../state/value.js';

import { stateAt } from '../state/engine.js';
import { record, identifier } from '../state/model.js';
import { validateState } from '../state/schema.js';
import { MigrationFailure, type FailureLocation } from './failure.js';

export type { MigrationSource, BaselineUse, BaselineSelection } from '../state/baseline.js';
export { NO_BASELINES } from '../state/baseline.js';
export type MigrationOrigin = 'baseline' | 'draft';
export interface MigrationLocation extends FailureLocation {
	sourceSnapshotId: string;
	origin: MigrationOrigin;
}
export interface MigrationState extends MigrationLocation {
	state: GameState;
}
export type StateResolver = (input: MigrationState) => GameState;

/** StorageUnit contains protocol-validated records. Keep their references, never copy all states. */
function snapshotIn(unit: StorageUnit, id: string): GameSnapshot {
	const value = record(unit.get('snapshots', id));
	if (value.id !== id) {
		throw Error('Missing migration snapshot');
	}
	return value as unknown as GameSnapshot;
}
function sessionHistory(
	unit: StorageUnit,
	sessionId: string,
	progress: SessionState
): SessionHistory {
	let snapshot: GameSnapshot;
	try {
		snapshot = snapshotIn(unit, progress.snapshotId);
	} catch {
		throw new MigrationFailure('default', { location: { sessionId, role: 'initial' } });
	}
	return {
		snapshot,
		progress,
		transactions: unit
			.all('transactions')
			.filter((raw) => record(raw).sessionId === sessionId) as Transaction[],
		checkpoints: unit.all('checkpoints').filter((raw) => {
			const row = record(raw);
			return row.sessionId === sessionId && row.snapshotId === snapshot.id;
		}) as SnapshotCheckpoint[],
		resources: {}
	};
}
function restore(
	history: SessionHistory,
	use: BaselineUse,
	location: FailureLocation,
	unit: StorageUnit
): MigrationState {
	const transactionId = location.role === 'initial' ? null : (location.transactionId ?? null);
	const baseline = use.kind === 'use' && (transactionId === null || use.states.has(transactionId));
	const sourceSnapshotId = baseline ? use.header.snapshotId : history.snapshot.id;
	try {
		if (baseline) {
			const snapshot = snapshotIn(unit, sourceSnapshotId);
			if (
				snapshot.gameId !== history.progress.gameId ||
				use.header.sessionId !== location.sessionId
			) {
				throw Error('Invalid baseline owner');
			}
			const value = transactionId === null ? snapshot.initialState : use.states.get(transactionId);
			return {
				...location,
				sourceSnapshotId,
				origin: 'baseline',
				state: validateState(snapshot.schema, value, 'load')
			};
		}
		return {
			...location,
			sourceSnapshotId,
			origin: use.kind === 'capture' ? 'baseline' : 'draft',
			state: stateAt(history, transactionId)
		};
	} catch {
		throw new MigrationFailure('default', { location });
	}
}
/** Reads each session before its first yielded input. Consumers may then replace its rows. */
export function* migrationStates(source: MigrationSource): Iterable<MigrationState> {
	const { unit, baselines } = source;
	const ids = unit
		.all('sessions')
		.map((raw) => identifier(record(raw).id))
		.sort();
	for (const sessionId of ids) {
		const saved = unit.get('progress', sessionId);
		if (saved === undefined) {
			continue;
		}
		const progress = saved as SessionState;
		const history = sessionHistory(unit, sessionId, progress);
		const use = baselines.get(sessionId) ?? { kind: 'none' };
		yield restore(history, use, { sessionId, role: 'initial' }, unit);
		for (const node of history.transactions) {
			yield restore(history, use, { sessionId, role: 'checkpoint', transactionId: node.id }, unit);
		}
		yield restore(
			history,
			use,
			{
				sessionId,
				role: 'current',
				...(progress.headId === null ? {} : { transactionId: progress.headId })
			},
			unit
		);
	}
}
