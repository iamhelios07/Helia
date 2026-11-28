import type Database from 'better-sqlite3';

import { randomUUID } from 'node:crypto';

import { requirePackage } from '#lib/games/package/limits.js';

function transientLock(error: unknown): boolean {
	return Boolean(
		error &&
		typeof error === 'object' &&
		'code' in error &&
		['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(String(error.code))
	);
}

/** Renew every pinned object, including objects the digest has not reached yet. */
export class ReleaseReadLeases {
	private ids: string[] = [];
	private renewed = Date.now();

	constructor(private db: Database.Database) {}

	add(gameId: string, objectId: string): void {
		const id = randomUUID();
		this.db
			.prepare("INSERT INTO media_leases VALUES(?,?,?,'read',?)")
			.run(id, gameId, objectId, new Date(this.renewed + 180000).toISOString());
		this.ids.push(id);
	}

	renew(): void {
		const now = Date.now();
		const elapsed = now - this.renewed;
		if (elapsed < 60000) {
			return;
		}
		// Never continue after protection has expired, even if the next write would succeed.
		requirePackage(elapsed < 180000, 'missingAsset');
		try {
			this.db
				.transaction(() => {
					const update = this.db.prepare(
						"UPDATE media_leases SET expires_at=? WHERE id=? AND kind='read' AND expires_at>?"
					);
					for (const id of this.ids) {
						requirePackage(
							update.run(new Date(now + 180000).toISOString(), id, new Date(now).toISOString())
								.changes === 1,
							'missingAsset'
						);
					}
				})
				.immediate();
			this.renewed = now;
		} catch (error) {
			if (!transientLock(error)) {
				throw error;
			}
			// Keep the old timestamp so the next chunk retries a transient lock failure.
		}
	}

	close(): void {
		const remove = this.db.prepare('DELETE FROM media_leases WHERE id=?');
		for (const id of this.ids) {
			try {
				remove.run(id);
			} catch (error) {
				// A busy cleanup may leave the lease to expire; preserve the digest's result.
				if (!transientLock(error)) {
					throw error;
				}
			}
		}
	}
}
