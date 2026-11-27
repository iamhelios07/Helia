import { mount, unmount } from 'svelte';

import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';

import { NETWORK_GRANT_REMEMBER_FAILED, resolveConsent, type ConsentAnswer } from './consent.js';
import NetworkGrantNotice from './NetworkGrantNotice.svelte';

// Serialize native modal dialogs. Permissions never enter game data or history; the optional
// "do not ask again" choice goes only to the player's own network grant store.
let queue = Promise.resolve();
export function requestNetworkPermission(
	origin: string,
	signal: AbortSignal,
	gameId?: string
): Promise<boolean> {
	listenForRememberFailure();
	const result = queue.then(() => resolveConsent(origin, signal, gameId, showPermission));
	queue = result.then(
		() => {},
		() => {}
	);
	return result;
}
/**
 * The app has no toast surface, so a rejected write is announced by a single body-mounted notice,
 * following the same trusted overlay pattern as the consent dialog itself.
 */
let listening = false;
function listenForRememberFailure() {
	if (listening || typeof window === 'undefined') {
		return;
	}
	listening = true;
	window.addEventListener(NETWORK_GRANT_REMEMBER_FAILED, (event) => {
		const origin = event instanceof CustomEvent ? event.detail : '';
		if (typeof origin === 'string' && origin) {
			showRememberFailure(origin);
		}
	});
}
/** It stays until the player dismisses it so keyboard and screen readers are never cut off. */
let notice: ReturnType<typeof mount> | null = null;
function hideNotice() {
	if (notice) {
		const previous = notice;
		notice = null;
		void unmount(previous);
	}
}
function showRememberFailure(origin: string) {
	hideNotice();
	notice = mount(NetworkGrantNotice, {
		target: document.body,
		props: {
			message: `${origin} 주소를 기억하지 못했어요. 다음에 다시 물어볼게요.`,
			ondismiss: hideNotice
		}
	});
}
function consentDetail(canRemember: boolean): string {
	const base = '이번 작업이 끝날 때까지 허용합니다.';
	if (!canRemember) {
		return base;
	}
	return `${base} '다시 묻지 않기'를 선택하면 설정의 '외부 연결'에서 취소할 때까지 이 게임에서는 이 주소를 다시 묻지 않습니다.`;
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
				message: `이 게임이 다음 주소로 데이터를 보내고 응답을 받으려고 합니다.\n\n${origin}\n\n${consentDetail(canRemember)}`,
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
