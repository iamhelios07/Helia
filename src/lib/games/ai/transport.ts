import { Channel } from '@tauri-apps/api/core';

import { credentialRecord } from '#lib/app/settings/credential-protocol.js';
import { isDesktopBuild, isTauri } from '#lib/platform/index.js';

import {
	AI_LIMITS,
	aiError,
	type ModelGenerator,
	type RoundRequest,
	type AgentEvent
} from './protocol.js';
import { encodeProviderRequest, ProviderDecoder } from './providers.js';
import { streamTimeout } from './stream-timeout.js';

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
async function control(scope: Scope, kind: 'begin' | 'release' | 'touch'): Promise<unknown> {
	if (isDesktopBuild) {
		return nativeRequest({ ...scope, kind });
	}
	const response = await fetch('/api/ai', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ ...scope, kind }),
		keepalive: kind === 'release',
		...(kind === 'touch' ? { signal: AbortSignal.timeout(15_000) } : {})
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
): Promise<{
	lease: string;
	generate: ModelGenerator;
	release: () => Promise<void>;
	touch: () => Promise<void>;
}> {
	const scope: Scope = { gameId, sessionId };
	const begun = credentialRecord(await control(scope, 'begin'));
	if (typeof begun.lease !== 'string') {
		throw aiError('protocol');
	}
	scope.lease = begun.lease;
	return {
		lease: begun.lease,
		touch: async () => {
			await control(scope, 'touch');
		},
		release: async () => {
			await control(scope, 'release');
		},
		generate: (request, signal, emit) => generateRound(scope, request, signal, emit)
	};
}

async function generateRound(
	scope: Scope,
	request: RoundRequest,
	parent: AbortSignal,
	emit: (event: AgentEvent) => void
) {
	const idle = streamTimeout(parent),
		{ signal } = idle;
	const decoder = new ProviderDecoder(request.provider.kind, emit);
	let done = false,
		total = 0;
	const accept = (value: unknown) => {
		const item = credentialRecord(value);
		if (item.error) {
			throw aiError(item.code === 'timeout' ? 'timeout' : 'provider');
		}
		if (item.done === true) {
			done = true;
		} else if (typeof item.chunk === 'string') {
			total += item.chunk.length;
			if (total > AI_LIMITS.outputBytes) {
				throw aiError('limit');
			}
			if (item.chunk.length) {
				idle.touch();
				emit({ type: 'activity' });
			}
			decoder.push(item.chunk);
		} else if (item.activity === true) {
			idle.touch();
			emit({ type: 'activity' });
		} else {
			throw aiError('protocol');
		}
	};
	try {
		if (signal.aborted) {
			throw aiError('canceled');
		}
		const receiver = { accept, touch: idle.touch };
		if (isDesktopBuild) {
			await nativeRound(scope, request, signal, receiver);
		} else {
			await webRound(scope, request, signal, receiver);
		}
		signal.throwIfAborted();
		if (!done) {
			throw aiError('protocol');
		}
		return decoder.finish();
	} catch (error) {
		if (parent.aborted) {
			throw aiError('canceled');
		}
		if (signal.aborted) {
			throw signal.reason;
		}
		if (error === aiError('timeout').message) {
			throw aiError('timeout');
		}
		throw error;
	} finally {
		idle.dispose();
	}
}

type RoundReceiver = { accept: (value: unknown) => void; touch: () => void };
async function nativeRound(
	scope: Scope,
	request: import('./protocol.js').RoundRequest,
	signal: AbortSignal,
	{ accept }: RoundReceiver
) {
	let failure: unknown;
	let active = true;
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
					if (!active || signal.aborted || failure) {
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
		active = false;
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
	{ accept, touch }: RoundReceiver
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
	touch();
	const reader = response.body.getReader(),
		utf8 = new TextDecoder('utf-8', { fatal: true });
	let pending = '';
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) {
				break;
			}
			if (chunk.value.byteLength) {
				touch();
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
