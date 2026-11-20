import type { SessionFileAccess } from '../files/client.js';

import { displayableFile, fileRef, FILE_LIMITS } from '../files/model.js';
import { messageFrameDocument } from './message-frame-document.js';

export interface MessageAppearance {
	color?: string;
	fontFamily?: string;
}

/** Presentation-only channel. No state, credentials, Actions or host executor are exposed. */
export class MessageFrame {
	private files: SessionFileAccess | undefined;
	private unsubscribeFiles: (() => void) | undefined;
	private reading = new Set<number>();
	private readonly token = crypto.randomUUID();
	private readonly channel = new MessageChannel();
	private connected = false;
	private disposed = false;
	private pending: { html: string; appearance: Record<string, string> } | undefined;
	private scheduled = 0;
	private readonly timeout: ReturnType<typeof setTimeout>;
	constructor(
		private frame: HTMLIFrameElement,
		private onfailure: () => void,
		private onresize: (heightChange: number) => void = () => {}
	) {
		window.addEventListener('message', this.connect);
		this.channel.port1.onmessage = this.receive;
		this.channel.port1.start();
		this.timeout = setTimeout(this.fail, 5000);
		frame.srcdoc = messageFrameDocument(this.token);
	}
	private connect = (event: MessageEvent<unknown>) => {
		if (this.disposed || this.connected || event.source !== this.frame.contentWindow) {
			return;
		}
		const value = event.data;
		if (!value || typeof value !== 'object' || !('token' in value) || !('kind' in value)) {
			return;
		}
		if (value.kind !== 'helia-message-ready' || value.token !== this.token) {
			return;
		}
		clearTimeout(this.timeout);
		window.removeEventListener('message', this.connect);
		this.frame.contentWindow?.postMessage({ token: this.token }, '*', [this.channel.port2]);
		this.connected = true;
		this.flush();
	};
	private receive = (event: MessageEvent<unknown>) => {
		if (this.disposed) {
			return;
		}
		const value = event.data;
		if (
			value &&
			typeof value === 'object' &&
			'kind' in value &&
			value.kind === 'file' &&
			'ref' in value &&
			'id' in value
		) {
			void this.readFile(value.ref, value.id);
			return;
		}
		if (!value || typeof value !== 'object' || !('kind' in value) || !('height' in value)) {
			return;
		}
		if (
			value.kind !== 'height' ||
			typeof value.height !== 'number' ||
			!Number.isFinite(value.height)
		) {
			return;
		}
		const height = Math.min(2400, Math.max(20, value.height));
		const change = height - this.frame.getBoundingClientRect().height;
		this.frame.style.height = `${height}px`;
		if (change !== 0) {
			this.onresize(change);
		}
	};
	private async readFile(input: unknown, id: unknown) {
		if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) {
			return;
		}
		let ref: string;
		try {
			ref = fileRef(input);
		} catch {
			return;
		}
		if (this.reading.has(id)) {
			return;
		}
		if (this.reading.size >= 16) {
			this.channel.port1.postMessage({ kind: 'file', ref, id, error: true });
			return;
		}
		this.reading.add(id);
		const files = this.files;
		try {
			if (!files) {
				throw Error('FILE_NOT_FOUND');
			}
			const blob = await files.read(ref);
			if (blob.size > FILE_LIMITS.fileBytes || !displayableFile(blob.type)) {
				throw Error('FILE_UNSUPPORTED_MEDIA');
			}
			if (!this.disposed && files === this.files) {
				this.channel.port1.postMessage({ kind: 'file', ref, id, blob });
			}
		} catch {
			if (!this.disposed && files === this.files) {
				this.channel.port1.postMessage({ kind: 'file', ref, id, error: true });
			}
		} finally {
			this.reading.delete(id);
		}
	}
	private fail = () => {
		this.dispose();
		this.onfailure();
	};
	/** Accepts converted markup; the receiving frame sanitizes it before insertion. */
	update(html: string, appearance?: MessageAppearance, files?: SessionFileAccess) {
		if (this.disposed) {
			return;
		}
		if (files !== this.files) {
			this.unsubscribeFiles?.();
			this.files = files;
			if (this.connected) {
				this.channel.port1.postMessage({ kind: 'files-reset' });
			}
			this.unsubscribeFiles = files?.subscribe((ref) => {
				if (this.connected && !this.disposed) {
					this.channel.port1.postMessage({ kind: 'files-changed', ref });
				}
			});
		}
		const computed = getComputedStyle(this.frame);
		this.pending = {
			html,
			appearance: {
				color: appearance?.color ?? computed.color,
				fontFamily: appearance?.fontFamily ?? computed.fontFamily,
				fontSize: computed.fontSize,
				lineHeight: computed.lineHeight,
				colorScheme: computed.colorScheme
			}
		};
		if (!this.scheduled) {
			this.scheduled = requestAnimationFrame(this.flush);
		}
	}
	private flush = () => {
		cancelAnimationFrame(this.scheduled);
		this.scheduled = 0;
		if (this.disposed || !this.connected || !this.pending) {
			return;
		}
		this.channel.port1.postMessage({ kind: 'content', ...this.pending });
		this.pending = undefined;
	};
	dispose = () => {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.unsubscribeFiles?.();
		clearTimeout(this.timeout);
		cancelAnimationFrame(this.scheduled);
		window.removeEventListener('message', this.connect);
		if (this.connected) {
			this.channel.port1.postMessage({ kind: 'dispose' });
		}
		this.channel.port1.close();
		this.channel.port2.close();
	};
}
