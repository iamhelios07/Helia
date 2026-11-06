import { expect, it } from 'vitest';
import fixture from '#lib/testing/fixtures/service-account.json';
import { emptyAISettings, parseAISettings } from './model.js';
import {
	parseCredentialRequest,
	providerAddress,
	sameCredentialAddress
} from './credential-protocol.js';
import { GOOGLE_TOKEN_URL, parseServiceAccountJson, vertexBaseUrl } from './vertex.js';

it('keeps service-account secrets out of metadata and binds them to the project and location', () => {
	const provider = {
		id: 'vertex',
		name: 'Vertex',
		kind: 'google-vertex',
		vertex: { projectId: 'target-project', location: 'us-central1' },
		baseUrl: 'https://evil.example',
		serviceAccount: fixture,
		apiKey: 'never-store'
	};
	const settings = parseAISettings({ ...emptyAISettings(), providers: [provider] });
	const saved = settings.providers[0];
	expect(saved.baseUrl).toBe(
		'https://us-central1-aiplatform.googleapis.com/v1/projects/target-project/locations/us-central1/publishers/google'
	);
	expect(JSON.stringify(saved)).not.toContain('private_key');
	expect(vertexBaseUrl('target-project', 'global')).toContain(
		'https://aiplatform.googleapis.com/v1/projects/target-project/locations/global/'
	);
	expect(
		sameCredentialAddress(saved, {
			...saved,
			vertex: { ...saved.vertex!, location: 'europe-west4' }
		})
	).toBe(false);
	const command = parseCredentialRequest({
		kind: 'save',
		provider: saved,
		serviceAccountJson: JSON.stringify(fixture)
	});
	expect(command).toMatchObject({ kind: 'save', provider: providerAddress(saved) });
	if (command.kind === 'save' && 'serviceAccountJson' in command)
		expect(JSON.parse(command.serviceAccountJson)).not.toHaveProperty('test_public_key_der');
	expect(() =>
		parseCredentialRequest({ kind: 'save', provider: saved, apiKey: 'express-key' })
	).toThrow('Service Account JSON');
});

it('rejects arbitrary OAuth endpoints, wrong credential types and unsafe project or region values', () => {
	for (const changes of [
		{ token_uri: 'https://evil.example/token' },
		{ type: 'authorized_user' },
		{ private_key: 'bad key' },
		{ client_email: 'invalid' }
	])
		expect(() => parseServiceAccountJson(JSON.stringify({ ...fixture, ...changes }))).toThrow(
			'올바른 Service Account'
		);
	for (const source of [
		'invalid',
		'x'.repeat(65537),
		JSON.stringify({ ...fixture, private_key: '\0' })
	])
		expect(() => parseServiceAccountJson(source)).toThrow();
	expect(parseServiceAccountJson(JSON.stringify(fixture)).token_uri).toBe(GOOGLE_TOKEN_URL);
	for (const location of ['global/../../', 'us-central1.evil.com', 'https://evil.example'])
		expect(() => vertexBaseUrl('target-project', location)).toThrow();
	expect(() => vertexBaseUrl('../project', 'global')).toThrow();
});
