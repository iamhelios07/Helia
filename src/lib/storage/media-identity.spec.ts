import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

import { crc32, Crc32 } from '../games/package/zip.js';
import { contentHash } from '../games/state/model.js';
import { runtimeHash } from '../server/runtime-content.js';
import fixture from './fixtures/media-identity.json';
import { Base64Stream, MediaIdentity } from './media-identity.js';

const cases = fixture.vectors.flatMap((vector) =>
	fixture.chunkSizes.map((size) => ({ ...vector, size }))
);

it('keeps the Unicode fixture ASCII-escaped with keys that distinguish UTF-16 sorting', () => {
	const bytes = readFileSync('src/lib/storage/fixtures/media-identity.json');
	expect(bytes.every((byte) => byte <= 0x7f)).toBe(true);
	expect(fixture.gameId).toBe('game-\ud55c\uae00-\ud83c\udfae-"\\\n');
	expect(fixture.releaseTemplate.initialState).toHaveProperty('\ud83d\ude00', 0);
	expect(fixture.releaseTemplate.initialState).toHaveProperty('\uff00', 1.25);
});

it.each(cases)('matches shared media vector: $length bytes / $size chunks', (vector) => {
	const bytes = Uint8Array.from({ length: vector.length }, (_, index) => (index * 37 + 11) % 256);
	const data = `data:${fixture.mime};base64,${Buffer.from(bytes).toString('base64')}`;
	const identity = new MediaIdentity(fixture.gameId, fixture.mime);
	const crc = new Crc32();
	for (let offset = 0; offset < bytes.length; offset += vector.size) {
		const chunk = bytes.subarray(offset, offset + vector.size);
		identity.update(chunk).update(new Uint8Array(0));
		crc.update(chunk);
	}
	const expected = {
		raw: vector.raw,
		crc: vector.crc,
		blobId: vector.blobId,
		assetHash: vector.assetHash
	};
	expect(identity.digest()).toEqual(expected);
	expect(identity.digest()).toEqual(expected);
	expect(() => identity.update(bytes)).toThrow('finalized');
	expect(contentHash([fixture.gameId, data])).toBe(vector.blobId);
	expect(runtimeHash(data)).toBe(vector.assetHash);
	expect(crc.digest()).toBe(vector.crc);
	expect(crc32(bytes)).toBe(vector.crc);
	expect(createHash('sha256').update(bytes).digest('hex')).toBe(vector.raw);
});

it('matches the standard CRC-32 vector and permits inspecting an intermediate CRC', () => {
	const bytes = new TextEncoder().encode('123456789');
	const crc = new Crc32().update(bytes.subarray(0, 4));
	expect(crc.digest()).toBe(crc32(bytes.subarray(0, 4)));
	expect(crc.update(bytes.subarray(4)).digest()).toBe(0xcbf43926);
});

it('retains only copied base64 tails and emits bounded blocks for large input chunks', () => {
	const encoded: string[] = [];
	const stream = new Base64Stream((text) => encoded.push(text));
	const bytes = new Uint8Array([1, 2]);
	stream.update(bytes);
	bytes.fill(0);
	stream.update(new Uint8Array(100_000).fill(3));
	stream.finish();
	stream.finish();
	expect(encoded.join('')).toBe(
		Buffer.concat([Buffer.from([1, 2]), Buffer.alloc(100_000, 3)]).toString('base64')
	);
	expect(Math.max(...encoded.map((part) => part.length))).toBeLessThanOrEqual(16_384);
	expect(() => stream.update(bytes)).toThrow('finalized');
});
