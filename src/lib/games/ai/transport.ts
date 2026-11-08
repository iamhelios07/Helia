import { Channel } from '@tauri-apps/api/core';

import { credentialRecord } from '#lib/app/settings/credential-protocol.js';
import { isDesktopBuild, isTauri } from '#lib/platform/index.js';

import { AI_LIMITS, aiError, type ModelGenerator } from './protocol.js';
import { encodeProviderRequest, ProviderDecoder } from './providers.js';

type Scope = { gameId: string; sessionId: string; lease?: string };
async function nativeRequest(input: unknown, onChunk?: (value: unknown) => void): Promise<unknown> {
	if (!isTauri() || window !== window.top) {
		throw aiError();
	}
	const host: unknown = Reflect.get(window, '__HELIA_AI__');
	if (typeof host !== 'function') {
		throw aiError();
	}
	const channel = new Channel<unknown>();
	channel.onmessage = (value) => onChunk?.(value);
	return host(input, channel);
}
async function control(scope: Scope, kind: 'begin' | 'release'): Promise<unknown> {
	if (isDesktopBuild) {
		return nativeRequest({ ...scope, kind });
	}
	const response = await fetch('/api/ai', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ ...scope, kind }),
		keepalive: kind === 'release'
	});
	const result: unknown = await response.json().catch(() => null);
	if (!response.ok) {
		throw new Error(
			typeof credentialRecord(result).error === 'string'
				? String(credentialRecord(result).error)
				: aiError().message
		);
	}
	return result;
}
export async function beginGeneration(
	gameId: string,
	sessionId: string
): Promise<{ lease: string; generate: ModelGenerator; release: () => Promise<void> }> {
	const scope: Scope = { gameId, sessionId };
	const begun = credentialRecord(await control(scope, 'begin'));
	if (typeof begun.lease !== 'string') {
		throw aiError('protocol');
	}
	scope.lease = begun.lease;
	return {
		lease: begun.lease,
		release: async () => {
			await control(scope, 'release');
		},
		generate: async (request, signal, emit) => {
			if (signal.aborted) {
				throw aiError('canceled');
			}
			const decoder = new ProviderDecoder(request.provider.kind, emit);
			let done = false,
				total = 0;
			const accept = (value: unknown) => {
				const item = credentialRecord(value);
				if (item.error) {
					throw aiError();
				}
				if (item.done === true) {
					done = true;
				} else if (typeof item.chunk === 'string') {
					total += item.chunk.length;
					if (total > AI_LIMITS.outputBytes) {
						throw aiError('limit');
					}
					decoder.push(item.chunk);
				} else {
					throw aiError('protocol');
				}
			};
			if (isDesktopBuild) {
				await nativeRound(scope, request, signal, accept);
			} else {
				await webRound(scope, request, signal, accept);
			}
			if (signal.aborted) {
				throw aiError('canceled');
			}
			if (!done) {
				throw aiError('protocol');
			}
			return decoder.finish();
		}
	};
}

async function nativeRound(
	scope: Scope,
	request: import('./protocol.js').RoundRequest,
	signal: AbortSignal,
	accept: (value: unknown) => void
) {
	let failure: unknown;
	let rejectCanceled: (reason: Error) => void = () => {};
	const canceled = new Promise<never>((_resolve, reject) => {
		rejectCanceled = reject;
	});
	const stop = () => {
		void control(scope, 'release').catch(() => {});
		rejectCanceled(aiError('canceled'));
	};
	signal.addEventListener('abort', stop, { once: true });
	try {
		await Promise.race([
			nativeRequest(
				{ ...scope, kind: 'round', request, wire: encodeProviderRequest(request) },
				(value) => {
					if (signal.aborted || failure) {
						return;
					}
					try {
						accept(value);
					} catch (error) {
						failure = error;
						stop();
					}
				}
			),
			canceled
		]);
	} finally {
		signal.removeEventListener('abort', stop);
	}
	if (failure) {
		throw failure;
	}
}
async function webRound(
	scope: Scope,
	request: import('./protocol.js').RoundRequest,
	signal: AbortSignal,
	accept: (value: unknown) => void
) {
	const response = await fetch('/api/ai', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ ...scope, kind: 'round', request }),
		signal
	});
	if (!response.ok || !response.body) {
		throw aiError();
	}
	const reader = response.body.getReader(),
		utf8 = new TextDecoder('utf-8', { fatal: true });
	let pending = '';
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) {
				break;
			}
			pending += utf8.decode(chunk.value, { stream: true });
			if (pending.length > AI_LIMITS.outputBytes) {
				throw aiError('limit');
			}
			pending = consumeLines(pending, accept);
		}
		pending += utf8.decode();
		if (pending.trim()) {
			throw aiError('protocol');
		}
	} catch (error) {
		await reader.cancel().catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}
}

function consumeLines(pending: string, accept: (value: unknown) => void): string {
	let end: number;
	while ((end = pending.indexOf('\n')) !== -1) {
		const line = pending.slice(0, end);
		pending = pending.slice(end + 1);
		if (line) {
			accept(JSON.parse(line));
		}
	}
	return pending;
}
