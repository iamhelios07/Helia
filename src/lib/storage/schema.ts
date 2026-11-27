import { sql } from 'drizzle-orm';
import {
	check,
	blob,
	foreignKey,
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	unique,
	uniqueIndex
} from 'drizzle-orm/sqlite-core';

export const games = sqliteTable(
	'games',
	{
		id: text('id').primaryKey(),
		version: integer('version').notNull().default(0),
		/** Set when the user moves the game to the Trash; null while active. */
		trashedAt: text('trashed_at'),
		value: text('value').notNull()
	},
	(t) => [check('games_json', sql`json_valid(${t.value})`)]
);

/** Frozen portable content is fetched explicitly; ordinary game reads never load releases. */
export const gameReleases = sqliteTable(
	'game_releases',
	{
		id: text('id').primaryKey(),
		gameId: text('game_id')
			.notNull()
			.references(() => games.id, { onDelete: 'cascade' }),
		originalGameId: text('original_game_id').notNull(),
		contentVersion: text('content_version').notNull(),
		contentHash: text('content_hash').notNull(),
		createdAt: text('created_at').notNull(),
		content: text('content').notNull()
	},
	(t) => [
		unique().on(t.gameId, t.id),
		unique().on(t.gameId, t.contentVersion, t.contentHash),
		index('game_releases_identity').on(t.originalGameId, t.contentVersion),
		index('game_releases_owner').on(t.gameId),
		check('game_releases_json', sql`json_valid(${t.content})`)
	]
);

export const gameReleaseSelection = sqliteTable(
	'game_release_selection',
	{
		gameId: text('game_id')
			.primaryKey()
			.references(() => games.id, { onDelete: 'cascade' }),
		releaseId: text('release_id').notNull()
	},
	(t) => [
		foreignKey({
			columns: [t.gameId, t.releaseId],
			foreignColumns: [gameReleases.gameId, gameReleases.id]
		})
	]
);

export const sessions = sqliteTable(
	'sessions',
	{
		id: text('id').primaryKey(),
		gameId: text('game_id')
			.notNull()
			.references(() => games.id, { onDelete: 'cascade' }),
		value: text('value').notNull()
	},
	(t) => [
		unique().on(t.id, t.gameId),
		index('sessions_game').on(t.gameId),
		check('sessions_json', sql`json_valid(${t.value})`)
	]
);

/** Runtime files are session-owned and independent of state history and content snapshots. */
export const sessionFiles = sqliteTable(
	'session_files',
	{
		ref: text('ref').primaryKey(),
		gameId: text('game_id').notNull(),
		sessionId: text('session_id').notNull(),
		name: text('name').notNull(),
		mime: text('mime').notNull(),
		size: integer('size').notNull(),
		createdAt: text('created_at').notNull(),
		data: blob('data', { mode: 'buffer' }).notNull()
	},
	(table) => [
		foreignKey({
			columns: [table.sessionId, table.gameId],
			foreignColumns: [sessions.id, sessions.gameId]
		}).onDelete('cascade'),
		index('session_files_owner').on(table.gameId, table.sessionId, table.ref),
		check('session_files_size', sql`${table.size} >= 0`)
	]
);

function childColumns() {
	return {
		id: text('id').primaryKey(),
		gameId: text('game_id').notNull(),
		sessionId: text('session_id').notNull(),
		value: text('value').notNull()
	};
}

export const messages = sqliteTable(
	'messages',
	{
		...childColumns(),
		sequence: integer('sequence').notNull()
	},
	(t) => [
		foreignKey({
			columns: [t.sessionId, t.gameId],
			foreignColumns: [sessions.id, sessions.gameId]
		}).onDelete('cascade'),
		unique().on(t.sessionId, t.sequence),
		index('messages_owner').on(t.gameId, t.sessionId),
		check('messages_json', sql`json_valid(${t.value})`)
	]
);

export const snapshots = sqliteTable(
	'snapshots',
	{
		id: text('id').notNull(),
		gameId: text('game_id')
			.notNull()
			.references(() => games.id, { onDelete: 'cascade' }),
		value: text('value').notNull()
	},
	(t) => [
		primaryKey({ columns: [t.id, t.gameId] }),
		index('snapshots_owner').on(t.gameId),
		check('snapshots_json', sql`json_valid(${t.value})`)
	]
);

/** Content-addressed bytes: game-owned, deduplicated by fingerprint. */
export const blobs = sqliteTable(
	'blobs',
	{
		id: text('id').primaryKey(),
		gameId: text('game_id')
			.notNull()
			.references(() => games.id, { onDelete: 'cascade' }),
		value: text('value').notNull()
	},
	(t) => [index('blobs_owner').on(t.gameId), check('blobs_json', sql`json_valid(${t.value})`)]
);

/** Byte objects outlive game metadata until the incremental deletion queue reclaims them. */
export const mediaObjects = sqliteTable(
	'media_objects',
	{
		id: text('id').primaryKey(),
		gameId: text('game_id'),
		state: text('state').notNull(),
		size: integer('size').notNull(),
		chunkSize: integer('chunk_size').notNull(),
		sha256: text('sha256'),
		crc32: integer('crc32'),
		createdAt: text('created_at').notNull()
	},
	(t) => [
		uniqueIndex('media_objects_ready')
			.on(t.gameId, t.sha256)
			.where(sql`${t.state} = 'ready'`),
		index('media_objects_state').on(t.state),
		index('media_objects_game').on(t.gameId, t.state),
		check(
			'media_objects_state_check',
			sql`${t.state} IN ('staging','verified','ready','deleting')`
		),
		check('media_objects_size', sql`${t.size} > 0`),
		check('media_objects_chunk_size', sql`${t.chunkSize} > 0`),
		check(
			'media_objects_ready_check',
			sql`${t.state} <> 'ready' OR (${t.gameId} IS NOT NULL AND ${t.sha256} IS NOT NULL)`
		)
	]
);

