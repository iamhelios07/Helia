import type { ActionRunner } from '#lib/games/scripting/protocol.js';

/** Tool IO activity renews the host lease without synthesizing model output or tool calls. */
export async function withGenerationActivity<T>(
	operation: (activity: () => void) => Promise<T>,
	renew: () => Promise<void>,
	notify?: () => void
): Promise<T> {
	let last = -Infinity;
	let pending = Promise.resolve();
	const activity = () => {
		notify?.();
		if (Date.now() - last < 60_000) {
			return;
		}
		last = Date.now();
		pending = pending.then(renew);
		void pending.catch(() => {});
	};
	try {
		return await operation(activity);
	} finally {
		await pending;
	}
}

export function generationActions(run: ActionRunner, renew: () => Promise<void>): ActionRunner {
	return (request, options) =>
		withGenerationActivity(
			(activity) => run(request, { ...options, onActivity: activity }),
			renew,
			options?.onActivity
		);
}
