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

it('waits for saves appended after pagehide until the save queue stops changing, including a rejected save', async () => {
	vi.useFakeTimers();
	const events = new EventTarget();
	vi.stubGlobal('window', events);
	const wire = vi.mocked(storageRequest).mockResolvedValue(reply);
	const first = Promise.withResolvers<void>();
	const last = Promise.withResolvers<void>();
	let queue = first.promise;
	holdEditorLease('game', () => queue);
	events.dispatchEvent(new Event('pagehide'));
	await vi.advanceTimersByTimeAsync(0);
	// A later pagehide listener/teardown appends another operation while the first save runs.
	queue = queue.then(() => last.promise);
	first.resolve();
	await vi.advanceTimersByTimeAsync(0);
	expect(wire).toHaveBeenCalledOnce();
	last.reject(Error('save failed'));
	await vi.advanceTimersByTimeAsync(0);
	expect(wire).toHaveBeenCalledTimes(2);
	expect(wire.mock.calls[1][0]).toMatchObject({ action: 'release' });
});

it('warns after consecutive renewal failures, resets on success, and clears the warning on recovery', async () => {
	vi.useFakeTimers();
	vi.stubGlobal('window', new EventTarget());
	const wire = vi.mocked(storageRequest).mockRejectedValue(Error('offline'));
	const warning = vi.fn();
	const release = holdEditorLease('game', undefined, warning);
	await vi.advanceTimersByTimeAsync(0);
	expect(warning).toHaveBeenLastCalledWith('');
	wire.mockResolvedValue(reply);
	await vi.advanceTimersByTimeAsync(fiveMinutes);
	wire.mockRejectedValue(Error('offline'));
	await vi.advanceTimersByTimeAsync(fiveMinutes);
	expect(warning).toHaveBeenLastCalledWith('');
	await vi.advanceTimersByTimeAsync(fiveMinutes);
	expect(warning).toHaveBeenLastCalledWith(
		expect.stringContaining('편집 중인 파일을 보호하지 못하고')
	);
	wire.mockResolvedValue(reply);
	await vi.advanceTimersByTimeAsync(fiveMinutes);
	expect(warning).toHaveBeenLastCalledWith('');
	release();
	await vi.advanceTimersByTimeAsync(0);
});

it('does not publish a renewal warning after teardown', async () => {
	vi.useFakeTimers();
	vi.stubGlobal('window', new EventTarget());
	const renewal = Promise.withResolvers<typeof reply>();
	vi.mocked(storageRequest).mockReturnValueOnce(renewal.promise).mockResolvedValue(reply);
	const warning = vi.fn();
	const release = holdEditorLease('game', undefined, warning);
	release();
	renewal.reject(Error('offline'));
	await vi.advanceTimersByTimeAsync(0);
	expect(warning).not.toHaveBeenCalled();
});
