export const MEDIA_CHUNK_SIZE = 1024 * 1024;
export interface EditBlobResult {
	kind: 'blob';
	blobId: string;
	assetHash: string;
	sha256: string;
	size: number;
	mime: string;
}
export function isMediaHash(value: unknown): value is string {
	return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

/** Large request bodies (§3.9) travel as a `document` upload instead of inline JSON.
 * releaseCreate is reserved; the client does not use it yet (아직 클라이언트가 쓰지 않음).
 */
export type DocumentOperation = 'draftSave' | 'commit' | 'releaseCreate';
export const DOCUMENT_MIME = 'application/json';
export interface DocumentUploadResult {
	kind: 'upload';
	ref: string;
	sha256: string;
	size: number;
	mime: string;
	crc32: number;
}
export const BODY_REF_PREFIX = 'helia-upload:';
/** Returns the upload id carried by a `helia-upload:<id>` reference, or undefined. */
export function bodyRefId(value: unknown): string | undefined {
	if (typeof value !== 'string' || !value.startsWith(BODY_REF_PREFIX)) {
		return undefined;
	}
	const id = value.slice(BODY_REF_PREFIX.length);
	return id.length > 0 ? id : undefined;
}
/** Keep this mapping paired with media_uploads.rs::document_operation. */
export function documentOperation(kind: unknown): DocumentOperation | undefined {
	if (kind === 'writeDraft') {
		return 'draftSave';
	}
	if (kind === 'commit') {
		return 'commit';
	}
	return undefined;
}
