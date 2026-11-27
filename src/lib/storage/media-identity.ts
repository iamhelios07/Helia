import { Crc32 } from '../games/package/zip.js';
import { Sha256 } from '../games/state/sha256.js';

const encoder = new TextEncoder();
// A multiple of three, small enough for fromCharCode's argument limit.
const encodingBlock = 12_288;

/** Standard padded base64, with at most two bytes retained between updates. */
export class Base64Stream {
	private pending = new Uint8Array(0);
	private finished = false;

	constructor(private emit: (text: string) => void) {}

	update(bytes: Uint8Array): void {
		if (this.finished) {
			throw Error('Base64 already finalized');
		}
		let offset = 0;
		if (this.pending.length) {
			const count = Math.min(3 - this.pending.length, bytes.length);
			const joined = new Uint8Array(this.pending.length + count);
			joined.set(this.pending);
			joined.set(bytes.subarray(0, count), this.pending.length);
			if (joined.length < 3) {
				this.pending = joined;
				return;
			}
			this.write(joined);
			this.pending = new Uint8Array(0);
			offset = count;
		}
		const end = bytes.length - ((bytes.length - offset) % 3);
		while (offset < end) {
			const next = Math.min(end, offset + encodingBlock);
			this.write(bytes.subarray(offset, next));
			offset = next;
		}
		this.pending = bytes.slice(end);
	}

	finish(): void {
		if (this.finished) {
			return;
		}
		this.finished = true;
		if (this.pending.length) {
			this.write(this.pending);
			this.pending = new Uint8Array(0);
		}
	}

	private write(bytes: Uint8Array): void {
		this.emit(btoa(String.fromCharCode(...bytes)));
	}
}

export interface MediaIdentityResult {
	raw: string;
	crc: number;
	blobId: string;
	assetHash: string;
}

/** One ordered pass over media bytes; MIME is the authoritative resource MIME. */
export class MediaIdentity {
	private raw = new Sha256();
	private crc = new Crc32();
	private blob = new Sha256();
	private asset = new Sha256();
	private base64 = new Base64Stream((text) => {
		const bytes = encoder.encode(text);
		this.blob.update(bytes);
		this.asset.update(bytes);
	});
	private result?: MediaIdentityResult;

	constructor(gameId: string, mime: string) {
		const prefix = JSON.stringify(`data:${mime};base64,`).slice(0, -1);
		this.blob.update(encoder.encode(`[${JSON.stringify(gameId)},${prefix}`));
		this.asset.update(encoder.encode(prefix));
	}

	update(bytes: Uint8Array): this {
		if (this.result) {
			throw Error('Media identity already finalized');
		}
		this.raw.update(bytes);
		this.crc.update(bytes);
		this.base64.update(bytes);
		return this;
	}

	digest(): MediaIdentityResult {
		if (!this.result) {
			this.base64.finish();
			this.blob.update(encoder.encode('"]'));
			this.asset.update(encoder.encode('"'));
			this.result = {
				raw: this.raw.digest(),
				crc: this.crc.digest(),
				blobId: this.blob.digest(),
				assetHash: this.asset.digest()
			};
		}
		return { ...this.result };
	}
}
