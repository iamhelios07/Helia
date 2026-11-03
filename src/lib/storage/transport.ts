import { isDesktopBuild, isTauri } from '#lib/platform/index.js';
import { parseReply, type StorageTransport } from './protocol.js';

export const storageRequest: StorageTransport = async (request) => {
	if (isDesktopBuild) {
		if (!isTauri()) throw new Error('데스크톱 저장소는 Helia 앱에서 사용할 수 있어요.');
		const host: unknown = Reflect.get(window, '__HELIA_STORAGE__');
		if (window !== window.top || typeof host !== 'function')
			throw new Error('데스크톱 저장소 접근이 허용되지 않았어요.');
		return parseReply(await host(request));
	}
	const response = await fetch('/api/storage', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(request)
	});
	const result: unknown = await response.json().catch(() => null);
	if (!response.ok)
		throw new Error(
			typeof result === 'object' &&
				result !== null &&
				'error' in result &&
				typeof result.error === 'string'
				? result.error
				: '게임 저장소를 사용할 수 없어요.'
		);
	return parseReply(result);
};
