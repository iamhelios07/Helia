import { createHash } from 'node:crypto';

import { parseResources } from '#lib/games/resources.js';
import { record } from '#lib/games/state/model.js';
import { playValue } from '#lib/storage/play.js';
import { type StorageReply } from '#lib/storage/protocol.js';
import { syncAssets, syncKnown, type SyncRecord, type SyncReply } from '#lib/storage/sync.js';

import type { openStorage } from './sqlite.js';

import { RuntimeContent } from './runtime-content.js';

type Store = ReturnType<typeof openStorage>;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Portable persisted records stay unchanged; only the transport is projected. */
export function storageSync(store: Store, input: unknown): StorageReply | SyncReply {
	const envelope = record(input);
	if (envelope.kind !== 'sync') {
		return store.request(input);
	}
	const known = syncKnown(envelope.known);
	const request = expandGamePatches(store, envelope.request);
	const reply = store.request(request);
	const playing = record(request).kind === 'read' && record(request).play === true;
	const runtime = new RuntimeContent(store.connection);
	const gameId = String(record(request).gameId ?? '');
	const records: SyncRecord[] = reply.records.map(({ value, ...identity }) => {
		const lean = playing
			? playValue(
					identity.table,
					value,
					(kind, data) => runtime.artifact(gameId, kind, data),
					(mime, data) => runtime.asset(gameId, mime, data)
				)
			: syncAssets(value, identity.table, (data) => ({
					asset: runtime.asset(
						identity.gameId,
						String(
							(value as { mime?: string }).mime ??
								(typeof data === 'string' ? data.slice(5, data.indexOf(';')) : '')
						),
						String(data)
					)
				}));
		const fields = identity.table === 'games' ? record(lean) : { value: lean };
		const parts = Object.fromEntries(
			Object.entries(fields).map(([key, value]) => {
				let domain = identity.table === 'blobs' ? 'blob' : 'json';
				if (identity.table === 'games' && key === 'resources') {
					domain = 'game-resources';
				}
				const fingerprint = hash([domain, value]);
				return [key, { hash: fingerprint, ...(known.has(fingerprint) ? {} : { value }) }];
			})
		);
		return { ...identity, parts };
	});
	return { version: reply.version, records, ...(reply.games ? { games: reply.games } : {}) };
}
function expandGamePatches(store: Store, input: unknown): unknown {
	const request = record(input);
	if (request.kind !== 'commit' || !Array.isArray(request.records)) {
		return input;
	}
	const records = request.records.map((value: unknown) => {
		const row = record(value);
		if (row.table !== 'games' || row.patch === undefined) {
			return row;
		}
		if (row.id !== request.gameId || row.gameId !== request.gameId) {
			throw Error('Invalid game patch');
		}
		const saved = store.connection
			.prepare('SELECT value FROM games WHERE id=?')
			.get(row.id as string) as { value: string } | undefined;
		if (!saved) {
			throw Error('Missing game');
		}
		const patch = record(row.patch),
			set = record(patch.set);
		if (!Array.isArray(patch.remove) || patch.remove.some((key) => typeof key !== 'string')) {
			throw Error('Invalid game patch');
		}
		const next = { ...JSON.parse(saved.value), ...set } as Record<string, unknown>;
		for (const key of patch.remove) {
			delete next[key];
		}
		return { ...row, value: next };
	});
	return { ...request, records };
}

/** Resolve immutable media only within its owning installation. */
export function storageAsset(
	store: Store,
	gameId: string,
	fingerprint: string
): { mime: string; data: string } | null {
	const indexed = new RuntimeContent(store.connection).readAsset(gameId, fingerprint);
	if (indexed) {
		return indexed;
	}
	const game = store.connection.prepare('SELECT value FROM games WHERE id=?').get(gameId) as
		{ value: string } | undefined;
	if (!game) {
		return null;
	}
	const resources = parseResources(JSON.parse(game.value).resources ?? {});
	for (const item of Object.values(resources)) {
		if (hash(item.data) === fingerprint) {
			return item;
		}
	}
	const blobs = store.connection.prepare('SELECT value FROM blobs WHERE game_id=?').all(gameId) as {
		value: string;
	}[];
	for (const blob of blobs) {
		const item = JSON.parse(blob.value) as { mime: string; data: string };
		if (hash(item.data) !== fingerprint) {
			continue;
		}
		return parseResources({ asset: { ...item, name: 'asset' } }).asset;
	}
	return null;
}
