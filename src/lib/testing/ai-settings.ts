import type { AISettingsTransport } from '#lib/app/settings/settings-transport.js';

import { parseAISettings, type AISettings } from '#lib/app/settings/model.js';

/** An independent host store for tests; browser storage never acts as its backing data. */
export function memoryAISettingsTransport(initial?: AISettings): AISettingsTransport {
	let settings = initial === undefined ? null : parseAISettings(initial);
	let revision = settings === null ? 0 : 1;
	return async (request) => {
		if (request.kind === 'initialize' && settings === null) {
			settings = parseAISettings(request.settings);
			revision = 1;
		} else if (request.kind === 'write') {
			if (settings === null || request.revision !== revision) {
				throw new Error('다른 창에서 모델 설정이 변경됐어요. 설정을 다시 불러온 후 저장해주세요.');
			}
			settings = parseAISettings(request.settings);
			revision++;
		}
		return { settings: settings === null ? null : parseAISettings(settings), revision };
	};
}
