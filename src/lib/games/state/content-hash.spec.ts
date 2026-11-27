import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';

import vectors from './fixtures/content-hash.json';
import { canonical, contentHash } from './model.js';

it.each(vectors)('matches shared canonical UTF-8/SHA-256 vector: $name', (vector) => {
	const value: unknown = JSON.parse(vector.json);
	expect(canonical(value)).toBe(vector.canonicalText);
	expect(Buffer.from(canonical(value)).toString('hex')).toBe(vector.utf8Hex);
	expect(contentHash(value)).toBe(vector.sha256);
	expect(contentHash(value)).not.toBe(vector.legacyHash);
});

it('changes every 64-bit output segment with equal-length different input', () => {
	const left = contentHash('ab');
	const right = contentHash('ac');
	for (let offset = 0; offset < 64; offset += 16) {
		expect(left.slice(offset, offset + 16)).not.toBe(right.slice(offset, offset + 16));
	}
	const oldLeft = vectors.find((vector) => vector.name === 'ascii ab')!.legacyHash;
	const oldRight = vectors.find((vector) => vector.name === 'ascii ac')!.legacyHash;
	expect(oldLeft.slice(16)).toBe(oldRight.slice(16));
});

it('keeps existing canonical rules and ignores object insertion order', () => {
	const left = { b: [1, { y: false, x: '한국어 🎮' }], a: undefined };
	const right = { b: [1, { x: '한국어 🎮', y: false }] };
	expect(contentHash(left)).toBe(contentHash(right));
	expect(contentHash(left)).toMatch(/^[0-9a-f]{64}$/);
	expect(contentHash(left)).toBe(createHash('sha256').update(canonical(left)).digest('hex'));
	expect(contentHash([1, 2])).not.toBe(contentHash([2, 1]));
	expect(contentHash('é')).not.toBe(contentHash('e\u0301'));
});
