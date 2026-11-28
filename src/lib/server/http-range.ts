/** A single HTTP byte range, with an exclusive end for openMedia.read. */
export interface ByteRange {
	start: number;
	end: number;
}

/** Ignore unsupported/malformed ranges; distinguish valid but unsatisfiable ranges. */
export function byteRange(header: string | null, size: number): ByteRange | 'unsatisfiable' | null {
	const match = /^bytes=(\d*)-(\d*)$/i.exec(header?.trim() ?? '');
	if (!match || (!match[1] && !match[2])) {
		return null;
	}
	const length = BigInt(size);
	if (!match[1]) {
		const suffix = BigInt(match[2]);
		if (suffix === 0n || length === 0n) {
			return 'unsatisfiable';
		}
		return { start: suffix >= length ? 0 : Number(length - suffix), end: size };
	}
	const start = BigInt(match[1]);
	const last = match[2] ? BigInt(match[2]) : length - 1n;
	// Reject reversed bounds with 416 rather than ignoring the malformed range.
	if (start >= length || last < start) {
		return 'unsatisfiable';
	}
	return { start: Number(start), end: last >= length ? size : Number(last + 1n) };
}
