import {
	aiError,
	AI_LIMITS,
	parseRoundRequest,
	type RoundRequest
} from '#lib/games/ai/protocol.js';
import { encodeProviderRequest } from '#lib/games/ai/providers.js';
import type { CredentialValue } from '#lib/app/settings/credential-protocol.js';

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
		for (const secret of this.patterns)
			this.pending = this.pending.split(secret).join('[redacted]');
		const length = final ? this.pending.length : Math.max(0, this.pending.length - this.keep);
		const text = this.pending.slice(0, length);
		this.pending = this.pending.slice(length);
		return text;
	}
}
export async function generateProvider(
	credential: CredentialValue,
	input: RoundRequest,
	signal: AbortSignal,
	emit: (chunk: string) => void,
	accessToken?: (signal: AbortSignal) => Promise<string>,
	send: typeof fetch = fetch
): Promise<void> {
	const request = parseRoundRequest(input),
		{ path, body } = encodeProviderRequest(request);
	const key = credential.serviceAccount ? await accessToken?.(signal) : credential.apiKey;
	if (!key) throw aiError();
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		accept: 'text/event-stream'
	};
	if (credential.kind === 'anthropic') {
		headers['x-api-key'] = key;
		headers['anthropic-version'] = '2023-06-01';
	} else if (credential.kind === 'google' || credential.kind === 'google-interactions')
		headers['x-goog-api-key'] = key;
	else headers.authorization = `Bearer ${key}`;
	let response: Response;
	try {
		response = await send(`${credential.baseUrl}${path}`, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			signal,
			redirect: 'error'
		});
	} catch {
		throw aiError(signal.aborted ? 'canceled' : 'provider');
	}
	if (!response.ok || !response.body) {
		await response.body?.cancel().catch(() => {});
		throw aiError();
	}
	const sse = response.headers.get('content-type')?.includes('text/event-stream');
	if (!sse && !response.headers.get('content-type')?.includes('application/json')) {
		await response.body.cancel().catch(() => {});
		throw aiError('protocol');
	}
	const reader = response.body.getReader(),
		decoder = new TextDecoder('utf-8', { fatal: true }),
		redactor = new SecretRedactor([key]);
	let bytes = 0;
	let jsonText = '';
	try {
		while (true) {
			const next = await reader.read();
			if (signal.aborted) throw aiError('canceled');
			if (next.done) break;
			bytes += next.value.byteLength;
			if (bytes > AI_LIMITS.outputBytes) throw aiError('limit');
			const chunk = redactor.push(decoder.decode(next.value, { stream: true }));
			if (sse) {
				if (chunk) emit(chunk);
			} else jsonText += chunk;
		}
		const tail = redactor.push(decoder.decode(), true);
		if (sse) {
			if (tail) emit(tail);
		} else {
			jsonText += tail;
			emit(`data: ${JSON.stringify({ helia_nonstream: JSON.parse(jsonText) })}\n\n`);
		}
	} catch {
		await reader.cancel().catch(() => {});
		throw aiError(signal.aborted ? 'canceled' : 'protocol');
	} finally {
		reader.releaseLock();
	}
}
