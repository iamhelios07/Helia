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
