import {
	parseReply,
	type StoredRecord,
	type StorageRequest,
	type StorageReply
} from './protocol.js';

export interface ContentPart {
	hash: string;
	value?: unknown;
}
export interface SyncRecord extends Omit<StoredRecord, 'value'> {
	parts: Record<string, ContentPart>;
}
export interface SyncReply {
	version: number;
	records: SyncRecord[];
	games?: StorageReply['games'];
}
export const SYNC_LIMITS = { parts: 10000, bytes: 32 * 1024 * 1024 } as const;
export function syncHash(value: unknown): string {
	if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
		throw Error('Invalid storage content fingerprint');
	}
	return value;
}
export function syncKnown(value: unknown): Set<string> {
	if (!Array.isArray(value) || value.length > SYNC_LIMITS.parts) {
		throw Error('Invalid storage cache');
	}
	return new Set(value.map(syncHash));
}
export function syncAssets(
	value: unknown,
	table: string,
	asset: (data: unknown, mime: string) => unknown
): unknown {
	const row = value as Record<string, unknown>;
	if (table === 'blobs') {
		return row.schemaVersion === 2 ? value : { ...row, data: asset(row.data, String(row.mime)) };
	}
	if (table !== 'games' || !row.resources) {
		return value;
	}
	const resources = Object.fromEntries(
		Object.entries(row.resources as Record<string, Record<string, unknown>>).map(([id, item]) => [
			id,
			{
				...item,
				data:
					typeof item.data === 'string' && item.data.startsWith('helia-asset:')
						? item.data
						: asset(item.data, String(item.mime))
			}
		])
	);
	return { ...row, resources };
}

/** Only game fields change independently; other records are small or immutable. */
export function gamePatch(row: StoredRecord, previous: StoredRecord | undefined): unknown {
	if (row.table !== 'games' || !previous) {
		return row;
	}
	const before = previous.value as Record<string, unknown>;
	const after = row.value as Record<string, unknown>;
	const set = Object.fromEntries(
		Object.entries(after).filter(
			([key, value]) => JSON.stringify(value) !== JSON.stringify(before[key])
		)
	);
	const remove = Object.keys(before).filter((key) => !Object.hasOwn(after, key));
	return {
		table: row.table,
		id: row.id,
		gameId: row.gameId,
		sessionId: row.sessionId,
		patch: { set, remove }
	};
}

/** Bounded, game-scoped content cache. Missing/evicted blocks are requested again. */
export class StorageContentCache {
	private readonly parts = new Map<string, { value: unknown; bytes: number }>();
	private bytes = 0;
	capture(): Map<string, unknown> {
		return new Map([...this.parts].map(([hash, part]) => [hash, part.value]));
	}
	private keep(hash: string, value: unknown) {
		const bytes = JSON.stringify(value).length * 2;
		if (this.parts.has(hash) || bytes > SYNC_LIMITS.bytes) {
			return;
		}
		while (this.parts.size >= SYNC_LIMITS.parts || this.bytes + bytes > SYNC_LIMITS.bytes) {
			const first = this.parts.entries().next().value;
			if (!first) {
				break;
			}
			this.parts.delete(first[0]);
			this.bytes -= first[1].bytes;
		}
		this.parts.set(hash, { value, bytes });
		this.bytes += bytes;
	}
	async decode(
		reply: SyncReply,
		loadAsset: (hash: string) => Promise<string>,
		baseline: Map<string, unknown>,
		play = false
	): Promise<StorageReply> {
		const rows: StoredRecord[] = [];
		for (const row of reply.records) {
			const fields: Record<string, unknown> = {};
			for (const [key, part] of Object.entries(row.parts)) {
				fields[key] = await this.decodePart(part, baseline, async (value) =>
					play ? value : hydrateAssetPart(value, row.table, key, loadAsset)
				);
			}
			rows.push({
				table: row.table,
				id: row.id,
				gameId: row.gameId,
				sessionId: row.sessionId,
				value: row.table === 'games' ? fields : fields.value
			});
		}
		return parseReply({
			version: reply.version,
			records: rows,
			...(reply.games ? { games: reply.games } : {})
		});
	}
	private async decodePart(
		part: { hash: string; value?: unknown },
		baseline: Map<string, unknown>,
		hydrate: (value: unknown) => Promise<unknown>
	) {
		const hash = syncHash(part.hash);
		if (Object.hasOwn(part, 'value')) {
			const value = await hydrate(part.value);
			this.keep(hash, value);
			return value;
		}
		if (!baseline.has(hash)) {
			throw Error('Missing storage content');
		}
		return baseline.get(hash);
	}
}
async function hydrateAssetPart(
	value: unknown,
	table: string,
	key: string,
	load: (hash: string) => Promise<string>
): Promise<unknown> {
	if (table === 'games' && key === 'resources') {
		const entries = await Promise.all(
			Object.entries(value as Record<string, Record<string, unknown>>).map(
				async ([id, resource]) => [
					id,
					{
						...resource,
						data:
							typeof resource.data === 'string' && resource.data.startsWith('helia-asset:')
								? resource.data
								: await load(syncHash((resource.data as { asset: string }).asset))
					}
				]
			)
		);
		return Object.fromEntries(entries);
	}
	if (table === 'blobs') {
		const row = value as Record<string, unknown>;
		if (row.schemaVersion === 2) {
			return value;
		}
		return { ...row, data: await load(syncHash((row.data as { asset: string }).asset)) };
	}
	return value;
}

export function syncRequest(request: StorageRequest, previous: Map<string, StoredRecord>): unknown {
	if (request.kind !== 'commit') {
		return request;
	}
	return {
		...request,
		records: request.records.map((row) => gamePatch(row, previous.get(row.id)))
	};
}
