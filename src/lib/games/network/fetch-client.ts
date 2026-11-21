/** HTTP byte-stream client for the trusted logic Worker. */
type SendFetch = (message: unknown, ports: MessagePort[]) => void;
type FetchMessage =
	| {
			kind: 'head';
			url: string;
			redirected: boolean;
			body: boolean;
			status: number;
			statusText: string;
			headers: [string, string][];
	  }
	| { kind: 'chunk'; data: Uint8Array }
	| { kind: 'end' }
	| { kind: 'error'; message: string };

export function createFetchClient(send: SendFetch) {
	const jobs = new Set<FetchRequest>();
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const request = validateRequest(input, init);
		if (jobs.size >= 16) {
			throw new TypeError('Too many fetch requests');
		}
		const job = new FetchRequest(request, send, () => jobs.delete(job));
		jobs.add(job);
		return job.run();
	};
	return {
		fetch,
		dispose() {
			for (const job of [...jobs]) {
				job.close(new DOMException('Runtime closed', 'AbortError'));
			}
		}
	};
}
function validateRequest(input: RequestInfo | URL, init?: RequestInit): Request {
	new URL(input instanceof Request ? input.url : String(input));
	const request = new Request(input, init);
	if (
		request.credentials === 'include' ||
		request.integrity ||
		request.keepalive ||
		['no-cors', 'same-origin'].includes(request.mode)
	) {
		throw new TypeError('Fetch option unavailable');
	}
	const url = new URL(request.url);
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
		throw new TypeError('Fetch requires an absolute HTTP(S) URL');
	}
	request.signal.throwIfAborted();
	return request;
}
class FetchRequest {
	private readonly channel = new MessageChannel();
	private readonly head = Promise.withResolvers<Response>();
	private readonly stream: ReadableStream<Uint8Array>;
	private controller!: ReadableStreamDefaultController<Uint8Array>;
	private upload?: ReadableStreamDefaultReader<Uint8Array>;
	private settled = false;
	private closed = false;
	private size = 0;
	constructor(
		private request: Request,
		private send: SendFetch,
		private onclose: () => void
	) {
		void this.head.promise.catch(() => {});
		request.signal.addEventListener('abort', this.aborted, { once: true });
		this.stream = new ReadableStream<Uint8Array>(
			{
				start: (value) => {
					this.controller = value;
				},
				pull: () => {
					if (this.settled && !this.closed) {
						this.channel.port1.postMessage({ kind: 'pull' });
					}
				},
				cancel: () => this.close()
			},
			{ highWaterMark: 0 }
		);
		this.channel.port1.onmessage = (event) => this.receive(event.data);
		this.channel.port1.start();
	}
	private aborted = () => this.close(this.request.signal.reason);
	close(error?: unknown) {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.channel.port1.postMessage({ kind: 'cancel' });
		this.channel.port1.close();
		this.channel.port2.close();
		void this.upload?.cancel().catch(() => {});
		this.request.signal.removeEventListener('abort', this.aborted);
		this.onclose();
		if (error !== undefined) {
			if (this.settled) {
				this.controller.error(error);
			} else {
				this.head.reject(error);
			}
		}
	}
	private receive(message: FetchMessage) {
		try {
			if (message.kind === 'head') {
				const response = metadata(
					new Response(message.body ? this.stream : null, message),
					message
				);
				this.settled = true;
				this.head.resolve(response);
				if (!message.body) {
					this.close();
				}
			} else if (message.kind === 'chunk') {
				this.size += message.data.byteLength;
				if (this.size > 33554432) {
					throw new TypeError('Fetch response too large');
				}
				this.controller.enqueue(message.data);
			} else if (message.kind === 'end') {
				this.controller.close();
				this.close();
			} else if (message.kind === 'error') {
				this.close(new TypeError(message.message ?? 'Fetch failed'));
			}
		} catch (error) {
			this.close(error);
		}
	}
	async run(): Promise<Response> {
		try {
			let body: Blob | null = null;
			if (this.request.body) {
				this.upload = this.request.body.getReader();
				body = await uploadBody(this.upload, this.request.signal);
				this.upload = undefined;
			}
			this.request.signal.throwIfAborted();
			if (this.closed) {
				throw new DOMException('Runtime closed', 'AbortError');
			}
			const { url, method, headers, redirect } = this.request;
			this.send(
				{ kind: 'fetch', request: { url, method, headers: [...headers], body, redirect } },
				[this.channel.port2]
			);
		} catch (error) {
			this.close(error);
		}
		return this.head.promise;
	}
}
function metadata(response: Response, info: { url: string; redirected: boolean }): Response {
	Object.defineProperties(response, {
		url: { value: info.url },
		redirected: { value: info.redirected },
		type: { value: 'basic' }
	});
	const clone = response.clone.bind(response);
	Object.defineProperty(response, 'clone', { value: () => metadata(clone(), info) });
	return response;
}
async function uploadBody(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	signal: AbortSignal
): Promise<Blob> {
	const chunks: Uint8Array<ArrayBuffer>[] = [];
	let size = 0;
	try {
		for (;;) {
			signal.throwIfAborted();
			const part = await reader.read();
			if (part.done) {
				break;
			}
			size += part.value.byteLength;
			if (size > 8388608) {
				throw new TypeError('Fetch request too large');
			}
			chunks.push(part.value.slice());
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	return new Blob(chunks);
}
