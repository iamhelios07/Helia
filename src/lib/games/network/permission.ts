import { mount, unmount } from 'svelte';

import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';

import { resolveConsent, type ConsentAnswer } from './consent.js';

// Serialize native modal dialogs. Permissions never enter game data or history; the optional
// "do not ask again" choice goes only to the player's own network grant store.
let queue = Promise.resolve();
export function requestNetworkPermission(
	origin: string,
	signal: AbortSignal,
	gameId?: string
): Promise<boolean> {
	const result = queue.then(() => resolveConsent(origin, signal, gameId, showPermission));
	queue = result.then(
		() => {},
		() => {}
	);
	return result;
}
function showPermission(
	origin: string,
	signal: AbortSignal,
	canRemember: boolean
): Promise<ConsentAnswer> {
	if (signal.aborted) {
		return Promise.resolve({ allowed: false, remember: false });
	}
	return new Promise((resolve) => {
		let settled = false;
		const finish = (answer: ConsentAnswer) => {
			if (settled) {
				return;
			}
			settled = true;
			signal.removeEventListener('abort', cancel);
			void unmount(dialog).then(() => resolve(answer));
		};
		const cancel = () => finish({ allowed: false, remember: false });
		const dialog = mount(ConfirmDialog, {
			target: document.body,
			props: {
				title: '외부 연결 허용',
				message: `이 게임이 다음 주소로 데이터를 보내고 응답을 받으려고 합니다.\n\n${origin}\n\n이번 작업이 끝날 때까지 허용합니다.`,
				confirmLabel: '허용',
				tone: 'default',
				optionLabel: canRemember ? '이 주소에 대해 다시 묻지 않기' : '',
				onconfirm: (remember: boolean) => finish({ allowed: true, remember }),
				oncancel: cancel
			}
		});
		signal.addEventListener('abort', cancel, { once: true });
	});
}
