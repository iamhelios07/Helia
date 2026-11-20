import { encode } from 'msgpackr';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { parsePromptConfig } from '#lib/games/ai/prompts.js';

import { readPromptPresetFile } from './prompt-import.js';

function jsonFile(source: unknown, name = 'prompt.json') {
	return new File([JSON.stringify(source)], name, { type: 'application/json' });
}

async function encryptedRisuFile(source: unknown): Promise<File> {
	const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('risupreset'));
	const key = await crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt']);
	const payload = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv: new Uint8Array(12) },
		key,
		new Uint8Array(encode(source))
	);
	const envelope = encode({ presetVersion: 2, type: 'preset', preset: new Uint8Array(payload) });
	return new File([new Uint8Array(gzipSync(envelope))], 'legacy.risupreset');
}

describe('prompt preset files', () => {
	it('migrates encrypted Risu exports after container decoding and preserves Risu arithmetic', async () => {
		const imported = await readPromptPresetFile(
			await encryptedRisuFile({
				name: 'Encrypted legacy',
				mainPrompt: '{{#if_pure {{? 2^3^2=64}}}}Active{{/if_pure}}',
				promptSettings: { assistantPrefill: '{{? -2^2}}' }
			})
		);
		expect(imported.migrated).toBe(3);
		expect(imported.config.promptSettings.assistantPrefill).toBe('{{calc::legacy::-2^2}}');
		expect(imported.config.promptTemplate[0].text).toContain(
			'#when::keep::{{calc::legacy::2^3^2=64}}'
		);
	});
	it.each(['json', 'preset'])(
		'migrates deprecated CBS after decoding .%s presets',
		async (extension) => {
			const old = '{{#if_pure {{? {{getglobalvar::toggle_oil}}=1}}}}\nActive\n{{/if}}';
			const result = await readPromptPresetFile(
				jsonFile(
					{
						name: 'Legacy',
						mainPrompt: old,
						customPromptTemplateToggle: 'oil=Oil'
					},
					`legacy.${extension}`
				)
			);
			expect(result.migrated).toBe(2);
			expect(result.config.promptTemplate[0].text).toBe(
				'{{#when::keep::{{calc::legacy::{{getglobalvar::toggle_oil}}=1}}}}\nActive\n{{/when}}'
			);
			expect(result.config.toggleValues).toEqual({ oil: '0' });
			const reloaded = await readPromptPresetFile(
				jsonFile({ name: result.name, config: result.config })
			);
			expect(reloaded).toEqual({ name: result.name, config: result.config });
		}
	);
	it('reports a legacy conversion location without exposing discarded imported fields', async () => {
		await expect(
			readPromptPresetFile(jsonFile({ mainPrompt: '{{#if_pure 1}}missing', apiKey: 'private-key' }))
		).rejects.toThrow('1번 프롬프트 · text');
	});
	it('retains imported Risu toggle definitions and Helia selection values on export and reload', async () => {
		const { config } = await readPromptPresetFile(
			jsonFile({
				name: 'Toggles',
				customPromptTemplateToggle: 'detail=Details\nstyle=Style=select=Short,Long',
				promptTemplate: [{ type: 'plain', text: '{{#when::toggle::detail}}Details{{/when}}' }]
			})
		);
		expect(config.toggleValues).toEqual({ detail: '0', style: '0' });
		config.toggleValues = { detail: '1', style: '1' };
		const reloaded = await readPromptPresetFile(jsonFile({ name: 'Toggles', config }));
		expect(reloaded.config).toEqual(config);
	});
	it('reads Helia JSON exports without changing canonical roles', async () => {
		const config = parsePromptConfig({
			version: 2,
			promptTemplate: [{ type: 'persona', text: 'Traveler', role: 'user' }]
		});
		await expect(
			readPromptPresetFile(jsonFile({ version: 1, name: 'Helia', config }))
		).resolves.toEqual({ name: 'Helia', config });
	});
});

describe('prompt preset files', () => {
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
});

describe('prompt preset files', () => {
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
});

describe('prompt preset files', () => {
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
});

describe('prompt preset files', () => {
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
		for (const file of files) {
			await expect(readPromptPresetFile(file)).rejects.toThrow('파일 형식을 확인');
		}
	});
});

describe('prompt preset files', () => {
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
