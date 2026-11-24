import { expect, it } from 'vitest';

import minimal from './fixtures/minimal-release.json';
import releaseCases from './fixtures/release-cases.json';
import { PACKAGE_LIMITS, serializePackageJson } from './limits.js';
import { decodeManifest, encodeManifest, type GamePackageManifest } from './manifest.js';

function manifest(): GamePackageManifest {
	const { content: _content, ...release } = minimal;
	void _content;
	return {
		format: 'helia-game-package',
		formatVersion: 1,
		release,
		content: { size: 0, sha256: 'a'.repeat(64) }
	};
}

const bytes = (value: unknown) => new TextEncoder().encode(serializePackageJson(value));

it('round trips the exact key set and canonical serialization', () => {
	const input = manifest();
	expect(decodeManifest(encodeManifest(input))).toEqual(input);
});

it.each(releaseCases)('shared host release fixture: $name', ({ request, expect: expected }) => {
	const { content: _content, ...release } = request.release;
	void _content;
	const input = bytes({ ...manifest(), release });
	if (expected.accepted) {
		expect(decodeManifest(input).release).toEqual(release);
	} else {
		expect(() => decodeManifest(input)).toThrow(
			expect.objectContaining({ code: expected.errorCode })
		);
	}
});

it.each([
	'2026-11-20T09:15:00+09:00',
	'2026-11-20T09:15:00Z',
	'2026-02-30T09:15:00.000Z',
	'2026-11-20T09:15:00.000000Z',
	'0000-01-01T00:00:00.000Z',
	'2026-11-20T24:00:00.000Z',
	'2026-11-20T09:15:00.000Z\n'
])('rejects nonstandard timestamp %s', (createdAt) => {
	const input = manifest();
	input.release.createdAt = createdAt;
	expect(() => decodeManifest(bytes(input))).toThrow();
});

it.each(['0001-01-01T00:00:00.000Z', '9999-12-31T23:59:59.999Z', '2024-02-29T00:00:00.000Z'])(
	'accepts timestamp boundary %s',
	(createdAt) => {
		const input = manifest();
		input.release.createdAt = createdAt;
		expect(decodeManifest(bytes(input)).release.createdAt).toBe(createdAt);
	}
);

const invalidChanges = [
	{ extensions: {} },
	{ assets: [] },
	{ format: 'zip' },
	{ content: { size: 0, sha256: 'a'.repeat(64), unknown: true } },
	{ release: { ...minimal, content: undefined } },
	{ release: { ...manifest().release, originalGameId: minimal.originalGameId.toUpperCase() } },
	{ release: { ...manifest().release, originalGameId: '12345678-1234-1234-8234-123456789abc' } },
	{ release: { ...manifest().release, contentVersion: '01.0.0' } },
	{ release: { ...manifest().release, contentHash: 'A'.repeat(64) } },
	{ content: { size: -1, sha256: 'a'.repeat(64) } },
	{ content: { size: 0.5, sha256: 'a'.repeat(64) } },
	{ formatVersion: 1.1 }
];
it.each(invalidChanges)('rejects invalid manifest fields %#', (change) => {
	expect(() => decodeManifest(bytes({ ...manifest(), ...change }))).toThrow();
});

it.each([0, 2])('provides a separate version error for %i', (formatVersion) => {
	expect(() => decodeManifest(bytes({ ...manifest(), formatVersion }))).toThrow(
		expect.objectContaining({ code: formatVersion === 2 ? 'newerHeliaRequired' : 'version' })
	);
});

it('reports a newer format version before an unknown key set', () => {
	// A future writer may add keys; the user still needs the newer-Helia message.
	expect(() => decodeManifest(bytes({ ...manifest(), formatVersion: 2, future: true }))).toThrow(
		expect.objectContaining({ code: 'newerHeliaRequired' })
	);
	expect(() =>
		decodeManifest(bytes({ ...manifest(), formatVersion: 2, release: { future: true } }))
	).toThrow(expect.objectContaining({ code: 'newerHeliaRequired' }));
});

it('rejects duplicate keys, reordered keys, whitespace, trailing bytes and BOM', () => {
	const canonical = new TextDecoder().decode(encodeManifest(manifest()));
	for (const text of [
		canonical.replace('"formatVersion":1', '"formatVersion":1,"formatVersion":1'),
		JSON.stringify(manifest()),
		canonical + '\n',
		'\ufeff' + canonical,
		canonical + 'x'
	]) {
		expect(() => decodeManifest(new TextEncoder().encode(text))).toThrow();
	}
	expect(() => decodeManifest(new Uint8Array(PACKAGE_LIMITS.manifest + 1))).toThrow(
		expect.objectContaining({ code: 'limit' })
	);
});
