import type { GameReleaseContent } from '../versioning.js';

import { parseGame } from '../model.js';
import {
	canonicalReleaseContent,
	gameReleaseContent,
	hashGameReleaseContent
} from '../release-content.js';
import { ResourceListBudgetError } from '../resources.js';
import { releaseHash, validateGameReleaseContent } from '../versioning-validation.js';
import { GamePackageError, packageObject, requirePackage } from './limits.js';
import { packageOriginalGameId, packageTimestamp } from './manifest.js';

export const INSTALL_ONLY_KEYS = [
	'schemaVersion',
	'id',
	'originalGameId',
	'activeSessionId',
	'createdAt',
	'updatedAt',
	'trashedAt',
	'installedFrom',
	'editLock'
] as const;

export interface PackageVerificationIds {
	gameId: string;
	sessionId: string;
	now: string;
}

/** IPC and UTF-8 hashing require Unicode scalar values in both keys and values. */
function validateUnicode(value: unknown): void {
	if (typeof value === 'string') {
		requirePackage(value.isWellFormed(), 'content');
		return;
	}
	if (value && typeof value === 'object') {
		for (const [key, item] of Object.entries(value)) {
			requirePackage(key.isWellFormed(), 'content');
			validateUnicode(item);
		}
	}
}

function rejectPackageReferences(content: unknown): void {
	if (!content || typeof content !== 'object' || !('resources' in content)) {
		return;
	}
	const resources = content.resources;
	if (resources && typeof resources === 'object') {
		requirePackage(
			!Object.values(resources).some(
				(asset: unknown) =>
					asset &&
					typeof asset === 'object' &&
					'data' in asset &&
					typeof asset.data === 'string' &&
					asset.data.startsWith('helia-asset:')
			),
			'missingAsset'
		);
	}
}

/** Shared client/Node boundary. Never execute or compile authored code here. */
export async function verifyReleaseContent(
	release: { originalGameId: string; contentHash: string; content: unknown },
	ids: PackageVerificationIds
): Promise<{ content: GameReleaseContent; contentHash: string }> {
	try {
		rejectPackageReferences(release.content);
		validateGameReleaseContent(release.content);
		validateUnicode(release.content);
		const input = packageObject(release.content);
		requirePackage(!INSTALL_ONLY_KEYS.some((key) => Object.hasOwn(input, key)), 'installOnlyKey');
		const origin = packageOriginalGameId(release.originalGameId);
		releaseHash(release.contentHash);
		packageTimestamp(ids.now);
		const game = parseGame({
			...input,
			scripts: Object.hasOwn(input, 'scripts') ? input.scripts : {},
			schemaVersion: 2,
			id: ids.gameId,
			originalGameId: origin,
			activeSessionId: ids.sessionId,
			createdAt: ids.now,
			updatedAt: ids.now
		});
		const content = gameReleaseContent(game);
		requirePackage(
			canonicalReleaseContent(content) === canonicalReleaseContent(input as GameReleaseContent),
			'nonCanonical'
		);
		const contentHash = await hashGameReleaseContent(content);
		requirePackage(contentHash === release.contentHash, 'integrity');
		return { content, contentHash };
	} catch (error) {
		if (error instanceof ResourceListBudgetError) {
			throw new GamePackageError('limit', error);
		}
		if (error instanceof GamePackageError) {
			throw error;
		}
		throw new GamePackageError('content');
	}
}
