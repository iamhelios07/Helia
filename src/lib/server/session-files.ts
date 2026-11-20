import type Database from 'better-sqlite3';

import { randomUUID } from 'node:crypto';

import type { FileScope, FileListOptions, StoredFile } from '#lib/games/files/model.js';

import {
	FILE_LIMITS,
	SessionFileError,
	fileScope,
	fileRef,
	fileList,
	fileDetails
} from '#lib/games/files/model.js';
import schema from '#lib/storage/session-files.sql?raw';

class SessionFileStorage {
	constructor(private connection: Database.Database) {
		connection.exec(schema);
	}
	private owner(input: FileScope) {
		const scope = fileScope(input);
		if (
			!this.connection
				.prepare(
					'SELECT s.id FROM sessions s JOIN games g ON g.id=s.game_id WHERE s.id=? AND s.game_id=? AND g.trashed_at IS NULL'
				)
				.get(scope.sessionId, scope.gameId)
		) {
			throw new SessionFileError('FILE_NOT_FOUND');
		}
		return scope;
	}
	stat(input: FileScope, ref: string): StoredFile {
		const scope = this.owner(input);
		const row = this.connection
			.prepare(
				'SELECT ref,name,mime,size,created_at AS createdAt FROM session_files WHERE game_id=? AND session_id=? AND ref=?'
			)
			.get(scope.gameId, scope.sessionId, fileRef(ref)) as StoredFile | undefined;
		if (!row) {
			throw new SessionFileError('FILE_NOT_FOUND');
		}
		return row;
	}
	save(input: FileScope, data: Uint8Array, name: string, mime: string): StoredFile {
		const scope = fileScope(input);
		const details = fileDetails(name, mime, data.byteLength);
		return this.connection
			.transaction(() => {
				this.owner(scope);
				const usage = this.connection
					.prepare(
						'SELECT count(*) AS count,coalesce(sum(size),0) AS bytes FROM session_files WHERE game_id=? AND session_id=?'
					)
					.get(scope.gameId, scope.sessionId) as { count: number; bytes: number };
				if (
					usage.count >= FILE_LIMITS.count ||
					usage.bytes + details.size > FILE_LIMITS.sessionBytes
				) {
					throw new SessionFileError('FILE_QUOTA');
				}
				const file = {
					ref: 'helia-file:' + randomUUID(),
					...details,
					createdAt: new Date().toISOString()
				};
				this.connection
					.prepare(
						'INSERT INTO session_files(ref,game_id,session_id,name,mime,size,created_at,data) VALUES (?,?,?,?,?,?,?,?)'
					)
					.run(
						file.ref,
						scope.gameId,
						scope.sessionId,
						file.name,
						file.mime,
						file.size,
						file.createdAt,
						Buffer.from(data)
					);
				return file;
			})
			.immediate();
	}
	read(input: FileScope, ref: string) {
		const scope = this.owner(input);
		const row = this.connection
			.prepare(
				'SELECT ref,name,mime,size,created_at AS createdAt,data FROM session_files WHERE game_id=? AND session_id=? AND ref=?'
			)
			.get(scope.gameId, scope.sessionId, fileRef(ref)) as
			(StoredFile & { data: Buffer }) | undefined;
		if (!row) {
			throw new SessionFileError('FILE_NOT_FOUND');
		}
		const { data, ...info } = row;
		return { info, data };
	}
	list(input: FileScope, options: FileListOptions = {}) {
		const scope = this.owner(input),
			page = fileList(options);
		const files = this.connection
			.prepare(
				'SELECT ref,name,mime,size,created_at AS createdAt FROM session_files WHERE game_id=? AND session_id=? AND ref>? ORDER BY ref LIMIT ?'
			)
			.all(scope.gameId, scope.sessionId, page.cursor, page.limit + 1) as StoredFile[];
		const more = files.length > page.limit;
		if (more) {
			files.pop();
		}
		return { files, nextCursor: more ? files.at(-1)!.ref : null };
	}
	remove(input: FileScope, ref: string) {
		this.owner(input);
		if (
			!this.connection
				.prepare('DELETE FROM session_files WHERE game_id=? AND session_id=? AND ref=?')
				.run(input.gameId, input.sessionId, fileRef(ref)).changes
		) {
			throw new SessionFileError('FILE_NOT_FOUND');
		}
	}
}
export function sessionFileStorage(connection: Database.Database) {
	return new SessionFileStorage(connection);
}
