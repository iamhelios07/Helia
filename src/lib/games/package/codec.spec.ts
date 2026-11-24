import { expect, it, vi } from 'vitest';

import releaseFixtures from '#lib/testing/fixtures/game-releases.json';

import type { GameReleaseContent } from '../versioning.js';

import { parseGame } from '../model.js';
import { gameReleaseContent, hashGameReleaseContent } from '../release-content.js';
import { decodeGamePackage, encodeGamePackage } from './codec.js';
import cases from './fixtures/content-cases.json';
import golden from './fixtures/minimal-package.json';
import minimal from './fixtures/minimal-release.json';
import {
	CONTENT_CHARACTER_LIMIT,
	CONTENT_NODE_LIMIT,
	PACKAGE_LIMITS,
	serializePackageJson,
	sha256
} from './limits.js';
import { decodeManifest, encodeManifest } from './manifest.js';
import { decodeZip, encodeZip, type ZipEntry } from './zip.js';

const release = () => structuredClone(minimal) as typeof minimal & { content: GameReleaseContent };
const text = (value: unknown) => new TextEncoder().encode(serializePackageJson(value));

async function changeContent(entries: ZipEntry[], content: unknown): Promise<Uint8Array> {
	const manifest = decodeManifest(entries[0].data);
	entries[1].data = text(content);
	manifest.content = { size: entries[1].data.length, sha256: await sha256(entries[1].data) };
	entries[0].data = encodeManifest(manifest);
	return encodeZip(entries);
}

it('matches independently generated fixed ZIP bytes and round trips', async () => {
	const bytes = await encodeGamePackage(release());
	expect(btoa(String.fromCharCode(...bytes))).toBe(golden.base64);
	expect(await sha256(bytes)).toBe(golden.sha256);
	const decoded = await decodeGamePackage(bytes);
	expect(decoded.content).toEqual(minimal.content);
	expect(
		await encodeGamePackage({ ...decoded.manifest.release, content: decoded.content })
	).toEqual(bytes);
	expect(await decodeGamePackage(new Blob([new Uint8Array(bytes)]))).toEqual(decoded);
});

it.each(cases.filter((row) => row.expect.accepted))(
	'round trips shared valid content: $name',
	async ({ request }) => {
		const input = request.release as typeof minimal & { content: GameReleaseContent };
		const original = structuredClone(input);
		const bytes = await encodeGamePackage(input);
		expect((await decodeGamePackage(bytes)).content).toEqual(input.content);
		expect(input).toEqual(original);
	}
);

it('is deterministic under nested key and resource insertion order changes', async () => {
	const shared = cases.find((row) => row.name === 'shared assets')!.request.release;
	const first = shared as typeof minimal & { content: GameReleaseContent };
	const second = structuredClone(first);
	second.content.resources = Object.fromEntries(
		Object.entries(second.content.resources!).reverse()
	);
	second.content.settings = {
		authorNote: first.content.settings.authorNote,
		firstMessage: first.content.settings.firstMessage,
		description: first.content.settings.description
	};
	expect(await encodeGamePackage(first)).toEqual(await encodeGamePackage(second));
	expect(await encodeGamePackage({ ...first, createdAt: '2026-11-24T00:00:00.000Z' })).not.toEqual(
		await encodeGamePackage(first)
	);
});

it('stores only one asset when multiple resource IDs share bytes', async () => {
	const input = cases.find((row) => row.name === 'shared assets')!.request.release;
	const bytes = await encodeGamePackage(input as typeof minimal & { content: GameReleaseContent });
	const assets = decodeZip(bytes).slice(2);
	const unique = new Set(Object.values(input.content.resources).map((resource) => resource.data));
	expect(assets).toHaveLength(unique.size);
	expect((await decodeGamePackage(bytes)).content.resources).toEqual(input.content.resources);
});

it('rejects missing, unreferenced and tampered assets even when CRCs are correct', async () => {
	const input = cases.find((row) => row.name === 'shared assets')!.request.release;
	const bytes = await encodeGamePackage(input as typeof minimal & { content: GameReleaseContent });
	const entries = decodeZip(bytes);
	await expect(decodeGamePackage(encodeZip(entries.slice(0, 2)))).rejects.toMatchObject({
		code: 'integrity'
	});
	const extraHash = await sha256(new Uint8Array([33]));
	const extra = [
		...entries.slice(2),
		{ name: 'assets/' + extraHash, data: new Uint8Array([33]) }
	].sort((a, b) => a.name.localeCompare(b.name));
	await expect(
		decodeGamePackage(encodeZip([...entries.slice(0, 2), ...extra]))
	).rejects.toMatchObject({ code: 'integrity' });
	entries[2].data = new Uint8Array([5]);
	await expect(decodeGamePackage(encodeZip(entries))).rejects.toMatchObject({ code: 'integrity' });
});

