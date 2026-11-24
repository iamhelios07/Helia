import { CONTENT_NODE_LIMIT } from '../versioning-validation.js';

export { CONTENT_NODE_LIMIT, CONTENT_CHARACTER_LIMIT } from '../versioning-validation.js';

/** Format v1 limits, independent of the application's stricter content limits. */
export const PACKAGE_LIMITS = {
	file: 32 * 1024 * 1024,
	manifest: 64 * 1024,
	content: 16 * 1024 * 1024,
	asset: 8 * 1024 * 1024,
	assets: 24 * 1024 * 1024,
	entries: 65534
} as const;

export type GamePackageErrorCode =
	| 'format'
	| 'version'
	| 'integrity'
	| 'limit'
	| 'content'
	| 'nonCanonical'
	| 'installOnlyKey'
	| 'newerHeliaRequired'
	| 'staleAcknowledgement';

const messages: Record<GamePackageErrorCode, string> = {
	format: '게임 패키지 형식이 올바르지 않아요.',
	version: '지원하지 않는 게임 패키지 버전이에요.',
	integrity: '게임 패키지의 무결성을 확인할 수 없어요.',
	limit: '게임 패키지가 허용 크기를 초과했어요.',
	content: '게임 패키지의 콘텐츠가 올바르지 않아요.',
	nonCanonical: '정규형 콘텐츠가 아니에요. 더 새 Helia가 필요할 수 있어요.',
	installOnlyKey: '게임 콘텐츠에 설치 전용 정보가 들어 있어요.',
	newerHeliaRequired: '이 게임 패키지를 열려면 더 새 Helia가 필요해요.',
	staleAcknowledgement: '설치 확인 정보가 바뀌었어요. 다시 확인해 주세요.'
};

export function isGamePackageErrorCode(value: unknown): value is GamePackageErrorCode {
	return typeof value === 'string' && Object.hasOwn(messages, value);
}

export class GamePackageError extends Error {
	constructor(public readonly code: GamePackageErrorCode) {
		super(messages[code]);
		this.name = 'GamePackageError';
	}
}

export function requirePackage(
	condition: unknown,
	code: GamePackageErrorCode = 'format'
): asserts condition {
	if (!condition) {
		throw new GamePackageError(code);
	}
}

export function checkPackageSize(size: number, maximum: number = PACKAGE_LIMITS.file): void {
	requirePackage(Number.isSafeInteger(size) && size >= 0 && size <= maximum, 'limit');
}

/** Also usable for a serialized install request before handing it to a transport. */
export function serializedRequestSize(request: unknown): number {
	return new TextEncoder().encode(JSON.stringify(request)).length;
}

export function packageObject(value: unknown): Record<string, unknown> {
	requirePackage(value && typeof value === 'object' && !Array.isArray(value));
	return value as Record<string, unknown>;
}

/** Write keys directly: rebuilding an object would re-sort integer-looking keys. */
export function serializePackageJson(value: unknown): string {
	if (Array.isArray(value)) {
		return '[' + value.map(serializePackageJson).join(',') + ']';
	}
	if (value && typeof value === 'object') {
		return (
			'{' +
			Object.entries(value)
				.sort(([a], [b]) => (a < b ? -1 : Number(a > b)))
				.map(([key, item]) => JSON.stringify(key) + ':' + serializePackageJson(item))
				.join(',') +
			'}'
		);
	}
	requirePackage(
		value === null || ['string', 'boolean', 'number'].includes(typeof value),
		'content'
	);
	requirePackage(typeof value !== 'number' || Number.isFinite(value), 'content');
	return JSON.stringify(value);
}

/**
 * Bounds JSON structure before `JSON.parse` can build a tree. Commas and
 * container openers outside strings approximate the node count; the budget is
 * twice the raw node limit, so only clearly oversized input is rejected early
 * with the same code the full traversal would report.
 */
export function checkContentComplexity(bytes: Uint8Array): void {
	const state = { escaped: false, inString: false };
	let count = 0;
	for (const byte of bytes) {
		if (scanString(byte, state)) {
			continue;
		}
		if (byte === 0x2c /* , */ || byte === 0x5b /* [ */ || byte === 0x7b /* { */) {
			count++;
			requirePackage(count <= 2 * CONTENT_NODE_LIMIT, 'content');
		}
	}
}

/** Advances string state and reports whether the byte belongs to a string. */
function scanString(byte: number, state: { escaped: boolean; inString: boolean }): boolean {
	if (!state.inString) {
		state.inString = byte === 0x22; /* " */
		return state.inString;
	}
	if (state.escaped) {
		state.escaped = false;
	} else if (byte === 0x5c /* \ */) {
		state.escaped = true;
	} else if (byte === 0x22 /* " */) {
		state.inString = false;
	}
	return true;
}

export function parsePackageJson(bytes: Uint8Array): unknown {
	try {
		requirePackage(!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf));
		return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
	} catch {
		throw new GamePackageError('format');
	}
}

export async function sha256(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
