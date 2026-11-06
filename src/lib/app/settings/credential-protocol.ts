import { emptyAISettings, parseAISettings, type ProviderSettings } from './model.js';
import { parseServiceAccountJson, type ServiceAccount } from './vertex.js';

export interface CatalogModel {
	id: string;
	name: string;
	description?: string;
}
export type ProviderAddress = Pick<ProviderSettings, 'id' | 'kind' | 'baseUrl' | 'vertex'>;
export interface CredentialValue extends ProviderAddress {
	apiKey?: string;
	serviceAccount?: ServiceAccount;
}
export type CredentialRequest =
	| { kind: 'status'; providers: ProviderAddress[] }
	| { kind: 'save'; provider: ProviderAddress; apiKey: string }
	| { kind: 'save'; provider: ProviderAddress; serviceAccountJson: string }
	| { kind: 'delete'; id: string }
	| { kind: 'models'; provider: ProviderAddress }
	| { kind: 'verify'; provider: ProviderAddress };
export function credentialRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('연결 요청의 형식이 올바르지 않아요.');
	return value as Record<string, unknown>;
}
export function credentialId(value: unknown): string {
	if (typeof value !== 'string' || !/^[\w-]{1,80}$/.test(value))
		throw new Error('연결 식별자가 올바르지 않아요.');
	return value;
}
export function providerAddress(value: unknown): ProviderAddress {
	const input = credentialRecord(value);
	const provider = parseAISettings({
		...emptyAISettings(),
		providers: [{ ...input, name: 'connection' }]
	}).providers[0];
	const url = new URL(provider.baseUrl);
	if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
		throw new Error(
			'API 키를 사용하는 연결은 HTTPS 주소를 입력해주세요. HTTP는 로컬 주소에서만 사용할 수 있어요.'
		);
	return {
		id: provider.id,
		kind: provider.kind,
		baseUrl: provider.baseUrl,
		...(provider.vertex ? { vertex: provider.vertex } : {})
	};
}
export function parseCredentialRequest(value: unknown): CredentialRequest {
	const input = credentialRecord(value);
	if (input.kind === 'status' && Array.isArray(input.providers) && input.providers.length <= 64)
		return { kind: 'status', providers: input.providers.map(providerAddress) };
	if (input.kind === 'delete') return { kind: 'delete', id: credentialId(input.id) };
	if (input.kind === 'models' || input.kind === 'verify')
		return { kind: input.kind, provider: providerAddress(input.provider) };
	if (
		input.kind === 'save' &&
		typeof input.serviceAccountJson === 'string' &&
		input.apiKey === undefined
	) {
		const provider = providerAddress(input.provider);
		if (provider.kind !== 'google-vertex')
			throw new Error('서비스 계정은 Vertex AI 연결에만 사용할 수 있어요.');
		return {
			kind: 'save',
			provider,
			serviceAccountJson: JSON.stringify(parseServiceAccountJson(input.serviceAccountJson))
		};
	}
	if (
		input.kind === 'save' &&
		input.serviceAccountJson === undefined &&
		typeof input.apiKey === 'string' &&
		input.apiKey.trim().length > 0 &&
		input.apiKey.length <= 2048 &&
		!/\p{Cc}/u.test(input.apiKey)
	) {
		const provider = providerAddress(input.provider);
		if (provider.kind === 'google-vertex')
			throw new Error('Vertex AI에는 Service Account JSON을 입력해주세요.');
		return { kind: 'save', provider, apiKey: input.apiKey.trim() };
	}
	throw new Error('지원하지 않는 연결 요청이에요.');
}
export function sameCredentialAddress(value: ProviderAddress, provider: ProviderAddress): boolean {
	return (
		value.id === provider.id &&
		value.kind === provider.kind &&
		value.baseUrl === provider.baseUrl &&
		value.vertex?.projectId === provider.vertex?.projectId &&
		value.vertex?.location === provider.vertex?.location
	);
}
