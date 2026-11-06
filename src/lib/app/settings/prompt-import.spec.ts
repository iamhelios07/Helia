import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { encode } from 'msgpackr';
import { describe, expect, it } from 'vitest';
import { parsePromptConfig } from '#lib/games/ai/prompts.js';
import { readPromptPresetFile } from './prompt-import.js';

function jsonFile(source: unknown, name = 'prompt.json') {
	return new File([JSON.stringify(source)], name, { type: 'application/json' });
}

describe('prompt preset files', () => {
	it('reads Helia JSON exports without changing canonical roles', async () => {
		const config = parsePromptConfig({
			version: 2,
			promptTemplate: [{ type: 'persona', text: 'Traveler', role: 'user' }]
		});
		await expect(
			readPromptPresetFile(jsonFile({ version: 1, name: 'Helia', config }))
		).resolves.toEqual({ name: 'Helia', config });
	});
	it('reads raw Risu JSON and .preset files through the existing field validator', async () => {
		for (const extension of ['JSON', 'preset']) {
			const result = await readPromptPresetFile(
				jsonFile({ name: 'Risu', mainPrompt: 'Narrate', maxResponse: 256 }, `preset.${extension}`)
			);
			expect(result.name).toBe('Risu');
			expect(result.config.maxTokens).toBe(256);
			expect(result.config.promptTemplate[0].text).toBe('Narrate');
		}
	});
	it.each(['risup', 'risupreset'])(
		'decodes the Risu export pipeline from a fixed .%s fixture',
		async (extension) => {
			// Fixtures follow Risu's export pipeline using its byte table, msgpackr,
			// AES-GCM with SHA-256("risupreset"), and gzip (not this importer).
			const bytes = await readFile(
				new URL(`../../testing/fixtures/prompt-preset.${extension}`, import.meta.url)
			);
			const result = await readPromptPresetFile(
				new File([new Uint8Array(bytes)], `preset.${extension}`)
			);
			expect(result.name).toBe('Risu preset');
			expect(result.config.maxTokens).toBe(256);
			expect(result.config.promptTemplate[0]).toMatchObject({
				type: 'plain',
				type2: 'main',
				role: 'user',
				text: 'You are a narrator.'
			});
			expect(result.config).not.toHaveProperty('apiKey');
			expect(result.config).not.toHaveProperty('lorebook');
		}
	);
	it('rejects malformed JSON and invalid Helia envelopes', async () => {
		for (const file of [
			new File(['{broken'], 'bad.json'),
			jsonFile([]),
			jsonFile({ config: null }),
			jsonFile({ config: [] })
		]) {
			await expect(readPromptPresetFile(file)).rejects.toThrow('프롬프트');
		}
	});
	it('rejects invalid compressed or encrypted containers without exposing their data', async () => {
		const files = [
			new File(['invalid-private-content'], 'bad.risup'),
			new File(
				[new Uint8Array(gzipSync(encode({ presetVersion: 3, type: 'preset' })))],
				'bad.risupreset'
			),
			new File(
				[
					new Uint8Array(
						gzipSync(encode({ presetVersion: 2, type: 'preset', preset: new Uint8Array(32) }))
					)
				],
				'bad.risupreset'
			)
		];
		for (const file of files)
			await expect(readPromptPresetFile(file)).rejects.toThrow('파일 형식을 확인');
	});
	it('bounds file size and expanded container size and rejects unrelated extensions', async () => {
		await expect(
			readPromptPresetFile(new File([new Uint8Array(4 * 1024 * 1024 + 1)], 'large.json'))
		).rejects.toThrow('4MiB');
		const compressed = gzipSync(new Uint8Array(4 * 1024 * 1024 + 1));
		await expect(
			readPromptPresetFile(new File([new Uint8Array(compressed)], 'large.risupreset'))
		).rejects.toThrow('프롬프트 파일');
		await expect(readPromptPresetFile(jsonFile({}, 'not-a-preset.png'))).rejects.toThrow(
			'선택해주세요'
		);
	});
});
