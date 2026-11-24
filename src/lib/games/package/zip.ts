import { checkPackageSize, PACKAGE_LIMITS, requirePackage } from './limits.js';

export interface ZipEntry {
	name: string;
	data: Uint8Array;
}

const encoder = new TextEncoder();
const manifestName = encoder.encode('helia-package.json');
const contentName = encoder.encode('content.json');
const assetPrefix = encoder.encode('assets/');
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
	let value = index;
	for (let bit = 0; bit < 8; bit++) {
		value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
	}
	return value >>> 0;
});

export function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function validName(bytes: Uint8Array, index: number): void {
	if (index < 2) {
		requirePackage(equalBytes(bytes, index === 0 ? manifestName : contentName));
		return;
	}
	requirePackage(bytes.length === 71 && equalBytes(bytes.subarray(0, 7), assetPrefix));
	requirePackage(
		bytes.subarray(7).every((byte) => (byte >= 48 && byte <= 57) || (byte >= 97 && byte <= 102))
	);
}

function entryLimit(index: number): number {
	if (index === 0) {
		return PACKAGE_LIMITS.manifest;
	}
	return index === 1 ? PACKAGE_LIMITS.content : PACKAGE_LIMITS.asset;
}

function checkEntry(entry: ZipEntry, index: number, previous: string): void {
	requirePackage(index <= 2 || previous < entry.name);
	checkPackageSize(entry.data.length, entryLimit(index));
}

function writeLocal(view: DataView, offset: number, entry: ZipEntry, name: Uint8Array): void {
	view.setUint32(offset, 0x04034b50, true);
	view.setUint16(offset + 4, 10, true);
	view.setUint16(offset + 6, 0x0800, true);
	view.setUint16(offset + 12, 0x0021, true);
	view.setUint32(offset + 14, crc32(entry.data), true);
	view.setUint32(offset + 18, entry.data.length, true);
	view.setUint32(offset + 22, entry.data.length, true);
	view.setUint16(offset + 26, name.length, true);
}

/** Only Helia's fixed, contiguous STORED subset; never extracts to a filesystem. */
export function encodeZip(entries: readonly ZipEntry[]): Uint8Array {
	requirePackage(entries.length >= 2 && entries.length <= PACKAGE_LIMITS.entries);
	const names = entries.map((entry, index) => {
		const name = encoder.encode(entry.name);
		validName(name, index);
		checkEntry(entry, index, entries[index - 1]?.name ?? '');
		return name;
	});
	checkPackageSize(
		entries.slice(2).reduce((total, entry) => total + entry.data.length, 0),
		PACKAGE_LIMITS.assets
	);
	const localSize = entries.reduce(
		(sum, entry, index) => sum + 30 + names[index].length + entry.data.length,
		0
	);
	const centralSize = names.reduce((sum, name) => sum + 46 + name.length, 0);
	checkPackageSize(localSize + centralSize + 22);
	const bytes = new Uint8Array(localSize + centralSize + 22);
	const view = new DataView(bytes.buffer);
	let local = 0,
		central = localSize;
	entries.forEach((entry, index) => {
		const name = names[index];
		writeLocal(view, local, entry, name);
		bytes.set(name, local + 30);
		bytes.set(entry.data, local + 30 + name.length);
		view.setUint32(central, 0x02014b50, true);
		view.setUint16(central + 4, 0x0014, true);
		bytes.set(bytes.subarray(local + 4, local + 26), central + 6);
		view.setUint16(central + 28, name.length, true);
		view.setUint32(central + 42, local, true);
		bytes.set(name, central + 46);
		local += 30 + name.length + entry.data.length;
		central += 46 + name.length;
	});
	view.setUint32(central, 0x06054b50, true);
	view.setUint16(central + 8, entries.length, true);
	view.setUint16(central + 10, entries.length, true);
	view.setUint32(central + 12, centralSize, true);
	view.setUint32(central + 16, localSize, true);
	return bytes;
}

