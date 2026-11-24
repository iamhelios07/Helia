import { expect, it } from 'vitest';

import { PACKAGE_LIMITS } from './limits.js';
import { crc32, decodeZip, encodeZip, type ZipEntry } from './zip.js';

const text = (value: string) => new TextEncoder().encode(value);
function entries(): ZipEntry[] {
	return [
		{ name: 'helia-package.json', data: text('{}') },
		{ name: 'content.json', data: text('{}') },
		{ name: 'assets/' + 'a'.repeat(64), data: new Uint8Array([0, 1, 255]) }
	];
}

function layout(bytes: Uint8Array) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const end = bytes.length - 22;
	const central = view.getUint32(end + 16, true);
	return { view, end, central };
}

it('matches standard CRC-32 known vectors and supports sliced input', () => {
	expect(crc32(text('123456789'))).toBe(0xcbf43926);
	expect(crc32(new Uint8Array())).toBe(0);
	const encoded = encodeZip(entries());
	const padded = new Uint8Array(encoded.length + 2);
	padded.set(encoded, 1);
	expect(decodeZip(padded.subarray(1, -1))).toEqual(entries());
});

// Every fixed LFH field, including each forbidden flag and both ZIP64 size markers.
const localChanges: [number, number, number][] = [
	[0, 4, 0],
	[4, 2, 20],
	[6, 2, 0],
	[6, 2, 0x0801],
	[6, 2, 0x0808],
	[6, 2, 0x0840],
	[6, 2, 0x2800],
	[8, 2, 8],
	[10, 2, 1],
	[12, 2, 0],
	[14, 4, 0],
	[18, 4, 0xffffffff],
	[22, 4, 0xffffffff],
	[18, 4, 1],
	[26, 2, 17],
	[28, 2, 1]
];
function write(view: DataView, offset: number, width: number, value: number) {
	if (width === 2) {
		view.setUint16(offset, value, true);
	} else {
		view.setUint32(offset, value, true);
	}
}

it.each(localChanges)('rejects LFH field offset %i, width %i, value %i', (offset, width, value) => {
	const bytes = encodeZip(entries());
	const { view, central } = layout(bytes);
	write(view, offset, width, value);
	// Mirror common fields so fixed-field checks are exercised independently of mismatch checks.
	if (offset >= 4 && offset <= 22) {
		write(view, central + offset + 2, width, value);
	}
	expect(() => decodeZip(bytes)).toThrow();
});

const centralChanges: [number, number, number][] = [
	[0, 4, 0],
	[4, 2, 0x0314],
	[6, 2, 20],
	[8, 2, 0x0808],
	[10, 2, 8],
	[12, 2, 1],
	[14, 2, 0],
	[16, 4, 0],
	[20, 4, 0xffffffff],
	[24, 4, 0xffffffff],
	[28, 2, 12],
	[30, 2, 1],
	[32, 2, 1],
	[34, 2, 1],
	[36, 2, 1],
	[38, 4, 0xa0000000],
	[42, 4, 1]
];
it.each(centralChanges)(
	'rejects CDH field offset %i, width %i, value %i',
	(offset, width, value) => {
		const bytes = encodeZip(entries());
		const { view, central } = layout(bytes);
		write(view, central + offset, width, value);
		expect(() => decodeZip(bytes)).toThrow();
	}
);

const endChanges: [number, number, number][] = [
	[0, 4, 0],
	[4, 2, 1],
	[6, 2, 1],
	[8, 2, 2],
	[10, 2, 1],
	[10, 2, 0xffff],
	[12, 4, 46 * 3 - 1],
	[12, 4, 0xffffffff],
	[16, 4, 0xffffffff],
	[20, 2, 1]
];
it.each(endChanges)('rejects EOCD field offset %i, width %i, value %i', (offset, width, value) => {
	const bytes = encodeZip(entries());
	const { view, end } = layout(bytes);
	write(view, end + offset, width, value);
	expect(() => decodeZip(bytes)).toThrow();
});

it('preflights the declared count against directory size before parsing records', () => {
	const bytes = encodeZip(entries());
	const { view, end } = layout(bytes);
	view.setUint16(end + 8, 65534, true);
	view.setUint16(end + 10, 65534, true);
	expect(() => decodeZip(bytes)).toThrow();
});

it.each([0, 10, 13, 65, 92, 128, 255])('checks raw name bytes, including %i', (byte) => {
	const bytes = encodeZip(entries());
	const { central } = layout(bytes);
	bytes[30] = byte;
	bytes[central + 46] = byte;
	expect(() => decodeZip(bytes)).toThrow();
});

it('rejects raw asset names, ordering, duplication, and different central names', () => {
	const original = [...entries(), { name: 'assets/' + 'b'.repeat(64), data: new Uint8Array() }];
	const bytes = encodeZip(original);
	const { central } = layout(bytes);
	bytes[central + 46] = 65;
	expect(() => decodeZip(bytes)).toThrow();
	const invalidAsset = encodeZip(entries());
	const assetLocal = 50 + 44;
	const assetCentral = layout(invalidAsset).central + 64 + 58;
	invalidAsset[assetLocal + 30 + 7] = 65;
	invalidAsset[assetCentral + 46 + 7] = 65;
	expect(() => decodeZip(invalidAsset)).toThrow();
	expect(() => encodeZip([...entries(), entries()[2]])).toThrow();
	expect(() => encodeZip([original[0], original[1], original[3], original[2]])).toThrow();
});

