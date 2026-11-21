import { mount, unmount } from 'svelte';

import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';

// Serialize native modal dialogs. Permissions never enter game data or history.
let queue = Promise.resolve();
export function requestNetworkPermission(origin: string, signal: AbortSignal): Promise<boolean> {
	const result = queue.then(() => showPermission(origin, signal));
	queue = result.then(
		() => {},
		() => {}
	);
	return result;
}
function showPermission(origin: string, signal: AbortSignal): Promise<boolean> {
	if (signal.aborted) {
		return Promise.resolve(false);
	}
	return new Promise((resolve) => {
		let settled = false;
		const finish = (allowed: boolean) => {
			if (settled) {
				return;
			}
			settled = true;
			signal.removeEventListener('abort', cancel);
			void unmount(dialog).then(() => resolve(allowed));
		};
		const cancel = () => finish(false);
		const dialog = mount(ConfirmDialog, {
			target: document.body,
			props: {
				title: '외부 연결 허용',
				message: `이 게임이 다음 주소로 데이터를 보내고 응답을 받으려고 합니다.\n\n${origin}\n\n이번 작업이 끝날 때까지 허용합니다.`,
				confirmLabel: '허용',
				tone: 'default',
				onconfirm: () => finish(true),
				oncancel: cancel
			}
		});
		signal.addEventListener('abort', cancel, { once: true });
	});
}
