export const FILE_LIMITS = Object.freeze({
	fileBytes: 8 * 1024 * 1024,
	sessionBytes: 128 * 1024 * 1024,
	count: 2048
});
export interface FileScope {
	gameId: string;
	sessionId: string;
}
export interface StoredFile {
	ref: string;
	name: string;
	mime: string;
	size: number;
	createdAt: string;
}
export interface FilePage {
	files: StoredFile[];
	nextCursor: string | null;
}
export interface FileListOptions {
	cursor?: string;
	limit?: number;
}
export interface SessionFiles {
	save(blob: Blob, options?: { name?: string }): Promise<StoredFile>;
	read(ref: string): Promise<Blob>;
	stat(ref: string): Promise<StoredFile>;
	list(options?: FileListOptions): Promise<FilePage>;
	remove(ref: string): Promise<void>;
}
export const FILE_ERRORS = [
	'FILE_NOT_FOUND',
	'FILE_QUOTA',
	'FILE_INPUT',
	'FILE_UNAVAILABLE'
] as const;
export type FileErrorCode = (typeof FILE_ERRORS)[number];
export class SessionFileError extends Error {
	constructor(public readonly code: FileErrorCode) {
		super(code);
		this.name = 'SessionFileError';
	}
}
export function fileRef(value: unknown): string {
	if (
		typeof value !== 'string' ||
		!/^helia-file:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
	) {
		throw new SessionFileError('FILE_INPUT');
	}
	return value;
}
export function fileScope(value: FileScope): FileScope {
	if (
		![value.gameId, value.sessionId].every(
			(id) => typeof id === 'string' && /^[\w-]{1,100}$/.test(id)
		)
	) {
		throw new SessionFileError('FILE_INPUT');
	}
	return { gameId: value.gameId, sessionId: value.sessionId };
}
export function fileDetails(name: unknown, mime: unknown, size: unknown) {
	if (
		typeof name !== 'string' ||
		!name.trim() ||
		name.length > 200 ||
		Array.from(name).some(
			(character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
		) ||
		typeof mime !== 'string' ||
		mime.length > 127 ||
		!Array.from(mime).every(
			(character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) <= 126
		) ||
		!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime.split(';', 1)[0].trim()) ||
		typeof size !== 'number' ||
		!Number.isSafeInteger(size) ||
		size < 0 ||
		size > FILE_LIMITS.fileBytes
	) {
		throw new SessionFileError('FILE_INPUT');
	}
	return { name, mime, size };
}
export function fileList(options: FileListOptions = {}) {
	const limit = options.limit ?? 50;
	if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
		throw new SessionFileError('FILE_INPUT');
	}
	return { limit, cursor: options.cursor === undefined ? '' : fileRef(options.cursor) };
}
export function storedFile(value: unknown): StoredFile {
	if (!value || typeof value !== 'object') {
		throw new SessionFileError('FILE_INPUT');
	}
	const row = value as Record<string, unknown>;
	if (typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt))) {
		throw new SessionFileError('FILE_INPUT');
	}
	return {
		ref: fileRef(row.ref),
		...fileDetails(row.name, row.mime, row.size),
		createdAt: row.createdAt
	};
}
export function filePage(value: unknown): FilePage {
	if (!value || typeof value !== 'object') {
		throw new SessionFileError('FILE_INPUT');
	}
	const row = value as Record<string, unknown>;
	if (!Array.isArray(row.files) || row.files.length > 100) {
		throw new SessionFileError('FILE_INPUT');
	}
	return {
		files: row.files.map(storedFile),
		nextCursor: row.nextCursor === null ? null : fileRef(row.nextCursor)
	};
}
export function displayableFile(mime: string): boolean {
	return [
		'image/png',
		'image/jpeg',
		'image/webp',
		'image/gif',
		'audio/mpeg',
		'audio/wav',
		'audio/ogg',
		'video/mp4',
		'video/webm'
	].includes(mime.split(';', 1)[0].trim());
}
