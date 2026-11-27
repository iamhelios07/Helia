import { createHash, randomBytes, randomInt } from 'node:crypto';
import { expect, it } from 'vitest';

import { Sha256, sha256, sha256LengthBytes } from './sha256.js';

it.each(
	[
		['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
		['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
		[
			'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
			'248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'
		],
		['a'.repeat(1_000_000), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0']
	].map(([text, expected]) => ({ text, expected, length: text.length }))
)('matches standard SHA-256 vector of $length bytes', ({ text, expected }) => {
	expect(sha256(new TextEncoder().encode(text))).toBe(expected);
});

it.each([0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 129, 1024])(
	'matches node:crypto at padding/block boundary %i',
	(length) => {
		const bytes = new Uint8Array(length).fill(0x61);
		expect(sha256(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
	}
);

it('matches node:crypto on random binary inputs and respects view offsets without mutations', () => {
	for (let index = 0; index < 200; index++) {
		const original = randomBytes(randomInt(0, 16_385) + 11);
		const before = Buffer.from(original);
		const bytes = original.subarray(7, original.length - 4);
		expect(sha256(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
		expect(original.equals(before)).toBe(true);
	}
});

it.each([55, 56, 63, 64])('hashes a %i-byte boundary view with a nonzero offset', (length) => {
	const backing = new Uint8Array(length + 12).fill(0xff);
	const view = backing.subarray(7, 7 + length);
	view.fill(0x61);
	const before = backing.slice();
	expect(view.byteOffset).toBe(7);
	expect(sha256(view)).toBe(createHash('sha256').update(view).digest('hex'));
	expect(backing).toEqual(before);
});

it.each([0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 129, 1024])(
	'incrementally hashes padding/block boundary %i with offset views and empty updates',
	(length) => {
		const bytes = randomBytes(length + 8).subarray(7, 7 + length);
		for (const size of [1, 7, 64, 65]) {
			const hash = new Sha256();
			for (let offset = 0; offset < bytes.length; offset += size) {
				hash.update(bytes.subarray(offset, offset + size)).update(new Uint8Array(0));
			}
			expect(hash.digest()).toBe(sha256(bytes));
			expect(hash.digest()).toBe(createHash('sha256').update(bytes).digest('hex'));
			expect(() => hash.update(bytes)).toThrow('finalized');
		}
	}
);

it('encodes lengths above 4 GiB without allocating the payload', () => {
	for (const length of [0n, 0x20000000n, 0x100000000n, 0x100000001n, (1n << 61n) - 1n]) {
		const expected = Buffer.alloc(8);
		expected.writeBigUInt64BE(length * 8n);
		expect(sha256LengthBytes(length)).toEqual(new Uint8Array(expected));
	}
	expect(() => sha256LengthBytes(-1n)).toThrow('range');
	expect(() => sha256LengthBytes(1n << 61n)).toThrow('range');
});

it('copies a partial input block before its caller reuses the buffer', () => {
	const bytes = new Uint8Array([1, 2, 3]);
	const expected = sha256(bytes);
	const hash = new Sha256().update(bytes);
	bytes.fill(0);
	expect(hash.digest()).toBe(expected);
});

it('rejects incremental updates at the SHA-256 length limit', () => {
	const hash = new Sha256();
	const counter = hash as unknown as { length: bigint };
	counter.length = (1n << 61n) - 2n;
	hash.update(new Uint8Array([1]));
	expect(counter.length).toBe((1n << 61n) - 1n);
	expect(() => hash.update(new Uint8Array([2]))).toThrow('SHA-256 length out of range');
	expect(counter.length).toBe((1n << 61n) - 1n);
});
