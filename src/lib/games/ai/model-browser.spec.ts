import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { callSessionModel } from './model-browser.js';
import { modelMessages, parseModelCall } from './model-call.js';
import { encodeProviderRequest } from './providers.js';

const mocks = vi.hoisted(() => ({
	load: vi.fn(),
	begin: vi.fn(),
	generate: vi.fn(),
	release: vi.fn()
}));
vi.mock('#lib/app/settings/repository.js', () => ({ loadAISettings: mocks.load }));
vi.mock('./transport.js', () => ({ beginGeneration: mocks.begin }));
const messages = [{ role: 'user', content: 'Only this input' }];
beforeEach(() => {
	mocks.load.mockResolvedValue({
		defaultModelId: 'main',
		auxiliaryModelId: 'aux',
		providers: [{ id: 'provider', kind: 'google', baseUrl: 'https://example.com' }],
		models: [
			{ id: 'main', providerId: 'provider', modelId: 'main-id' },
			{ id: 'aux', providerId: 'provider', modelId: 'aux-id', maxOutputTokens: 1234 }
		]
	});
	mocks.begin.mockResolvedValue({
		lease: 'lease',
		generate: mocks.generate,
		release: mocks.release
	});
	mocks.release.mockResolvedValue(undefined);
	mocks.generate.mockResolvedValue({ text: 'Answer', calls: [] });
});
afterEach(() => vi.resetAllMocks());

it('uses only supplied messages and selected model settings, without loading session or prompt context', async () => {
	expect(await callSessionModel('game', 'session', { model: 'auxiliary', messages })).toEqual({
		content: [{ type: 'text', text: 'Answer' }],
		toolCalls: []
	});
	const request = mocks.generate.mock.calls[0][0];
	expect(request).toMatchObject({ model: 'aux-id', maxTokens: 1234, messages, tools: [] });
	expect(request).not.toHaveProperty('temperature');
	expect(mocks.release).toHaveBeenCalledOnce();
	await callSessionModel('game', 'session', { messages });
	expect(mocks.generate.mock.calls[1][0].model).toBe('main-id');
});
it('returns media and tool calls without executing them and preserves continuation and usage', async () => {
	const content = [{ type: 'image', mimeType: 'image/png', data: 'AA==' }];
	const calls = [{ id: 'call', name: 'custom', arguments: { value: 2 } }];
	const native = [
		{ inlineData: { mimeType: 'image/png', data: 'AA==' }, thoughtSignature: 'keep' }
	];
	mocks.generate.mockResolvedValue({
		text: '',
		calls,
		content,
		native,
		usage: { inputTokens: 5, outputTokens: 10 }
	});
	const result = await callSessionModel('game', 'session', {
		messages,
		tools: [
			{ name: 'custom', arguments: { type: 'object', properties: {}, additionalProperties: false } }
		]
	});
	expect(result).toEqual({
		content,
		toolCalls: calls,
		continuation: { provider: 'google', model: 'main-id', data: native },
		usage: { inputTokens: 5, outputTokens: 10 }
	});
	expect(mocks.generate).toHaveBeenCalledOnce();
	const continuation = parseModelCall({
		messages: [
			...messages,
			{ role: 'assistant', ...result },
			{ role: 'tool', toolCallId: 'call', content: '{"ok":true}' }
		]
	});
	const wire = encodeProviderRequest({
		provider: { id: 'provider', kind: 'google', baseUrl: 'https://example.com' },
		model: 'main-id',
		maxTokens: 100,
		tools: [],
		messages: modelMessages(continuation.messages, 'google', 'main-id')
	});
	expect(JSON.stringify(wire)).toContain('keep');
	expect(() => modelMessages(continuation.messages, 'google', 'other-model')).toThrow();
});
it('never silently falls back to the main model when auxiliary is unset', async () => {
	mocks.load.mockResolvedValue({ models: [], providers: [], defaultModelId: 'main' });
	await expect(callSessionModel('g', 's', { model: 'auxiliary', messages })).rejects.toThrow(
		'보조 모델'
	);
	expect(mocks.begin).not.toHaveBeenCalled();
});
it('releases the lease on provider failure and on disposal while a request is running', async () => {
	mocks.generate.mockRejectedValueOnce(Error('provider failed'));
	await expect(callSessionModel('g', 's', { messages })).rejects.toThrow('provider failed');
	expect(mocks.release).toHaveBeenCalledOnce();
	const abort = new AbortController();
	mocks.generate.mockImplementationOnce(async () => {
		abort.abort();
		return { text: 'late', calls: [] };
	});
	await expect(callSessionModel('g', 's', { messages }, { signal: abort.signal })).rejects.toThrow(
		'중단'
	);
	expect(mocks.release.mock.calls.length).toBeGreaterThanOrEqual(2);
});
it.each([
	{ model: 'other', messages },
	{ messages: [] },
	{ messages, temperature: 1 },
	{ messages: [{ role: 'tool', content: 'orphan', toolCallId: 'unknown' }] },
	{
		messages: [{ role: 'user', content: [{ type: 'image', mimeType: 'audio/wav', data: 'AA==' }] }]
	},
	{
		messages: [{ role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: 'bad!' }] }]
	}
])('rejects malformed requests before acquiring a lease: %j', async (input) => {
	await expect(callSessionModel('g', 's', input)).rejects.toThrow();
	expect(mocks.begin).not.toHaveBeenCalled();
});
