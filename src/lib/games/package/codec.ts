import type { GameReleaseContent } from '../versioning.js';
import type { PackageRelease } from './manifest.js';
import type { ZipEntry } from './zip.js';

import { ResourceListBudgetError } from '../resources.js';
import { validateGameReleaseContent } from '../versioning-validation.js';
import {
	checkContentComplexity,
	checkPackageSize,
	GamePackageError,
	packageObject,
	PACKAGE_LIMITS,
	parsePackageJson,
	requirePackage,
	serializePackageJson,
	sha256
} from './limits.js';
import { decodeManifest, encodeManifest, validatePackageRelease } from './manifest.js';
import { verifyReleaseContent } from './verify.js';
import { decodeZip, encodeZip } from './zip.js';

const referencePrefix = 'helia-package:assets/';

function base64(bytes: Uint8Array): string {
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += 32768) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
	}
	return btoa(binary);
}

async function packageResources(content: GameReleaseContent): Promise<ZipEntry[]> {
	const assets = new Map<string, Uint8Array>();
	for (const resource of Object.values(content.resources ?? {})) {
		const prefix = `data:${resource.mime};base64,`;
		requirePackage(resource.data.startsWith(prefix), 'content');
		const encoded = resource.data.slice(prefix.length);
		// Bound decoded allocation before atob creates a binary string.
		checkPackageSize(
			Math.floor(encoded.length / 4) * 3 -
				(encoded.endsWith('==') ? 2 : Number(encoded.endsWith('='))),
			PACKAGE_LIMITS.asset
		);
		const binary = atob(encoded);
		requirePackage(btoa(binary) === encoded, 'nonCanonical');
		const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
		const hash = await sha256(bytes);
		assets.set(hash, bytes);
		resource.data = referencePrefix + hash;
	}
	return [...assets]
		.sort(([a], [b]) => (a < b ? -1 : Number(a > b)))
		.map(([hash, data]) => ({ name: 'assets/' + hash, data }));
}

/** Input must come from a frozen release, never a live Game or draft. */
export async function encodeGamePackage(
	input: PackageRelease & { content: GameReleaseContent }
): Promise<Uint8Array> {
	try {
		const { originalGameId, contentVersion, contentHash, createdAt } = input;
		const release = validatePackageRelease({
			originalGameId,
			contentVersion,
			contentHash,
			createdAt
		});
		validateGameReleaseContent(input.content);
		const portable = structuredClone(input.content);
		const assets = await packageResources(portable);
		const content = new TextEncoder().encode(serializePackageJson(portable));
		checkPackageSize(content.length, PACKAGE_LIMITS.content);
		const manifest = encodeManifest({
			format: 'helia-game-package',
			formatVersion: 1,
			release,
			content: { size: content.length, sha256: await sha256(content) }
		});
		return encodeZip([
			{ name: 'helia-package.json', data: manifest },
			{ name: 'content.json', data: content },
			...assets
		]);
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

function restoreResources(content: Record<string, unknown>, assets: Map<string, Uint8Array>): void {
	const resources = packageObject(content.resources);
	const used = new Set<string>();
	let bytesTotal = 0n;
	// Preflight expansion before base64 allocation: many references can share a large asset.
	const references = Object.values(resources).map((raw) => {
		const resource = packageObject(raw);
		requirePackage(
			typeof resource.mime === 'string' && typeof resource.data === 'string',
			'content'
		);
		requirePackage(resource.data.startsWith(referencePrefix), 'content');
		const hash = resource.data.slice(referencePrefix.length);
		const bytes = assets.get(hash);
		requirePackage(bytes, 'integrity');
		bytesTotal += BigInt(bytes.length);
		used.add(hash);
		return { resource, bytes };
	});
	requirePackage(used.size === assets.size, 'integrity');
	// Keep the existing inline media budget until v2; metadata has its own list budget.
	requirePackage(bytesTotal <= 3n * 1024n * 1024n, 'content');
	for (const { resource, bytes } of references) {
		resource.data = `data:${String(resource.mime)};base64,${base64(bytes)}`;
	}
}

export async function decodeGamePackage(input: Uint8Array | Blob): Promise<{
	manifest: ReturnType<typeof decodeManifest>;
	content: GameReleaseContent;
}> {
	try {
		checkPackageSize(input instanceof Uint8Array ? input.byteLength : input.size);
		const bytes = input instanceof Uint8Array ? input : new Uint8Array(await input.arrayBuffer());
		const entries = decodeZip(bytes);
		const manifest = decodeManifest(entries[0].data);
		const assets = new Map<string, Uint8Array>();
		for (const entry of entries.slice(2)) {
			const hash = entry.name.slice(7);
			requirePackage((await sha256(entry.data)) === hash, 'integrity');
			assets.set(hash, entry.data);
		}
		const contentBytes = entries[1].data;
		requirePackage(
			contentBytes.length === manifest.content.size &&
				(await sha256(contentBytes)) === manifest.content.sha256,
			'integrity'
		);
		// Reject obviously oversized JSON before parse allocates the tree.
		checkContentComplexity(contentBytes);
		const raw = parsePackageJson(contentBytes);
		validateGameReleaseContent(raw);
		const restored = packageObject(raw);
		restoreResources(restored, assets);
		const verified = await verifyReleaseContent(
			{ ...manifest.release, content: restored },
			{
				gameId: manifest.release.originalGameId,
				sessionId: manifest.release.originalGameId,
				now: manifest.release.createdAt
			}
		);
		return { manifest, content: verified.content };
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
