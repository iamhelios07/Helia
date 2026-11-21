import { afterEach, expect, it, vi } from 'vitest';

import { withGenerationActivity } from './action-activity.js';

afterEach(() => vi.useRealTimers());
it('renews a long-running tool lease only on real IO activity and waits before returning', async () => {
	vi.useFakeTimers();
	const renew = vi.fn(async () => {}),
		notify = vi.fn();
	expect(
		await withGenerationActivity(
			async (activity) => {
				activity();
				activity();
				await Promise.resolve();
				vi.advanceTimersByTime(60000);
				activity();
				return 'complete';
			},
			renew,
			notify
		)
	).toBe('complete');
	expect(renew).toHaveBeenCalledTimes(2);
	expect(notify).toHaveBeenCalledTimes(3);
});
it('rejects the tool result when lease renewal fails', async () => {
	await expect(
		withGenerationActivity(
			async (activity) => {
				activity();
				return 'stale';
			},
			async () => {
				throw Error('Lease lost');
			}
		)
	).rejects.toThrow('Lease lost');
});
