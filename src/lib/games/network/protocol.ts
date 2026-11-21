/** Network limits are separate from JSON game-state and session-file limits. */
export const NETWORK_LIMITS = Object.freeze({
	requestBytes: 8 * 1024 * 1024,
	responseBytes: 32 * 1024 * 1024,
	headerBytes: 16 * 1024,
	idleMs: 600_000,
	pending: 16
});
export interface NetworkRequest {
	url: string;
	method: string;
	headers: [string, string][];
	/** Base64; null distinguishes no body from an empty body. */
	body: string | null;
}
export interface NetworkHead {
	status: number;
	statusText: string;
	headers: [string, string][];
}
export type NetworkEvent =
	| { kind: 'head'; head: NetworkHead }
	| { kind: 'chunk'; data: string }
	| { kind: 'end' }
	| { kind: 'error' };

export function networkURL(value: unknown): URL {
	if (typeof value !== 'string' || value.length > 8192) {
		throw new TypeError('Invalid fetch URL');
	}
	const url = new URL(value);
	if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
		throw new TypeError('Fetch requires an HTTP(S) URL without embedded credentials');
	}
	url.hash = '';
	return url;
}
const forbiddenHeaders = new Set([
	'host',
	'connection',
	'content-length',
	'transfer-encoding',
	'upgrade',
	'expect',
	'trailer',
	'te',
	'cookie',
	'cookie2',
	'origin',
	'referer',
	'accept-encoding',
	'proxy-authorization',
	'proxy-connection'
]);
export function networkHeaders(value: unknown): [string, string][] {
	if (
		!Array.isArray(value) ||
		value.length > 128 ||
		JSON.stringify(value).length > NETWORK_LIMITS.headerBytes
	) {
		throw new TypeError('Invalid fetch headers');
	}
	for (const entry of value) {
		if (
			!Array.isArray(entry) ||
			entry.length !== 2 ||
			entry.some((item) => typeof item !== 'string')
		) {
			throw new TypeError('Invalid fetch header');
		}
		const name = String(entry[0]).toLowerCase();
		if (forbiddenHeaders.has(name) || name.startsWith('sec-') || name.startsWith('proxy-')) {
			throw new TypeError('Fetch header is not permitted');
		}
	}
	return [...new Headers(value)];
}
export function parseNetworkRequest(value: unknown): NetworkRequest {
	if (!value || typeof value !== 'object') {
		throw new TypeError('Invalid fetch request');
	}
	const input = value as Record<string, unknown>;
	const url = networkURL(input.url).href;
	if (
		typeof input.method !== 'string' ||
		!/^[!#$%&'*+.^_`|~\w-]{1,32}$/.test(input.method) ||
		/^(CONNECT|TRACE|TRACK)$/i.test(input.method)
	) {
		throw new TypeError('Invalid fetch method');
	}
	const body = input.body;
	if (
		body !== null &&
		(typeof body !== 'string' ||
			body.length > Math.ceil(NETWORK_LIMITS.requestBytes / 3) * 4 ||
			body.length % 4 !== 0 ||
			!/^[A-Za-z0-9+/]*={0,2}$/.test(body))
	) {
		throw new TypeError('Invalid fetch body');
	}
	if (
		body !== null &&
		(/^(GET|HEAD)$/i.test(input.method) || atob(body).length > NETWORK_LIMITS.requestBytes)
	) {
		throw new TypeError('Invalid fetch body');
	}
	return { url, method: input.method, headers: networkHeaders(input.headers), body };
}
export function encodeBytes(bytes: Uint8Array): string {
	let result = '';
	for (let offset = 0; offset < bytes.length; offset += 8192) {
		result += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
	}
	return btoa(result);
}
export function decodeBytes(value: string): Uint8Array<ArrayBuffer> {
	return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
