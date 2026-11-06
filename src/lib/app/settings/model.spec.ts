import { describe, expect, it } from 'vitest';
import {
	emptyAISettings,
	parseAISettings,
	upsertProvider,
	upsertModel,
	removeProvider,
	removeModel,
	selectDefaultModel,
	type ProviderSettings,
	type ModelSettings
} from './model.js';

const provider: ProviderSettings = {
	id: 'connection',
	name: '내 연결',
	kind: 'openai-compatible',
	baseUrl: 'https://example.com/v1'
};
const model: ModelSettings = {
	id: 'model-one',
	name: '기본 모델',
	providerId: provider.id,
	modelId: 'org/my-model'
};
const configured = () => upsertModel(upsertProvider(emptyAISettings(), provider), model);

describe('provider and model settings', () => {
	it('normalizes user-defined names and model IDs without persisting undeclared secret fields', () => {
		const settings = parseAISettings({
			...configured(),
			apiKey: 'not-for-storage',
			providers: [
				{
					...provider,
					name: '  연결  ',
					baseUrl: 'https://example.com/v1/',
					apiKey: 'secret-provider'
				}
			],
			models: [{ ...model, name: '  모델  ', modelId: '  org/model-id  ', secret: 'secret-model' }]
		});
		expect(settings.providers[0]).toEqual({ ...provider, name: '연결' });
		expect(settings.models[0]).toEqual({ ...model, name: '모델', modelId: 'org/model-id' });
		expect(JSON.stringify(settings)).not.toContain('secret');
		expect(JSON.stringify(settings)).not.toContain('not-for-storage');
	});
	it('updates a provider without changing its models and selects the first added model by default', () => {
		const original = configured();
		const updated = upsertProvider(original, {
			...provider,
			name: '바꾼 연결',
			baseUrl: 'http://localhost:8080/api'
		});
		expect(updated.providers).toHaveLength(1);
		expect(updated.models).toEqual([model]);
		expect(updated.defaultModelId).toBe(model.id);
		expect(original.providers).toEqual([provider]);
	});
	it('cascades provider deletion and keeps a usable default among the remaining models', () => {
		let settings = upsertProvider(configured(), { ...provider, id: 'other-provider' });
		settings = upsertModel(settings, { ...model, id: 'model-two', providerId: 'other-provider' });
		settings = upsertModel(settings, { ...model, id: 'model-three' });
		const removed = removeProvider(settings, provider.id);
		expect(removed.providers.map((item) => item.id)).toEqual(['other-provider']);
		expect(removed.models.map((item) => item.id)).toEqual(['model-two']);
		expect(removed.defaultModelId).toBe('model-two');
		expect(settings.models).toHaveLength(3);
		expect(removeProvider(removed, 'other-provider')).toEqual(emptyAISettings());
	});
	it('keeps or replaces the selected default when editing and deleting models', () => {
		let settings = upsertModel(configured(), { ...model, id: 'model-two' });
		settings = selectDefaultModel(settings, 'model-two');
		settings = upsertModel(settings, { ...model, id: 'model-two', name: '수정한 모델' });
		expect(settings.defaultModelId).toBe('model-two');
		expect(removeModel(settings, model.id).defaultModelId).toBe('model-two');
		expect(removeModel(settings, 'model-two').defaultModelId).toBe(model.id);
		expect(() => selectDefaultModel(settings, 'missing')).toThrow();
	});
	it.each([
		'data:text/plain,abc',
		'file:///tmp/model',
		'https://user:password@example.com',
		'https://example.com?key=secret',
		'https://example.com#secret',
		'not-a-url'
	])('rejects unsafe or malformed endpoint %s', (baseUrl) => {
		expect(() => upsertProvider(emptyAISettings(), { ...provider, baseUrl })).toThrow();
	});
	it('rejects duplicate identities, missing references and unsupported formats', () => {
		const settings = configured();
		for (const invalid of [
			{ ...settings, version: 2 },
			{ ...settings, providers: [provider, provider] },
			{ ...settings, models: [model, model] },
			{ ...settings, providers: [] },
			{ ...settings, models: [{ ...model, providerId: 'missing' }] },
			{ ...settings, defaultModelId: 'missing' },
			{ ...settings, providers: [{ ...provider, kind: 'unknown' }] },
			{ ...settings, models: [{ ...model, modelId: ' ' }] }
		])
			expect(() => parseAISettings(invalid)).toThrow();
	});
});
