import { expect, it, vi } from 'vitest';
import { discoverModels } from './model-catalog.js';
import { SERVICE_PRESETS } from '#lib/app/settings/services.js';

const credential = {
	id: 'connection',
	kind: 'openai-compatible' as const,
	baseUrl: 'https://example.com/v1',
	apiKey: 'test-only-secret'
};

it.each(SERVICE_PRESETS.filter((preset) => preset.kind === 'openai-compatible' && preset.baseUrl))(
	'reads $name models through the shared authenticated adapter',
	async (preset) => {
		const send = vi
			.fn<typeof fetch>()
			.mockResolvedValue(Response.json({ data: [{ id: 'vendor/model', name: 'Provider model' }] }));
		const models = await discoverModels(
			{ ...credential, baseUrl: preset.baseUrl },
			undefined,
			send
		);
		expect(models).toEqual([{ id: 'vendor/model', name: 'Provider model' }]);
		expect(String(send.mock.calls[0][0])).toBe(`${preset.baseUrl}/models`);
		expect(send.mock.calls[0][1]).toMatchObject({
			headers: { authorization: `Bearer ${credential.apiKey}` },
			redirect: 'error'
		});
	}
);
it('uses bearer authentication and rejects redirects before credentials can reach another endpoint', async () => {
	const send = vi
		.fn<typeof fetch>()
		.mockResolvedValue(Response.json({ data: [{ id: 'model-a', name: 'Model A' }] }));
	expect(await discoverModels(credential, undefined, send)).toEqual([
		{ id: 'model-a', name: 'Model A' }
	]);
	expect(String(send.mock.calls[0][0])).toBe('https://example.com/v1/models');
	expect(send.mock.calls[0][1]).toMatchObject({
		redirect: 'error',
		headers: { authorization: 'Bearer test-only-secret' }
	});
});

it('keeps Vertex model registration manual without calling a generic list endpoint', async () => {
	const send = vi.fn<typeof fetch>();
	await expect(
		discoverModels({ ...credential, kind: 'google-vertex' }, undefined, send)
	).rejects.toThrow('모델 ID를 직접');
	expect(send).not.toHaveBeenCalled();
});
it('follows Google page tokens, filters embedding models, and normalizes resource IDs', async () => {
	const send = vi
		.fn<typeof fetch>()
		.mockResolvedValueOnce(
			Response.json({
				models: [
					{
						name: 'models/generative',
						displayName: 'Generative',
						supportedGenerationMethods: ['generateContent']
					},
					{ name: 'models/embedding', supportedGenerationMethods: ['embedContent'] }
				],
				nextPageToken: 'next-page'
			})
		)
		.mockResolvedValueOnce(
			Response.json({ models: [{ name: 'models/second', description: 'Another model' }] })
		);
	expect(await discoverModels({ ...credential, kind: 'google' }, undefined, send)).toEqual([
		{ id: 'generative', name: 'Generative' },
		{ id: 'second', name: 'models/second', description: 'Another model' }
	]);
	expect(String(send.mock.calls[1][0])).toContain('pageToken=next-page');
	expect(send.mock.calls[0][1]?.headers).toMatchObject({ 'x-goog-api-key': credential.apiKey });
	expect(String(send.mock.calls[0][0])).not.toContain(credential.apiKey);
});
it('follows Anthropic cursors and removes duplicate model IDs', async () => {
	const send = vi
		.fn<typeof fetch>()
		.mockResolvedValueOnce(
			Response.json({
				data: [{ id: 'model-a', display_name: 'Model A' }],
				has_more: true,
				last_id: 'model-a'
			})
		)
		.mockResolvedValueOnce(
			Response.json({
				data: [{ id: 'model-a', display_name: 'Model A' }, { id: 'model-b' }],
				has_more: false
			})
		);
	expect(await discoverModels({ ...credential, kind: 'anthropic' }, undefined, send)).toHaveLength(
		2
	);
	expect(String(send.mock.calls[1][0])).toContain('after_id=model-a');
	expect(send.mock.calls[0][1]?.headers).toMatchObject({
		'x-api-key': credential.apiKey,
		'anthropic-version': '2023-06-01'
	});
});
it('never exposes provider error bodies, response-reflected secrets, or malformed catalog entries', async () => {
	const send = vi.fn<typeof fetch>();
	for (const response of [
		Response.json({ error: credential.apiKey }, { status: 401 }),
		Response.json({ data: [{ id: credential.apiKey }] }),
		Response.json({ data: [{ id: 123 }] })
	]) {
		send.mockResolvedValueOnce(response);
		try {
			await discoverModels(credential, undefined, send);
			throw new Error('unexpected success');
		} catch (error) {
			expect(String(error)).not.toContain(credential.apiKey);
			expect(String(error)).not.toContain('unexpected success');
		}
	}
});
it('rejects stalled pagination and cancelled requests without returning a partial catalogue', async () => {
	const send = vi
		.fn<typeof fetch>()
		.mockImplementation(async () =>
			Response.json({ data: [{ id: 'model-a' }], has_more: true, last_id: 'same' })
		);
	await expect(
		discoverModels({ ...credential, kind: 'anthropic' }, undefined, send)
	).rejects.toThrow('다음 페이지');
	send.mockRejectedValue(new DOMException('cancelled', 'AbortError'));
	await expect(discoverModels(credential, AbortSignal.abort(), send)).rejects.toThrow('중단');
});

it('rejects reflected keys containing JSON escapes and missing required pagination cursors', async () => {
	const apiKey = 'test-"quoted\\secret';
	const send = vi
		.fn<typeof fetch>()
		.mockResolvedValueOnce(Response.json({ data: [{ id: 'model', name: apiKey }] }));
	await expect(discoverModels({ ...credential, apiKey }, undefined, send)).rejects.toThrow(
		'안전하게'
	);
	send.mockResolvedValueOnce(Response.json({ data: [{ id: 'model' }], has_more: true }));
	await expect(
		discoverModels({ ...credential, kind: 'anthropic' }, undefined, send)
	).rejects.toThrow('다음 페이지');
});
