import { NETWORK_LIMITS } from '#lib/games/network/protocol.js';

/** Enforce body limits before native constructors can allocate outside the VM heap. */
export function validateWebConstruction(type: string, args: unknown[]): void {
	if (type === 'Blob' || type === 'File') {
		if (Array.isArray(args[0])) {
			limit(
				args[0].reduce((size, part) => size + bodySize(part), 0),
				NETWORK_LIMITS.responseBytes
			);
		}
		return;
	}
	if (type === 'Response') {
		limit(bodySize(args[0]), NETWORK_LIMITS.responseBytes);
		return;
	}
	if (type === 'Request') {
		const init = args[1];
		if (init && typeof init === 'object' && 'body' in init) {
			limit(bodySize(init.body), NETWORK_LIMITS.requestBytes);
		}
	}
}
function limit(bytes: number, max: number) {
	if (bytes > max) {
		throw new TypeError('Web body limit');
	}
}
function bodySize(value: unknown): number {
	if (value === undefined || value === null || value instanceof ReadableStream) {
		return 0;
	}
	if (value instanceof Blob) {
		return value.size;
	}
	if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
		return value.byteLength;
	}
	if (value instanceof FormData) {
		let bytes = 0;
		for (const [key, item] of value) {
			bytes += bodySize(key) + bodySize(item) + 256;
		}
		return bytes;
	}
	return new TextEncoder().encode(String(value)).byteLength;
}
