import { storageRequest } from '#lib/storage/transport.js';

const RENEW_MS = 5 * 60 * 1000;

/** Independent leases let multiple tabs edit the same game. Failed requests expire on the host. */
export function holdEditorLease(
	gameId: string,
	pendingSave?: () => Promise<unknown>,
	onWarning?: (message: string) => void
) {
	const leaseId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
		byte.toString(16).padStart(2, '0')
	).join('');
	const send = (action: 'renew' | 'release') =>
		storageRequest({ kind: 'editorLease', gameId, leaseId, action });
	let pending: Promise<unknown> | undefined;
	let stopped = false;
	let failures = 0;
	const reportRenewal = (failed: boolean) => {
		if (stopped) {
			return;
		}
		failures = failed ? failures + 1 : 0;
		onWarning?.(
			failures >= 2
				? '편집 중인 파일을 보호하지 못하고 있어요. 연결을 확인하고 저장 공간 정리를 잠시 미뤄 주세요.'
				: ''
		);
	};
	const renew = () => {
		if (!stopped && !pending) {
			pending = send('renew')
				.then(
					() => reportRenewal(false),
					() => reportRenewal(true)
				)
				.finally(() => (pending = undefined));
		}
	};
	const interval = setInterval(renew, RENEW_MS);
	const release = () => {
		if (stopped) {
			return;
		}
		stopped = true;
		clearInterval(interval);
		window.removeEventListener('pagehide', pagehide);
		window.removeEventListener('pageshow', renew);
		// Let teardown/pagehide enqueue its final save before releasing the protection.
		void Promise.resolve()
			.then(async () => {
				await pending;
				let queue: Promise<unknown> | undefined;
				do {
					queue = pendingSave?.();
					await Promise.allSettled([queue]);
				} while (queue !== pendingSave?.());
				await send('release');
			})
			.catch(() => {});
	};
	const pagehide = (event: PageTransitionEvent) => {
		if (!event.persisted) {
			release();
		}
	};
	window.addEventListener('pagehide', pagehide);
	window.addEventListener('pageshow', renew);
	renew();
	return release;
}