it('requires exact package references instead of data URIs or near-matching paths', async () => {
	const input = cases.find((row) => row.name === 'shared assets')!.request.release;
	for (const data of [
		'data:image/png;base64,AA==',
		'helia-package:assets/' + 'a'.repeat(64) + '\n',
		'helia-package:assets/../escape'
	]) {
		const entries = decodeZip(
			await encodeGamePackage(input as typeof minimal & { content: GameReleaseContent })
		);
		const content = JSON.parse(new TextDecoder().decode(entries[1].data));
		Object.values(content.resources as Record<string, { data: string }>)[0].data = data;
		await expect(decodeGamePackage(await changeContent(entries, content))).rejects.toThrow();
	}
});

it('checks content SHA, declared size and release hash independently of ZIP CRC', async () => {
	for (const field of ['sha256', 'size', 'releaseHash']) {
		const entries = decodeZip(await encodeGamePackage(release()));
		const manifest = decodeManifest(entries[0].data);
		if (field === 'releaseHash') {
			manifest.release.contentHash = '0'.repeat(64);
		} else if (field === 'size') {
			manifest.content.size++;
		} else {
			manifest.content.sha256 = '0'.repeat(64);
		}
		entries[0].data = encodeManifest(manifest);
		await expect(decodeGamePackage(encodeZip(entries))).rejects.toMatchObject({
			code: 'integrity'
		});
	}
});

it('self-validation rejects noncanonical exported content with an otherwise valid digest', async () => {
	const input = release();
	input.content.title = ' Adventure ';
	input.contentHash = await hashGameReleaseContent(input.content);
	await expect(decodeGamePackage(await encodeGamePackage(input))).rejects.toMatchObject({
		code: 'nonCanonical'
	});
});

it('rejects raw complex content before replacing resources or normalizing away unknown keys', async () => {
	const entries = decodeZip(await encodeGamePackage(release()));
	const bad = { ...minimal.content, unknown: Array.from({ length: 100000 }, () => null) };
	await expect(decodeGamePackage(await changeContent(entries, bad))).rejects.toMatchObject({
		code: 'content'
	});
});

it('rejects oversized JSON structure before JSON.parse builds a tree', async () => {
	const entries = decodeZip(await encodeGamePackage(release()));
	const overflow = 2 * CONTENT_NODE_LIMIT + 1;
	// A comma-dense array is valid JSON but would allocate millions of nodes if parsed.
	const bad = new TextEncoder().encode(
		'{"unknown":[' + 'null,'.repeat(overflow - 1) + 'null],"title":"Adventure"}'
	);
	entries[1].data = bad;
	const manifest = decodeManifest(entries[0].data);
	manifest.content = { size: bad.length, sha256: await sha256(bad) };
	entries[0].data = encodeManifest(manifest);
	const parse = vi.spyOn(JSON, 'parse');
	await expect(decodeGamePackage(encodeZip(entries))).rejects.toMatchObject({ code: 'content' });
	// Only the small manifest is parsed; the oversized content.json never reaches JSON.parse.
	expect(parse).toHaveBeenCalledTimes(1);
	expect(parse.mock.calls[0][0]).not.toContain('null,');
	parse.mockRestore();
});

it('bounds shared asset expansion before allocating restored data URIs', async () => {
	const bytes = new Uint8Array(PACKAGE_LIMITS.asset);
	const hash = await sha256(bytes);
	const resources = Object.fromEntries(
		Array.from({ length: 100 }, (_, index) => [
			String(index),
			{
				name: `${index}.png`,
				mime: 'image/png',
				data: 'helia-package:assets/' + hash
			}
		])
	);
	const entries = decodeZip(await encodeGamePackage(release()));
	entries.push({ name: 'assets/' + hash, data: bytes });
	await expect(
		decodeGamePackage(await changeContent(entries, { ...minimal.content, resources }))
	).rejects.toMatchObject({ code: 'content' });
});

function countedCharacters(value: unknown): number {
	const pending = [value];
	let total = 0;
	while (pending.length) {
		const item = pending.pop();
		if (typeof item === 'string') {
			total += item.length;
		} else if (item && typeof item === 'object') {
			pending.push(...Object.values(item));
		}
	}
	return total;
}

