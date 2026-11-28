import { afterEach, expect, it, vi } from 'vitest';

import { storageRequest } from '#lib/storage/transport.js';

import { holdEditorLease } from './editor-lease.js';

vi.mock('#lib/storage/transport.js', () => ({ storageRequest: vi.fn() }));
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.resetAllMocks();
});

const reply = { version: 0, records: [] };
const renew = { kind: 'editorLease', gameId: 'game', action: 'renew' };
const fiveMinutes = 5 * 60000;

it('renews every five minutes with a stable ID and releases on editor teardown', async () => {
	vi.useFakeTimers();
	vi.stubGlobal('window', new EventTarget());
	const wire = vi.mocked(storageRequest).mockResolvedValue(reply);
	const release = holdEditorLease('game');
	await vi.advanceTimersByTimeAsync(fiveMinutes - 1);
	expect(wire).toHaveBeenCalledOnce();
	expect(wire.mock.calls[0][0]).toMatchObject(renew);
	await vi.advanceTimersByTimeAsync(1);
	expect(wire.mock.calls[1]).toEqual(wire.mock.calls[0]);
	release();
	await vi.advanceTimersByTimeAsync(fiveMinutes);
	expect(wire).toHaveBeenCalledTimes(3);
	expect(wire.mock.calls[2][0]).toEqual({ ...wire.mock.calls[0][0], action: 'release' });
});

it('waits for an in-flight renewal and draft save before releasing on pagehide', async () => {
	vi.useFakeTimers();
	const events = new EventTarget();
	vi.stubGlobal('window', events);
	const pending = Promise.withResolvers<typeof reply>();
	const saving = Promise.withResolvers<void>();
	const wire = vi
		.mocked(storageRequest)
		.mockReturnValueOnce(pending.promise)
		.mockResolvedValue(reply);
	const release = holdEditorLease('game', () => saving.promise);
	events.dispatchEvent(new Event('pagehide'));
	release();
	await vi.advanceTimersByTimeAsync(fiveMinutes);
	expect(wire).toHaveBeenCalledOnce();
	pending.resolve(reply);
	await vi.advanceTimersByTimeAsync(0);
	expect(wire).toHaveBeenCalledOnce();
	saving.resolve();
	await vi.advanceTimersByTimeAsync(0);
	expect(wire).toHaveBeenCalledTimes(2);
	expect(wire.mock.calls[1][0]).toEqual({ ...wire.mock.calls[0][0], action: 'release' });
});
