import { isDesktopBuild, isTauri } from '#lib/platform/index.js';

import { parseAISettings, type AISettings } from './model.js';

export type AISettingsRequest =
	| { kind: 'read' }
	| { kind: 'initialize'; settings: AISettings }
	| { kind: 'write'; settings: AISettings; revision: number };
export interface AISettingsSnapshot {
	settings: AISettings | null;
	revision: number;
}
export type AISettingsTransport = (request: AISettingsRequest) => Promise<AISettingsSnapshot>;

function parseSnapshot(value: unknown): AISettingsSnapshot {
	if (!value || typeof value !== 'object' || !('settings' in value) || !('revision' in value)) {
		throw new Error('모델 설정 응답의 형식이 올바르지 않아요.');
	}
	const { settings, revision } = value;
	if (
		typeof revision !== 'number' ||
		!Number.isSafeInteger(revision) ||
		(settings === null ? revision !== 0 : revision < 1)
	) {
		throw new Error('모델 설정 버전이 올바르지 않아요.');
	}
	return { settings: settings === null ? null : parseAISettings(settings), revision };
}

async function webRequest(request: AISettingsRequest): Promise<unknown> {
	const method = { read: 'GET', initialize: 'POST', write: 'PUT' }[request.kind];
	const response = await fetch('/api/ai-settings', {
		method,
		cache: 'no-store',
		...(request.kind === 'read'
			? {}
			: {
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						settings: request.settings,
						...(request.kind === 'write' ? { revision: request.revision } : {})
					})
				})
	});
	const result: unknown = await response.json().catch(() => null);
	if (!response.ok) {
		throw new Error(
			result && typeof result === 'object' && 'error' in result && typeof result.error === 'string'
				? result.error
				: '모델 설정 저장소를 사용할 수 없어요. 다시 시도해주세요.'
		);
	}
	return result;
}

export const aiSettingsRequest: AISettingsTransport = async (request) => {
	if (isDesktopBuild) {
		if (!isTauri() || window !== window.top) {
			throw new Error('데스크톱 설정 저장소는 Helia 앱에서 사용할 수 있어요.');
		}
		const host: unknown = Reflect.get(window, '__HELIA_AI_SETTINGS__');
		if (typeof host !== 'function') {
			throw new Error('데스크톱 설정 저장소에 접근할 수 없어요.');
		}
		return parseSnapshot(await host(request));
	}
	return parseSnapshot(await webRequest(request));
};
