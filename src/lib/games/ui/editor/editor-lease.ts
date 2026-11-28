import { storageRequest } from '#lib/storage/transport.js';

const RENEW_MS = 5 * 60 * 1000;

/** Independent leases let multiple tabs edit the same game. Failed requests expire on the host. */
export function holdEditorLease(gameId: string, pendingSave?: () => Promise<unknown>) {
	const leaseId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
		byte.toString(16).padStart(2, '0')
	).join('');
	const send = (action: 'renew' | 'release') =>
		storageRequest({ kind: 'editorLease', gameId, leaseId, action }).catch(() => {});
	let pending: Promise<unknown> | undefined;
	let stopped = false;
	const renew = () => {
		if (!stopped && !pending) {
			pending = send('renew').finally(() => (pending = undefined));
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
		const saved = Promise.resolve().then(() => pendingSave?.());
		void Promise.allSettled([pending, saved]).then(() => send('release'));
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