it.each(['a', '0'])('rejects duplicate or descending asset names in an archive: %s', (lastHash) => {
	const bytes = encodeZip([
		...entries(),
		{ name: 'assets/' + 'b'.repeat(64), data: new Uint8Array() }
	]);
	const { central } = layout(bytes);
	const lastLocal = 50 + 44 + 30 + 71 + 3;
	const lastCentral = central + 64 + 58 + 46 + 71;
	const name = text('assets/' + lastHash.repeat(64));
	bytes.set(name, lastLocal + 30);
	bytes.set(name, lastCentral + 46);
	expect(() => decodeZip(bytes)).toThrow();
});

function insert(bytes: Uint8Array, offset: number, extra: Uint8Array): Uint8Array {
	const result = new Uint8Array(bytes.length + extra.length);
	result.set(bytes.subarray(0, offset));
	result.set(extra, offset);
	result.set(bytes.subarray(offset), offset + extra.length);
	return result;
}

it('rejects prefixes, gaps, unreferenced local records, descriptors, ZIP64 trailers and appended bytes', () => {
	const bytes = encodeZip(entries());
	const { central } = layout(bytes);
	for (const [offset, extra] of [
		[0, new Uint8Array([0])],
		[50, new Uint8Array([0])],
		[central, bytes.subarray(0, 50)],
		[central, new Uint8Array(16)],
		[bytes.length - 22, new Uint8Array(76)],
		[bytes.length, new Uint8Array([0])]
	] as const) {
		const changed = insert(bytes, offset, extra);
		const changedLayout = layout(changed);
		// Keep EOCD arithmetic valid for inserted local records/gaps to reach continuity checks.
		if (offset <= central) {
			changedLayout.view.setUint32(changedLayout.end + 16, central + extra.length, true);
		}
		expect(() => decodeZip(changed)).toThrow();
	}
});

it('rejects changed data CRC, truncated records, and mismatched local offsets', () => {
	const bytes = encodeZip(entries());
	bytes[48] ^= 1;
	expect(() => decodeZip(bytes)).toThrow(expect.objectContaining({ code: 'integrity' }));
	for (const size of [0, 21, 22, bytes.length - 1]) {
		expect(() => decodeZip(bytes.subarray(0, size))).toThrow();
	}
});

it('accepts 65,534 entries and has no separate asset count cap', () => {
	const many = entries().slice(0, 2);
	for (let index = 0; index < PACKAGE_LIMITS.entries - 2; index++) {
		many.push({ name: 'assets/' + index.toString(16).padStart(64, '0'), data: new Uint8Array() });
	}
	expect(decodeZip(encodeZip(many))).toHaveLength(65534);
	expect(() => encodeZip([...many, many.at(-1)!])).toThrow();
});

it('enforces each declared payload limit and the unique asset total', () => {
	for (const [index, maximum] of [
		PACKAGE_LIMITS.manifest,
		PACKAGE_LIMITS.content,
		PACKAGE_LIMITS.asset
	].entries()) {
		const input = entries();
		input[index].data = new Uint8Array(maximum);
		expect(decodeZip(encodeZip(input))[index].data).toHaveLength(maximum);
		input[index].data = new Uint8Array(maximum + 1);
		expect(() => encodeZip(input)).toThrow(expect.objectContaining({ code: 'limit' }));
	}
	const input = entries().slice(0, 2);
	for (const hash of ['a', 'b', 'c']) {
		input.push({ name: 'assets/' + hash.repeat(64), data: new Uint8Array(PACKAGE_LIMITS.asset) });
	}
	expect(decodeZip(encodeZip(input))).toHaveLength(5);
	input.push({ name: 'assets/' + 'd'.repeat(64), data: new Uint8Array([0]) });
	expect(() => encodeZip(input)).toThrow(expect.objectContaining({ code: 'limit' }));
});

it('accepts exactly 32 MiB of ZIP bytes and rejects one byte more', () => {
	const input = entries().slice(0, 2);
	for (const hash of ['a', 'b', 'c']) {
		input.push({ name: 'assets/' + hash.repeat(64), data: new Uint8Array(PACKAGE_LIMITS.asset) });
	}
	const overhead = encodeZip(input).length;
	input[1].data = new Uint8Array(input[1].data.length + PACKAGE_LIMITS.file - overhead);
	const bytes = encodeZip(input);
	expect(bytes).toHaveLength(PACKAGE_LIMITS.file);
	expect(decodeZip(bytes)).toHaveLength(5);
	input[1].data = new Uint8Array(input[1].data.length + 1);
	expect(() => encodeZip(input)).toThrow(expect.objectContaining({ code: 'limit' }));
	expect(() => decodeZip(new Uint8Array(PACKAGE_LIMITS.file + 1))).toThrow(
		expect.objectContaining({ code: 'limit' })
	);
});