export const mediaChunks = sqliteTable(
	'media_chunks',
	{
		objectId: text('object_id')
			.notNull()
			.references(() => mediaObjects.id),
		idx: integer('idx').notNull(),
		sha256: text('sha256').notNull(),
		data: blob('data', { mode: 'buffer' }).notNull()
	},
	(t) => [
		primaryKey({ columns: [t.objectId, t.idx] }),
		check('media_chunks_idx', sql`${t.idx} >= 0`)
	]
);

export const mediaUploads = sqliteTable(
	'media_uploads',
	{
		id: text('id').primaryKey(),
		scope: text('scope').notNull(),
		purpose: text('purpose').notNull(),
		mime: text('mime').notNull(),
		label: text('label'),
		operation: text('operation'),
		size: integer('size').notNull(),
		chunkSize: integer('chunk_size').notNull(),
		chunkCount: integer('chunk_count').notNull(),
		objectId: text('object_id').references(() => mediaObjects.id),
		state: text('state').notNull(),
		generation: integer('generation').notNull().default(0),
		declaredSha256: text('declared_sha256'),
		result: text('result'),
		error: text('error'),
		createdAt: text('created_at').notNull(),
		expiresAt: text('expires_at').notNull()
	},
	(t) => [
		index('media_uploads_scope').on(t.scope, t.state),
		index('media_uploads_expiry').on(t.expiresAt),
		check(
			'media_uploads_purpose',
			sql`${t.purpose} IN ('edit','install','package-content','document')`
		),
		check('media_uploads_operation', sql`${t.operation} IN ('draftSave','commit','releaseCreate')`),
		check(
			'media_uploads_state',
			sql`${t.state} IN ('receiving','finishing','completed','verified','consumed','failed','cancelled')`
		),
		check(
			'media_uploads_object',
			sql`(${t.state} IN ('receiving','finishing','verified')) = (${t.objectId} IS NOT NULL)`
		)
	]
);

export const mediaLeases = sqliteTable(
	'media_leases',
	{
		id: text('id').primaryKey(),
		gameId: text('game_id').notNull(),
		objectId: text('object_id'),
		kind: text('kind').notNull(),
		expiresAt: text('expires_at').notNull()
	},
	(t) => [check('media_leases_kind', sql`${t.kind} IN ('editor','read')`)]
);

/** Per-snapshot logical asset paths pointing into the shared blob store. */
export const snapshotResources = sqliteTable(
	'snapshot_resources',
	{
		id: text('id').primaryKey(),
		gameId: text('game_id')
			.notNull()
			.references(() => games.id, { onDelete: 'cascade' }),
		snapshotId: text('snapshot_id').notNull(),
		value: text('value').notNull()
	},
	(t) => [
		unique().on(t.id, t.gameId, t.snapshotId),
		index('snapshot_resources_snapshot').on(t.gameId, t.snapshotId),
		check('snapshot_resources_json', sql`json_valid(${t.value})`)
	]
);

/** Migration checkpoints keyed by the transaction they restore. */
export const checkpoints = sqliteTable(
	'checkpoints',
	{
		...childColumns(),
		snapshotId: text('snapshot_id').notNull()
	},
	(t) => [
		foreignKey({
			columns: [t.sessionId, t.gameId],
			foreignColumns: [sessions.id, sessions.gameId]
		}).onDelete('cascade'),
		unique().on(t.id, t.gameId, t.sessionId),
		index('checkpoints_snapshot').on(t.gameId, t.snapshotId),
		check('checkpoints_json', sql`json_valid(${t.value})`)
	]
);

export const progress = sqliteTable(
	'progress',
	{
		...childColumns(),
		snapshotId: text('snapshot_id').notNull()
	},
	(t) => [
		foreignKey({
			columns: [t.snapshotId, t.gameId],
			foreignColumns: [snapshots.id, snapshots.gameId]
		}),
		foreignKey({
			columns: [t.sessionId, t.gameId],
			foreignColumns: [sessions.id, sessions.gameId]
		}).onDelete('cascade'),
		index('progress_owner').on(t.gameId, t.sessionId),
		check('progress_json', sql`json_valid(${t.value})`)
	]
);

export const transactions = sqliteTable('transactions', childColumns(), (t) => [
	foreignKey({
		columns: [t.sessionId, t.gameId],
		foreignColumns: [sessions.id, sessions.gameId]
	}).onDelete('cascade'),
	index('transactions_owner').on(t.gameId, t.sessionId),
	check('transactions_json', sql`json_valid(${t.value})`)
]);

export const memories = sqliteTable('memories', childColumns(), (t) => [
	foreignKey({
		columns: [t.sessionId, t.gameId],
		foreignColumns: [sessions.id, sessions.gameId]
	}).onDelete('cascade'),
	index('memories_owner').on(t.gameId, t.sessionId),
	check('memories_json', sql`json_valid(${t.value})`)
]);
