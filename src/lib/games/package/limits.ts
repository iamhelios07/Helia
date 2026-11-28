import { RESOURCE_LIST_BYTES, type ResourceListBudgetError } from '../resources.js';
import { CONTENT_NODE_LIMIT } from '../versioning-validation.js';

export { CONTENT_NODE_LIMIT, CONTENT_CHARACTER_LIMIT } from '../versioning-validation.js';

// A valid entry uses at least 77 JSON bytes for its reference and four scanner nodes.
// Double that bound to leave room while still rejecting pre-parse node bombs.
export const RESOURCE_SCAN_NODE_LIMIT = 8n * (RESOURCE_LIST_BYTES / 77n);

/** Format v1 limits, independent of the application's stricter content limits. */
export const PACKAGE_LIMITS = {
	file: 32 * 1024 * 1024,
	manifest: 64 * 1024,
	// Leave room for the manifest and ZIP headers inside the v1 file limit.
	content: 31 * 1024 * 1024,
	asset: 8 * 1024 * 1024,
	assets: 24 * 1024 * 1024,
	entries: 65534
} as const;

export type GamePackageErrorCode = keyof typeof messages;

const messages = {
	mediaType: '지원하지 않는 파일 형식이에요.',
	mediaSize: '파일 크기가 올바르지 않아요.',
	uploadMissing: '업로드를 찾을 수 없어요. 처음부터 다시 올려 주세요.',
	uploadState: '이 업로드는 더 이상 변경할 수 없어요.',
	scopeMismatch: '다른 게임 또는 다른 용도의 업로드예요.',
	gameNotWritable: '지금은 이 게임을 편집할 수 없어요.',
	chunkInvalid: '받은 파일 조각을 확인할 수 없어요.',
	chunkConflict: '이미 받은 파일 조각과 내용이 달라요.',
	uploadIncomplete: '아직 모든 파일 조각을 받지 못했어요.',
	storageFull: '저장 공간이 부족해요.',
	busy: '다른 업로드를 처리하고 있어요. 잠시 뒤 다시 시도해 주세요.',
	requestLimit: '서버가 받을 수 있는 요청 크기를 넘었어요.',
	inProgress: '업로드한 파일을 확인하고 있어요.',
	missingAsset: '저장된 파일을 찾을 수 없어요.',
	packageReference: '패키지의 파일 참조가 올바르지 않아요.',
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
	constructor(
		public readonly code: GamePackageErrorCode,
		budgetError?: ResourceListBudgetError
	) {
		super(budgetError?.message ?? messages[code]);
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

export const SAVE_REQUEST_BYTES = 20n * 1024n * 1024n;
/** Serialized requests above this UTF-8 size travel as a `document` upload (§3.9). */
export const SAVE_BODY_REF_BYTES = 8n * 1024n * 1024n;
export function checkSaveRequestSize(request: unknown): string {
	const text = JSON.stringify(request);
	if (text.length > Number(SAVE_REQUEST_BYTES) || jsonUtf8BytesOfText(text) > SAVE_REQUEST_BYTES) {
		throw Error('저장할 내용이 너무 커요');
	}
	return text;
}

function jsonUtf8BytesOfText(text: string): bigint {
	return BigInt(new TextEncoder().encode(text).length);
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
	const scanner = new ContentScanner(bytes);
	for (let index = 0; index < bytes.length; index++) {
		scanner.scan(index);
	}
}

/** Exempt only the root resources value, including escaped spellings of its key. */
class ContentScanner {
	private string = { escaped: false, inString: false };
	private depth = 0;
	private resourceDepth = 0;
	private keyStart = -1;
	private expectKey = false;
	private resourceKey = false;
	private count = 0n;
	private resourceCount = 0n;
	private rootObject = false;
	constructor(private bytes: Uint8Array) {}
	scan(index: number) {
		const byte = this.bytes[index];
		if (!this.string.inString && byte === 0x22 && this.depth === 1 && this.expectKey) {
			this.keyStart = index;
		}
		if (scanString(byte, this.string)) {
			this.endKey(index);
			return;
		}
		this.structure(byte);
	}
	private endKey(index: number) {
		if (!this.string.inString && this.keyStart >= 0) {
			const key = this.bytes.subarray(this.keyStart, index + 1);
			this.resourceKey = key.length <= 56 && this.isResourcesKey(key);
			this.keyStart = -1;
			this.expectKey = false;
		}
	}
	private isResourcesKey(key: Uint8Array): boolean {
		if (key.includes(0x5c)) {
			return parsePackageJson(key) === 'resources';
		}
		return new TextDecoder().decode(key) === '"resources"';
	}
	private structure(byte: number) {
		const opens = byte === 0x5b || byte === 0x7b;
		if (opens && this.depth === 0) {
			this.rootObject = byte === 0x7b;
		}
		if (opens && this.rootObject && this.depth === 1 && this.resourceKey) {
			this.resourceDepth = 2;
		}
		if (opens || byte === 0x2c) {
			this.countNode();
		}
		if (opens) {
			this.depth++;
		}
		if (byte === 0x5d || byte === 0x7d) {
			this.depth--;
			if (this.depth < this.resourceDepth) {
				this.resourceDepth = 0;
			}
		}
		if (this.depth === 1 && (byte === 0x7b || byte === 0x2c)) {
			this.expectKey = true;
			this.resourceKey = false;
		}
	}
	private countNode() {
		if (this.resourceDepth) {
			this.resourceCount++;
			requirePackage(this.resourceCount <= RESOURCE_SCAN_NODE_LIMIT, 'content');
			return;
		}
		this.count++;
		requirePackage(this.count <= 2n * BigInt(CONTENT_NODE_LIMIT), 'content');
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
