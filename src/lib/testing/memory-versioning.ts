import type { Game } from '#lib/games/model.js';
import type { GameRelease, GameReleaseSummary, GameVersioning } from '#lib/games/versioning.js';
import type { StorageReply, StorageRequest, StoredRecord } from '#lib/storage/protocol.js';

import { parseGame } from '#lib/games/model.js';
import { gameReleaseContent, hashGameReleaseContent } from '#lib/games/release-content.js';
import { originalGameId } from '#lib/games/versioning.js';
import { CONFLICT, parseReply } from '#lib/storage/protocol.js';

type VersionRequest = Extract<StorageRequest, { kind: 'versioning' }>;
type ReleaseRequest = Extract<VersionRequest, { action: 'release' }>;

function summary(release: GameRelease): GameReleaseSummary {
	const { id, originalGameId, contentVersion, contentHash, createdAt } = release;
	return { id, originalGameId, contentVersion, contentHash, createdAt };
}

/** Browser test counterpart; real persistence and cross-host behavior use SQLite tests. */
export class MemoryVersioning {
	private releases = new Map<string, GameRelease[]>();
	private selected = new Map<string, string>();
	constructor(private rows: () => Iterable<StoredRecord>) {}

	private gameRow(gameId: string): StoredRecord {
		const row = [...this.rows()].find((item) => item.table === 'games' && item.id === gameId);
		if (!row) {
			throw Error('Game not found');
		}
		return row;
	}

	private state(game: Game, contentHash: string): GameVersioning {
		const releases = (this.releases.get(game.id) ?? []).map(summary);
		const currentRelease =
			releases.find((release) => release.id === this.selected.get(game.id)) ?? null;
		return {
			originalGameId: originalGameId(game.originalGameId),
			contentHash,
			currentRelease,
			releases,
			modified: currentRelease !== null && currentRelease.contentHash !== contentHash
		};
	}

	private conflicts(game: Game, version: string, hash: string): string[] {
		const active = [...this.rows()]
			.filter((row) => row.table === 'games')
			.map((row) => parseGame(row.value));
		return [
			...new Set(
				active
					.filter((other) => other.originalGameId === game.originalGameId && !other.trashedAt)
					.flatMap((other) => this.releases.get(other.id) ?? [])
					.filter((release) => release.contentVersion === version && release.contentHash !== hash)
					.map((release) => release.contentHash)
			)
		].sort();
	}

	private finalize(request: ReleaseRequest, game: Game, candidate: GameRelease): StorageReply {
		if (game.trashedAt) {
			throw Error('Cannot release a trashed game');
		}
		if (
			request.expectedContentHash !== undefined &&
			request.expectedContentHash !== candidate.contentHash
		) {
			throw Error(CONFLICT);
		}
		const releases = this.releases.get(game.id) ?? [];
		const existing = releases.find(
			(release) =>
				release.contentVersion === request.contentVersion &&
				release.contentHash === candidate.contentHash
		);
		const existingHashes = this.conflicts(game, request.contentVersion, candidate.contentHash);
		if (!existing && existingHashes.length && !request.ignoreConflict) {
			return {
				version: 0,
				records: [],
				releaseResult: {
					kind: 'conflict',
					contentVersion: request.contentVersion,
					existingHashes,
					incomingHash: candidate.contentHash
				}
			};
		}
		if (!existing && releases.length >= 10000) {
			throw Error('Release limit reached');
		}
		this.releases.set(game.id, existing ? releases : [...releases, candidate]);
		this.selected.set(game.id, existing?.id ?? candidate.id);
		return {
			version: 0,
			records: [],
			releaseResult: { kind: 'released', state: this.state(game, candidate.contentHash) }
		};
	}

	async request(request: VersionRequest, version: number): Promise<StorageReply> {
		const row = this.gameRow(request.gameId);
		if (request.action === 'getRelease') {
			const release = this.releases
				.get(request.gameId)
				?.find((item) => item.id === request.releaseId);
			if (!release) {
				throw Error('Game release not found');
			}
			return parseReply({ version, records: [], release });
		}
		if (request.action === 'verifyRelease') {
			const release = this.releases
				.get(request.gameId)
				?.find((item) => item.id === request.releaseId);
			if (!release) {
				throw Error('Game release not found');
			}
			const contentHash = await hashGameReleaseContent(release.content);
			if (contentHash !== release.contentHash) {
				throw Error('Release integrity check failed');
			}
			return parseReply({ version, records: [], releaseVerification: { contentHash } });
		}
		const game = parseGame(row.value);
		const content = gameReleaseContent(game, (reference) => {
			const blob = [...this.rows()].find(
				(item) =>
					item.table === 'blobs' && item.gameId === game.id && item.id === reference.slice(12)
			);
			if (!blob) {
				throw Error('Missing release media');
			}
			return (blob.value as { data: string }).data;
		});
		const contentHash = await hashGameReleaseContent(content);
		if (this.gameRow(game.id) !== row) {
			throw Error(CONFLICT);
		}
		if (request.action === 'read') {
			return parseReply({ version, records: [], versioning: this.state(game, contentHash) });
		}
		const reply = this.finalize(request, game, {
			id: crypto.randomUUID(),
			originalGameId: originalGameId(game.originalGameId),
			contentVersion: request.contentVersion,
			contentHash,
			createdAt: new Date().toISOString(),
			content
		});
		return parseReply({ ...reply, version });
	}
}
