import { messageFrameDocument } from './message-frame-document.js';

export interface MessageAppearance {
	color?: string;
	fontFamily?: string;
}

/** Presentation-only channel. No state, credentials, Actions or host executor are exposed. */
export class MessageFrame {
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
	private fail = () => {
		this.dispose();
		this.onfailure();
	};
	/** Accepts converted markup; the receiving frame sanitizes it before insertion. */
	update(html: string, appearance?: MessageAppearance) {
		if (this.disposed) {
			return;
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