it('matches the versioning-validation character budget across reference expansion', async () => {
	// A 1 MiB asset expands to ~1.4 M characters, so the filler text keeps the stored
	// content.json under 16 MiB while the restored content lands exactly on the shared
	// 16 Mi UTF-16 budget.
	const bytes = new Uint8Array(PACKAGE_LIMITS.asset);
	const hash = await sha256(bytes);
	const reference = 'helia-package:assets/' + hash;
	const content = structuredClone(minimal.content) as typeof minimal.content & {
		resources: Record<string, { name: string; mime: string; data: string }>;
	};
	content.resources = { portrait: { name: 'portrait.png', mime: 'image/png', data: reference } };
	const delta =
		4 * Math.ceil(bytes.length / 3) + 'data:image/png;base64,'.length - reference.length;
	const room = CONTENT_CHARACTER_LIMIT - countedCharacters(content) - delta;
	expect(room).toBeGreaterThan(0);
	content.settings.firstMessage = 'x'.repeat(content.settings.firstMessage.length + room);
	expect(countedCharacters(content) + delta).toBe(CONTENT_CHARACTER_LIMIT);
	// An installation key keeps the accepted case cheap: verification reports it right
	// after the character budget, without canonicalizing the restored 16 Mi characters.
	(content as Record<string, unknown>).id = null;
	const archive = async () => {
		const entries = decodeZip(await encodeGamePackage(release()));
		entries.push({ name: 'assets/' + hash, data: bytes });
		return entries;
	};
	// Exactly at the budget the content is accepted and the installation key is reported.
	await expect(
		decodeGamePackage(await changeContent(await archive(), content))
	).rejects.toMatchObject({ code: 'installOnlyKey' });
	content.settings.firstMessage += 'x';
	await expect(
		decodeGamePackage(await changeContent(await archive(), content))
	).rejects.toMatchObject({ code: 'content' });
});

it('rejects malformed UTF-8 content after an otherwise valid byte digest', async () => {
	const entries = decodeZip(await encodeGamePackage(release()));
	entries[1].data = new Uint8Array([0x22, 0xff, 0x22]);
	const manifest = decodeManifest(entries[0].data);
	manifest.content = { size: 3, sha256: await sha256(entries[1].data) };
	entries[0].data = encodeManifest(manifest);
	await expect(decodeGamePackage(encodeZip(entries))).rejects.toMatchObject({ code: 'format' });
});

it.each(['\0', '한', '🌌'])(
	'checks actual UTF-8 content size before ZIP allocation: %j',
	async (character) => {
		const input = release();
		input.content.settings.description = character.repeat(6 * 1024 * 1024);
		await expect(encodeGamePackage(input)).rejects.toMatchObject({ code: 'limit' });
	}
);

it('counts long object keys toward the encoded size', async () => {
	const input = release();
	Object.assign(input.content, { ['x'.repeat(PACKAGE_LIMITS.content)]: null });
	await expect(encodeGamePackage(input)).rejects.toMatchObject({ code: 'limit' });
});

it('checks File size before reading its bytes', async () => {
	const file = new Blob([]);
	Object.defineProperty(file, 'size', { value: PACKAGE_LIMITS.file + 1 });
	const read = vi.spyOn(file, 'arrayBuffer');
	await expect(decodeGamePackage(file)).rejects.toMatchObject({ code: 'limit' });
	expect(read).not.toHaveBeenCalled();
});

it('exports frozen authored content without installation data, secrets, player text or generated code', async () => {
	const source = structuredClone(releaseFixtures[1].game);
	const sentinels = [
		'secret-api-key',
		'private-session-text',
		'1901-01-01T00:00:00.000Z',
		'generated-only-artifact'
	];
	Object.assign(source, {
		apiKey: sentinels[0],
		session: { message: sentinels[1] },
		installedFrom: {
			kind: 'package',
			packageFormatVersion: 1,
			packageRelease: {
				contentVersion: '0.1.0',
				contentHash: 'a'.repeat(64),
				createdAt: sentinels[2]
			},
			versionChanged: false,
			installedAt: sentinels[2]
		}
	});
	Object.assign(source.scripts, {
		derived: { language: 'typescript', source: sentinels[3], compiled: sentinels[3] }
	});
	const content = gameReleaseContent(parseGame(source));
	const bytes = await encodeGamePackage({
		...minimal,
		content,
		contentHash: await hashGameReleaseContent(content)
	});
	const raw = new TextDecoder().decode(bytes);
	for (const sentinel of sentinels) {
		expect(raw).not.toContain(sentinel);
	}
	expect((await decodeGamePackage(bytes)).content).toEqual(content);
});
