export const SECRET_MARKER = 'helia-secret:v1:';
export const SECRET_ERROR = 'Game secret unavailable';
export interface SecretOptions {
	url: string;
}
export type SecretOperation =
	| { kind: 'set'; name: string; value: string; url: string }
	| { kind: 'has' | 'remove' | 'ref'; name: string };
export interface SecretReadAccess {
	has(name: string): Promise<boolean>;
	ref(name: string): Promise<string>;
}
export interface SecretAccess extends SecretReadAccess {
	set(name: string, value: string, options: SecretOptions): Promise<void>;
	remove(name: string): Promise<void>;
}
export function secretScope(value: unknown): string {
	if (typeof value !== 'string' || !/^[\w-]{1,100}$/.test(value)) {
		throw new TypeError(SECRET_ERROR);
	}
	return value;
}
export function secretName(value: unknown): string {
	if (
		typeof value !== 'string' ||
		!/^[A-Za-z][\w.-]{0,63}$/.test(value) ||
		['constructor', 'prototype'].includes(value)
	) {
		throw new TypeError(SECRET_ERROR);
	}
	return value;
}
export function secretURL(value: unknown): string {
	if (typeof value !== 'string' || value.length > 2048 || /\p{Cc}/u.test(value)) {
		throw new TypeError(SECRET_ERROR);
	}
	const url = new URL(value);
	if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
		throw new TypeError(SECRET_ERROR);
	}
	return url.href;
}
export function secretValue(value: unknown): string {
	if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /\p{Cc}/u.test(value)) {
		throw new TypeError(SECRET_ERROR);
	}
	return value;
}
export function secretOperation(value: unknown): SecretOperation {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError(SECRET_ERROR);
	}
	const row = value as Record<string, unknown>,
		name = secretName(row.name);
	const allowed = row.kind === 'set' ? ['kind', 'name', 'value', 'url'] : ['kind', 'name'];
	if (Object.keys(row).some((key) => !allowed.includes(key))) {
		throw new TypeError(SECRET_ERROR);
	}
	if (row.kind === 'set') {
		return { kind: 'set', name, value: secretValue(row.value), url: secretURL(row.url) };
	}
	if (row.kind === 'has' || row.kind === 'remove' || row.kind === 'ref') {
		return { kind: row.kind, name };
	}
	throw new TypeError(SECRET_ERROR);
}
export function secretSignatureInput(gameId: string, name: string, url: string): string {
	return `${gameId}\n${name}\n${url}`;
}
export const unavailableSecrets: SecretAccess = {
	has: async () => false,
	async ref() {
		throw new TypeError(SECRET_ERROR);
	},
	async set() {
		throw new TypeError(SECRET_ERROR);
	},
	async remove() {
		throw new TypeError(SECRET_ERROR);
	}
};
