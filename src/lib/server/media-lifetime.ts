import type Database from 'better-sqlite3';

import type { StorageRequest } from '#lib/storage/protocol.js';

export const deadline = (minutes: number) => new Date(Date.now() + minutes * 60000).toISOString();

/** Each editor/tab owns its own lease; never overwrite a read lease or another game's lease. */
export function updateEditorLease(
	db: Database.Database,
	request: Extract<StorageRequest, { kind: 'editorLease' }>
) {
	const { gameId, action } = request;
	const id = `editor:${request.leaseId}`;
	if (action === 'release') {
		db.prepare("DELETE FROM media_leases WHERE id=? AND game_id=? AND kind='editor'").run(
			id,
			gameId
		);
		return;
	}
	const { changes } = db
		.prepare(
			`INSERT INTO media_leases(id,game_id,object_id,kind,expires_at)
		SELECT ?, id, NULL, 'editor', ? FROM games WHERE id=?
		ON CONFLICT(id) DO UPDATE SET expires_at=excluded.expires_at
		WHERE media_leases.game_id=excluded.game_id AND media_leases.kind='editor' AND media_leases.object_id IS NULL`
		)
		.run(id, deadline(15), gameId);
	if (changes !== 1) {
		throw Error('편집 중인 게임을 보호할 수 없어요.');
	}
}

/** End a session and detach its bytes atomically. Caller holds the write transaction. */
export function endUpload(db: Database.Database, id: string, reason: string, state = 'cancelled') {
	db.prepare(
		`UPDATE media_objects SET state='deleting' WHERE id=(SELECT object_id FROM media_uploads WHERE id=?)`
	).run(id);
	db.prepare(
		`UPDATE media_uploads SET state=?, error=?, object_id=NULL, result=NULL, expires_at=? WHERE id=? AND object_id IS NOT NULL`
	).run(state, reason, deadline(60), id);
	db.prepare("DELETE FROM media_leases WHERE kind='read' AND id=?").run(id);
}

/** Must run after the trash guard, before deleting the games row. */
export function purgeMedia(db: Database.Database, game: string) {
	db.prepare('DELETE FROM media_uploads WHERE scope=? AND object_id IS NULL').run(game);
	// The detached session may belong to an interrupted install with no game_id.
	const unowned = db
		.prepare(
			`SELECT o.id FROM media_objects o JOIN media_uploads u ON u.object_id=o.id WHERE u.scope=? AND o.game_id IS NULL`
		)
		.pluck()
		.all(game);
	db.prepare(
		"UPDATE media_uploads SET state='cancelled', object_id=NULL, result=NULL, error='gameDeleted', expires_at=? WHERE scope=?"
	).run(deadline(60), game);
	db.prepare("UPDATE media_objects SET state='deleting' WHERE game_id=?").run(game);
	for (const object of unowned) {
		db.prepare("UPDATE media_objects SET state='deleting' WHERE id=?").run(object);
	}
	db.prepare("DELETE FROM media_leases WHERE game_id=? AND kind='editor'").run(game);
}

function expireBatch(db: Database.Database, startup: boolean) {
	const now = deadline(0);
	const condition = startup ? 'object_id IS NOT NULL OR expires_at<=?' : 'expires_at<=?';
	const rows = db
		.prepare(`SELECT id,object_id FROM media_uploads WHERE ${condition} LIMIT 100`)
		.all(now) as { id: string; object_id: string | null }[];
	for (const row of rows) {
		if (row.object_id === null) {
			db.prepare('DELETE FROM media_uploads WHERE id=?').run(row.id);
		} else {
			endUpload(db, row.id, startup ? 'restarted' : 'expired');
		}
	}
	return rows.length;
}

/** Selection, lease check and a bounded delete share one short write lock. */
function deleteBatch(db: Database.Database) {
	const object = db
		.prepare(
			`SELECT id FROM media_objects o WHERE state='deleting' AND NOT EXISTS
		(SELECT 1 FROM media_leases WHERE object_id=o.id AND kind='read' AND expires_at>?) LIMIT 1`
		)
		.pluck()
		.get(deadline(0));
	if (!object) {
		return false;
	}
	db.prepare(
		'DELETE FROM media_chunks WHERE rowid IN (SELECT rowid FROM media_chunks WHERE object_id=? LIMIT 32)'
	).run(object);
	db.prepare(
		'DELETE FROM media_objects WHERE id=? AND NOT EXISTS (SELECT 1 FROM media_chunks WHERE object_id=?)'
	).run(object, object);
	return true;
}

export class MediaLifetime {
	private timer: NodeJS.Timeout;
	private pending?: NodeJS.Immediate;
	constructor(private db: Database.Database) {
		this.expire(true);
		db.exec(`UPDATE media_objects SET state='deleting' WHERE state<>'deleting' AND (
			(game_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM games WHERE id=media_objects.game_id)) OR
			(state IN ('staging','verified') AND NOT EXISTS(SELECT 1 FROM media_uploads WHERE object_id=media_objects.id)))`);
		this.wake();
		this.timer = setInterval(
			() =>
				this.background(() => {
					this.expire(false);
					this.wake();
				}),
			60000
		).unref();
	}
	private background(job: () => void) {
		try {
			job();
		} catch {
			/* No partial batches; retry on the next minute tick. */
		}
	}
	expire(startup = false) {
		const batch = this.db.transaction(() => expireBatch(this.db, startup));
		while (batch.immediate() === 100) {
			/* release the transaction between batches */
		}
		this.db.prepare('DELETE FROM media_leases WHERE expires_at<=?').run(deadline(0));
	}
	step() {
		return this.db.transaction(() => deleteBatch(this.db)).immediate();
	}
	wake() {
		this.pending ??= setImmediate(() => {
			this.pending = undefined;
			this.background(() => {
				if (this.step()) {
					this.wake();
				}
			});
		}).unref();
	}
	close() {
		clearInterval(this.timer);
		clearImmediate(this.pending);
	}
}
