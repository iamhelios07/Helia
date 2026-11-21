import { expect, it, vi } from 'vitest';

import { NetworkPermissions } from './permissions.js';

it('shares concurrent consent and remembers the answer for this UI only', async () => {
	let answer!: (value: boolean) => void;
	const prompt = vi.fn(
		async () =>
			new Promise<boolean>((resolve) => {
				answer = resolve;
			})
	);
	const permissions = new NetworkPermissions(prompt);
	const first = permissions.allow('https://api.example', new AbortController().signal);
	const second = permissions.allow('https://api.example', new AbortController().signal);
	await Promise.resolve();
	expect(prompt).toHaveBeenCalledOnce();
	answer(true);
	await expect(first).resolves.toBe(true);
	await expect(second).resolves.toBe(true);
	await expect(
		permissions.allow('https://api.example', new AbortController().signal)
	).resolves.toBe(true);
	expect(prompt).toHaveBeenCalledOnce();
	permissions.dispose();
});
it('keeps shared consent alive until all waiting requests are cancelled and permits retry', async () => {
	let promptSignal: AbortSignal | undefined;
	const prompt = vi
		.fn<import('./fetch.js').NetworkPermission>()
		.mockImplementation(async (_origin, signal) => {
			promptSignal = signal;
			return new Promise((resolve) =>
				signal.addEventListener('abort', () => resolve(false), { once: true })
			);
		});
	const permissions = new NetworkPermissions(prompt);
	const a = new AbortController(),
		b = new AbortController();
	const first = permissions.allow('https://api.example', a.signal).catch((error) => error.name);
	const second = permissions.allow('https://api.example', b.signal).catch((error) => error.name);
	await Promise.resolve();
	a.abort();
	await expect(first).resolves.toBe('AbortError');
	expect(promptSignal?.aborted).toBe(false);
	b.abort();
	await expect(second).resolves.toBe('AbortError');
	expect(promptSignal?.aborted).toBe(true);
	prompt.mockResolvedValue(true);
	await expect(
		permissions.allow('https://api.example', new AbortController().signal)
	).resolves.toBe(true);
	expect(prompt).toHaveBeenCalledTimes(2);
	permissions.dispose();
});
