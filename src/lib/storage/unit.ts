import {
	CONFLICT,
	storedRecord,
	type StorageTransport,
	type StorageView,
	type StoredRecord,
	type Table
} from './protocol.js';

/** Detached working set. Only its changed records enter the short host transaction. */
export class StorageUnit {
	readonly rows: Map<string, StoredRecord>;
	readonly deletedSessions: string[] = [];
	constructor(readonly view: StorageView) {
		this.rows = new Map(view.records.map((row) => [`${row.table}:${row.id}`, row]));
	}
	get(table: Table, id: string): unknown {
		return this.rows.get(`${table}:${id}`)?.value;
	}
	all(table: Table): unknown[] {
		return [...this.rows.values()].filter((row) => row.table === table).map((row) => row.value);
	}
	put(table: Table, value: unknown, sessionId?: string) {
		const row = storedRecord(table, value, sessionId);
		this.rows.set(`${table}:${row.id}`, row);
	}
	deleteSession(id: string) {
		this.deletedSessions.push(id);
		for (const [key, row] of this.rows) if (row.sessionId === id) this.rows.delete(key);
	}
	changes(): StoredRecord[] {
		const before = new Map(
			this.view.records.map((row) => [`${row.table}:${row.id}`, JSON.stringify(row)])
		);
		return [...this.rows.entries()]
			.filter(([key, row]) => before.get(key) !== JSON.stringify(row))
			.map(([, row]) => row);
	}
}

export async function useStorage<T>(
	transport: StorageTransport,
	gameId: string,
	sessionId: string | undefined,
	operation: (unit: StorageUnit) => T
): Promise<T> {
	for (let attempt = 0; attempt < 8; attempt++) {
		const view = await transport({
			kind: 'read',
			gameId,
			...(sessionId === undefined ? {} : { sessionId })
		});
		const unit = new StorageUnit(view);
		const result = operation(unit);
		const records = unit.changes();
		if (!records.length && !unit.deletedSessions.length) return result;
		try {
			await transport({
				kind: 'commit',
				gameId,
				version: view.version,
				records,
				deleteSessions: unit.deletedSessions
			});
			return result;
		} catch (error) {
			if (!(error instanceof Error) || error.message !== CONFLICT) throw error;
		}
	}
	throw new Error('게임 데이터가 변경되었어요. 다시 시도해주세요.');
}
