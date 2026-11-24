import {
	parseReply,
	type StorageRequest,
	type StorageReply,
	type StorageTransport,
	type StoredRecord
} from './protocol.js';
import { StorageAssets } from './sync-assets.js';
import { StorageContentCache, syncRequest, type SyncReply } from './sync.js';

/** Same synchronization policy over HTTP and private desktop IPC. */
export function synchronizedStorage(
	send: (request: unknown) => Promise<unknown>,
	load: (gameId: string, hash: string) => Promise<string>
): StorageTransport {
	return new StorageSynchronization(send, load).request;
}
class StorageSynchronization {
	private caches = new Map<string, StorageContentCache>();
	private games = new Map<string, StoredRecord>();
	private views = new Map<string, { gameId: string; hashes: Set<string> }>();
	private pending = new Map<string, Promise<StorageReply>>();
	private assets: StorageAssets;
	constructor(
		private send: (request: unknown) => Promise<unknown>,
		load: (gameId: string, hash: string) => Promise<string>
	) {
		this.assets = new StorageAssets(load);
	}
	private forget(gameId: string) {
		this.caches.delete(gameId);
		this.games.delete(gameId);
		this.assets.forget(gameId);
		for (const [key, view] of this.views) {
			if (view.gameId === gameId) {
				this.views.delete(key);
			}
		}
	}
	private cache(gameId: string) {
		let cache = this.caches.get(gameId);
		if (!cache) {
			if (this.caches.size >= 4) {
				this.forget(this.caches.keys().next().value!);
			}
			cache = new StorageContentCache();
			this.caches.set(gameId, cache);
		}
		return cache;
	}
	private remember(request: StorageRequest, reply: StorageReply) {
		const rows = request.kind === 'commit' ? [...reply.records, ...request.records] : reply.records;
		for (const row of rows) {
			if (row.table === 'games') {
				this.games.set(row.id, structuredClone(row));
			}
		}
		if (request.kind === 'purge') {
			this.forget(request.gameId);
		}
	}
	private async execute(request: StorageRequest) {
		const gameId = 'gameId' in request ? request.gameId : '';
		const cache = this.cache(gameId),
			baseline = this.baseline(request, cache);
		const raw = await this.send({
			kind: 'sync',
			request: syncRequest(request, this.games),
			known: [...baseline.keys()]
		});
		const reply = await cache.decode(
			raw as SyncReply,
			(hash) => this.assets.read(gameId, hash),
			baseline,
			request.kind === 'read' && request.play === true
		);
		if (request.kind === 'read') {
			const wire = raw as SyncReply;
			const hashes = new Set(
				wire.records.flatMap((row) => Object.values(row.parts).map((part) => part.hash))
			);
			if (this.views.size >= 16) {
				this.views.delete(this.views.keys().next().value!);
			}
			this.views.set(JSON.stringify(request), { gameId, hashes });
		}
		this.remember(request, reply);
		return reply;
	}
	private baseline(request: StorageRequest, cache: StorageContentCache): Map<string, unknown> {
		if (
			request.kind !== 'read' &&
			request.kind !== 'prune' &&
			request.kind !== 'trash' &&
			request.kind !== 'restore'
		) {
			return new Map();
		}
		const values = cache.capture();
		const view = this.views.get(JSON.stringify(request));
		if (!view) {
			return values;
		}
		return new Map([...values].filter(([hash]) => view.hashes.has(hash)));
	}
	request: StorageTransport = async (request) => {
		if (
			request.kind === 'versioning' ||
			request.kind === 'install' ||
			request.kind === 'installPreview'
		) {
			return parseReply(await this.send(request));
		}
		if (request.kind !== 'read' && request.kind !== 'list') {
			this.pending.clear();
			try {
				return await this.execute(request);
			} finally {
				this.pending.clear();
			}
		}
		const key = JSON.stringify(request);
		let result = this.pending.get(key);
		if (!result) {
			result = this.execute(request);
			this.pending.set(key, result);
			void result
				.finally(() => {
					if (this.pending.get(key) === result) {
						this.pending.delete(key);
					}
				})
				.catch(() => {});
		}
		return structuredClone(await result);
	};
}
