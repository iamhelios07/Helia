import { isDesktopBuild, isTauri } from '#lib/platform/index.js';

import type { ProviderSettings } from './model.js';

import {
	credentialRecord,
	parseCredentialRequest,
	providerAddress,
	type CatalogModel,
	type CredentialRequest
} from './credential-protocol.js';
export type { CatalogModel } from './credential-protocol.js';

async function request(input: CredentialRequest, signal?: AbortSignal): Promise<unknown> {
	const command = parseCredentialRequest(input);
	if (isDesktopBuild) {
		if (!isTauri() || window !== window.top) {
			throw new Error('보안 저장소는 Helia 데스크톱 앱에서 사용할 수 있어요.');
		}
		const host: unknown = Reflect.get(window, '__HELIA_CREDENTIALS__');
		if (typeof host !== 'function') {
			throw new Error('보안 저장소를 사용할 수 없어요.');
		}
		return host(command);
	}
	const response = await fetch('/api/credentials', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(command),
		signal
	});
	const result: unknown = await response.json().catch(() => null);
	if (!response.ok) {
		const error = result && typeof result === 'object' && 'error' in result ? result.error : null;
		throw new Error(typeof error === 'string' ? error : '연결 요청을 처리하지 못했어요.');
	}
	return result;
}
export async function getCredentialStatus(
	providers: ProviderSettings[]
): Promise<Record<string, boolean>> {
	const result = credentialRecord(
		await request({ kind: 'status', providers: providers.map(providerAddress) })
	);
	const status: Record<string, boolean> = Object.create(null);
	for (const provider of providers) {
		if (typeof result[provider.id] !== 'boolean') {
			throw new Error('키 저장 상태를 확인하지 못했어요.');
		}
		status[provider.id] = result[provider.id] as boolean;
	}
	return status;
}
export async function saveCredential(provider: ProviderSettings, apiKey: string): Promise<void> {
	await request({ kind: 'save', provider: providerAddress(provider), apiKey });
}
export async function saveServiceAccountCredential(
	provider: ProviderSettings,
	serviceAccountJson: string
): Promise<void> {
	await request({ kind: 'save', provider: providerAddress(provider), serviceAccountJson });
}
export async function verifyProviderCredential(
	provider: ProviderSettings,
	signal?: AbortSignal
): Promise<void> {
	const result = credentialRecord(
		await request({ kind: 'verify', provider: providerAddress(provider) }, signal)
	);
	if (result.verified !== true) {
		throw new Error('서비스 계정 인증을 확인하지 못했어요.');
	}
}
export async function deleteCredential(id: string): Promise<void> {
	await request({ kind: 'delete', id });
}
export async function fetchProviderModels(
	provider: ProviderSettings,
	signal?: AbortSignal
): Promise<CatalogModel[]> {
	const result = await request({ kind: 'models', provider: providerAddress(provider) }, signal);
	if (!Array.isArray(result) || result.length > 10000) {
		throw new Error('모델 목록 형식이 올바르지 않아요.');
	}
	return result.map((item: unknown) => {
		const entry = credentialRecord(item);
		if (
			typeof entry.id !== 'string' ||
			!entry.id ||
			entry.id.length > 256 ||
			typeof entry.name !== 'string' ||
			entry.name.length > 256
		) {
			throw new Error('모델 목록 형식이 올바르지 않아요.');
		}
		return {
			id: entry.id,
			name: entry.name,
			...(typeof entry.description === 'string'
				? { description: entry.description.slice(0, 500) }
				: {})
		};
	});
}
