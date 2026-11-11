import { sql } from 'drizzle-orm';
import {
	check,
	foreignKey,
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	unique
} from 'drizzle-orm/sqlite-core';

export const games = sqliteTable(
	'games',
	{
		id: text('id').primaryKey(),
		version: integer('version').notNull().default(0),
		value: text('value').notNull()
	},
	(t) => [check('games_json', sql`json_valid(${t.value})`)]
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
