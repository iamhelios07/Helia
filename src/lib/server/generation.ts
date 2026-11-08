import type { CredentialValue } from '#lib/app/settings/credential-protocol.js';

import {
	aiError,
	AI_LIMITS,
	parseRoundRequest,
	type RoundRequest
} from '#lib/games/ai/protocol.js';
import { encodeProviderRequest } from '#lib/games/ai/providers.js';

/** Keep a suffix so credentials split across network chunks cannot escape redaction. */
export class SecretRedactor {
	private pending = '';
	private patterns: string[];
	private keep: number;
	constructor(secrets: string[]) {
		this.patterns = secrets.filter(Boolean).flatMap((s) => [s, JSON.stringify(s).slice(1, -1)]);
		this.keep = Math.max(0, ...this.patterns.map((s) => s.length - 1));
	}
	push(chunk: string, final = false): string {
		this.pending += chunk;
		for (const secret of this.patterns) {
			this.pending = this.pending.split(secret).join('[redacted]');
		}
		const length = final ? this.pending.length : Math.max(0, this.pending.length - this.keep);
		const text = this.pending.slice(0, length);
		this.pending = this.pending.slice(length);
		return text;
	}
}
interface GenerationOptions {
	signal: AbortSignal;
	emit: (chunk: string) => void;
	accessToken?: (signal: AbortSignal) => Promise<string>;
	send?: typeof fetch;
}

function authenticationHeaders(kind: CredentialValue['kind'], key: string) {
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		accept: 'text/event-stream'
	};
	if (kind === 'anthropic') {
		headers['x-api-key'] = key;
		headers['anthropic-version'] = '2023-06-01';
	} else if (kind === 'google' || kind === 'google-interactions') {
		headers['x-goog-api-key'] = key;
	} else {
		headers.authorization = `Bearer ${key}`;
	}
	return headers;
}

async function responseStream(response: Response) {
	if (!response.ok || !response.body) {
		await response.body?.cancel().catch(() => {});
		throw aiError();
	}
	const sse = response.headers.get('content-type')?.includes('text/event-stream');
	if (!sse && !response.headers.get('content-type')?.includes('application/json')) {
		await response.body.cancel().catch(() => {});
		throw aiError('protocol');
	}
	return { reader: response.body.getReader(), sse };
}

class GenerationOutput {
	private decoder = new TextDecoder('utf-8', { fatal: true });
	private redactor: SecretRedactor;
	private jsonText = '';
	constructor(
		key: string,
		private sse: boolean | undefined,
		private emit: (chunk: string) => void
	) {
		this.redactor = new SecretRedactor([key]);
	}
	push(bytes: Uint8Array) {
		const chunk = this.redactor.push(this.decoder.decode(bytes, { stream: true }));
		if (!this.sse) {
			this.jsonText += chunk;
		} else if (chunk) {
			this.emit(chunk);
		}
	}
	finish() {
		const tail = this.redactor.push(this.decoder.decode(), true);
		if (this.sse) {
			if (tail) {
				this.emit(tail);
			}
		} else {
			this.jsonText += tail;
			this.emit(`data: ${JSON.stringify({ helia_nonstream: JSON.parse(this.jsonText) })}\n\n`);
		}
	}
}

async function streamGeneration(response: Response, key: string, options: GenerationOptions) {
	const { signal, emit } = options;
	const { reader, sse } = await responseStream(response);
	const output = new GenerationOutput(key, sse, emit);
	let bytes = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (signal.aborted) {
				throw aiError('canceled');
			}
			if (next.done) {
				break;
			}
			bytes += next.value.byteLength;
			if (bytes > AI_LIMITS.outputBytes) {
				throw aiError('limit');
			}
			output.push(next.value);
		}
		output.finish();
	} catch {
		await reader.cancel().catch(() => {});
		throw aiError(signal.aborted ? 'canceled' : 'protocol');
	} finally {
		reader.releaseLock();
	}
}

export async function generateProvider(
	credential: CredentialValue,
	input: RoundRequest,
	options: GenerationOptions
): Promise<void> {
	const { signal, accessToken, send = fetch } = options;
	const { path, body } = encodeProviderRequest(parseRoundRequest(input));
	const key = credential.serviceAccount ? await accessToken?.(signal) : credential.apiKey;
	if (!key) {
		throw aiError();
	}
	let response: Response;
	try {
		response = await send(`${credential.baseUrl}${path}`, {
			method: 'POST',
			headers: authenticationHeaders(credential.kind, key),
			body: JSON.stringify(body),
			signal,
			redirect: 'error'
		});
	} catch {
		throw aiError(signal.aborted ? 'canceled' : 'provider');
	}
	await streamGeneration(response, key, options);
}
