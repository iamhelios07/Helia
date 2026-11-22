import {
	fetchWithPermission,
	type FetchResult,
	type NetworkPermission
} from '#lib/games/network/fetch.js';
import { NetworkPermissions } from '#lib/games/network/permissions.js';
import { encodeBytes, NETWORK_LIMITS, type NetworkRequest } from '#lib/games/network/protocol.js';

import { networkHop } from './transport.js';

/** One dedicated port per response keeps binary streams outside the JSON state channel. */
class FetchJob {
	readonly abort = new AbortController();
	private timer?: ReturnType<typeof setTimeout>;
	private reader?: ReadableStreamDefaultReader<Uint8Array>;
	private pulling = false;
	constructor(
		private port: MessagePort,
		private onclose: () => void,
		private onactivity: () => void
	) {
		port.onmessage = (event) => {
			if (event.data?.kind === 'cancel') {
				this.close();
			} else if (event.data?.kind === 'pull') {
				void this.pull();
			}
		};
		port.start();
		this.touch();
	}
	private touch() {
		this.onactivity();
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.fail(), NETWORK_LIMITS.idleMs);
	}
	close() {
		if (this.abort.signal.aborted) {
			return;
		}
		clearTimeout(this.timer);
		this.abort.abort();
		void this.reader?.cancel().catch(() => {});
		this.port.close();
		this.onclose();
	}
	fail() {
		if (this.abort.signal.aborted) {
			return;
		}
		this.port.postMessage({ kind: 'error', message: 'Fetch failed' });
		this.close();
	}
	respond({ response, url, redirected }: FetchResult) {
		if (this.abort.signal.aborted) {
			void response.body?.cancel();
			return;
		}
		this.reader = response.body?.getReader();
		this.port.postMessage({
			kind: 'head',
			status: response.status,
			statusText: response.statusText,
			headers: [...response.headers],
			url,
			redirected,
			body: !!this.reader
		});
		this.touch();
		if (!this.reader) {
			this.close();
		}
	}
	private async pull() {
		if (!this.reader || this.pulling || this.abort.signal.aborted) {
			return;
		}
		this.pulling = true;
		try {
			const part = await this.reader.read();
			if (this.abort.signal.aborted) {
				return;
			}
			this.touch();
			if (part.done) {
				this.port.postMessage({ kind: 'end' });
				this.close();
			} else {
				// A reader may return a slice of a larger backing buffer. Transfer only its bytes.
				const data = part.value.slice();
				this.port.postMessage({ kind: 'chunk', data }, [data.buffer]);
			}
		} catch {
			this.fail();
		} finally {
			this.pulling = false;
		}
	}
}
export class FetchBridge {
	private readonly jobs = new Set<FetchJob>();
	private readonly permissions: NetworkPermissions;
	private readonly lifetime = new AbortController();
	constructor(
		permission: NetworkPermission,
		private activity = () => {},
		private change: (pending: number) => void = () => {},
		private send = networkHop
	) {
		this.permissions = new NetworkPermissions(permission);
	}
	receive(event: MessageEvent<unknown>): boolean {
		if (
			!event.data ||
			typeof event.data !== 'object' ||
			!('kind' in event.data) ||
			event.data.kind !== 'fetch'
		) {
			return false;
		}
		const port = event.ports[0];
		if (!port) {
			return true;
		}
		if (this.lifetime.signal.aborted || this.jobs.size >= NETWORK_LIMITS.pending) {
			port.postMessage({ kind: 'error', message: 'Fetch unavailable' });
			port.close();
			return true;
		}
		const job = new FetchJob(
			port,
			() => {
				this.jobs.delete(job);
				this.change(this.jobs.size);
			},
			this.activity
		);
		this.jobs.add(job);
		this.change(this.jobs.size);
		void this.run(job, event.data);
		return true;
	}
	private async run(job: FetchJob, value: object) {
		try {
			const input = value as Record<string, unknown>;
			if (!input.request || typeof input.request !== 'object') {
				throw new TypeError('Invalid fetch');
			}
			const request = input.request as Omit<NetworkRequest, 'body'> & {
				body: Blob | null;
				redirect: RequestRedirect;
			};
			if (
				!['follow', 'error', 'manual'].includes(request.redirect) ||
				(request.body !== null &&
					(!(request.body instanceof Blob) || request.body.size > NETWORK_LIMITS.requestBytes))
			) {
				throw new TypeError('Invalid fetch');
			}
			job.respond(
				await fetchWithPermission(
					{
						...request,
						body:
							request.body === null
								? null
								: encodeBytes(new Uint8Array(await request.body.arrayBuffer()))
					},
					job.abort.signal,
					this.permissions.allow,
					this.send
				)
			);
		} catch {
			job.fail();
		}
	}
	dispose() {
		this.lifetime.abort();
		for (const job of this.jobs) {
			job.close();
		}
		this.jobs.clear();
		this.permissions.dispose();
	}
}