function readDirectory(view: DataView): { count: number; start: number; end: number } {
	requirePackage(view.byteLength >= 22);
	const end = view.byteLength - 22;
	requirePackage(view.getUint32(end, true) === 0x06054b50);
	requirePackage(view.getUint32(end + 4, true) === 0 && view.getUint16(end + 20, true) === 0);
	const count = view.getUint16(end + 10, true);
	requirePackage(
		count >= 2 && count <= PACKAGE_LIMITS.entries && view.getUint16(end + 8, true) === count
	);
	const size = view.getUint32(end + 12, true),
		start = view.getUint32(end + 16, true);
	requirePackage(46 * count <= size && start + size === end);
	return { count, start, end };
}

function validateLocal(view: DataView, local: number): void {
	requirePackage(view.getUint32(local, true) === 0x04034b50);
	requirePackage(view.getUint16(local + 4, true) === 10);
	requirePackage(view.getUint16(local + 6, true) === 0x0800);
	requirePackage(view.getUint16(local + 8, true) === 0);
	requirePackage(
		view.getUint16(local + 10, true) === 0 && view.getUint16(local + 12, true) === 0x0021
	);
	requirePackage(view.getUint16(local + 28, true) === 0);
	const size = view.getUint32(local + 22, true);
	requirePackage(size !== 0xffffffff && size === view.getUint32(local + 18, true));
}

function validateCentral(view: DataView, central: number, local: number): void {
	requirePackage(view.getUint32(central, true) === 0x02014b50);
	requirePackage(view.getUint16(central + 4, true) === 0x0014);
	requirePackage(view.getUint32(central + 30, true) === 0);
	requirePackage(
		view.getUint32(central + 34, true) === 0 && view.getUint32(central + 38, true) === 0
	);
	requirePackage(view.getUint32(central + 42, true) === local);
}

function readEntry(
	bytes: Uint8Array,
	offsets: { central: number; local: number; start: number; end: number },
	index: number
): { entry: ZipEntry; nameLength: number } {
	const { central, local, start, end } = offsets;
	requirePackage(central + 46 <= end && local + 30 <= start);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	validateCentral(view, central, local);
	validateLocal(view, local);
	requirePackage(
		equalBytes(bytes.subarray(local + 4, local + 26), bytes.subarray(central + 6, central + 28))
	);
	const length = view.getUint16(local + 26, true);
	requirePackage(length === view.getUint16(central + 28, true));
	const size = view.getUint32(local + 22, true);
	requirePackage(central + 46 + length <= end && local + 30 + length + size <= start);
	const name = bytes.subarray(local + 30, local + 30 + length);
	requirePackage(equalBytes(name, bytes.subarray(central + 46, central + 46 + length)));
	// Check original name bytes before decoding, and decode exactly once.
	validName(name, index);
	return {
		entry: {
			name: new TextDecoder('ascii').decode(name),
			data: bytes.subarray(local + 30 + length, local + 30 + length + size)
		},
		nameLength: length
	};
}

export function decodeZip(bytes: Uint8Array): ZipEntry[] {
	checkPackageSize(bytes.byteLength);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const { count, start, end } = readDirectory(view);
	const entries: ZipEntry[] = [];
	let local = 0,
		central = start,
		assetSize = 0;
	for (let index = 0; index < count; index++) {
		const { entry, nameLength } = readEntry(bytes, { local, central, start, end }, index);
		checkEntry(entry, index, entries[index - 1]?.name ?? '');
		if (index >= 2) {
			assetSize += entry.data.length;
			checkPackageSize(assetSize, PACKAGE_LIMITS.assets);
		}
		requirePackage(crc32(entry.data) === view.getUint32(local + 14, true), 'integrity');
		entries.push(entry);
		local += 30 + nameLength + entry.data.length;
		central += 46 + nameLength;
	}
	requirePackage(local === start && central === end);
	return entries;
}
