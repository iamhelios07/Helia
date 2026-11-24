import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { MigrationBudget } from '../migration/budget.js';
import { runMigrationWorker } from './migration-runner.js';
import { SANDBOX_LIMITS } from './protocol.js';
import { tryWorkerSlot } from './worker-slots.js';

class FakeWorker {
	static instances: FakeWorker[] = [];
	onmessage?: (event: MessageEvent<unknown>) => void;
	onerror?: (event: ErrorEvent) => void;
	onmessageerror?: () => void;
	terminated = false;
	postMessage = vi.fn();
	constructor() {
		FakeWorker.instances.push(this);
	}
	terminate() {
		this.terminated = true;
	}
	emit(data: unknown) {
		this.onmessage?.({ data } as MessageEvent<unknown>);
	}
}
const request = { compiled: [{ id: 'rules', source: '' }] };
const reply = JSON.stringify({ ok: true, result: { kind: 'catalog', migrations: [] } });
const owned: MigrationBudget[] = [];
function budget(bytes = 1_000_000, deadlineMs = 600_000, signal?: AbortSignal) {
	const work = new MigrationBudget({ entries: 10, bytes, deadlineMs }, signal);
	owned.push(work);
	return work;
}
beforeEach(() => {
	FakeWorker.instances = [];
	vi.stubGlobal('Worker', FakeWorker);
});
afterEach(() => {
	owned.forEach((work) => work.dispose());
	owned.length = 0;
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
async function started(work = budget(), count = 1) {
	const result = vi.fn();
	const task = runMigrationWorker(
		count === 1 ? request : { ...request, runs: Array(count).fill({ name: 'x' }) },
		work,
		result
	);
	await Promise.resolve();
	return { work, task, result, worker: FakeWorker.instances.at(-1)! };
}
it('reserves outbound and inbound messages and releases both before returning', async () => {
	const { work, task, result, worker } = await started();
	expect(work.usage.bytes).toBeGreaterThan(0);
	worker.emit(reply);
	await task;
	expect(result).toHaveBeenCalledWith({ kind: 'catalog', migrations: [] });
	expect(worker.terminated).toBe(true);
	expect(work.usage.bytes).toBe(0);
});
it('returns immediately for an empty run list without creating a worker', async () => {
	const work = budget();
	await runMigrationWorker({ ...request, runs: [] }, work, () => {
		throw Error('no results expected');
	});
	expect(FakeWorker.instances).toHaveLength(0);
	expect(work.usage.bytes).toBe(0);
});
it('rejects outbound and inbound byte limits before sending or parsing the payload', async () => {
	const small = budget(10);
	await expect(runMigrationWorker(request, small, () => {})).rejects.toMatchObject({
		kind: 'limit'
	});
	expect(FakeWorker.instances).toHaveLength(0);
	const { work, task, worker } = await started(budget(1000));
	worker.emit('x'.repeat(1000));
	await expect(task).rejects.toMatchObject({ kind: 'limit' });
	expect(worker.terminated).toBe(true);
	expect(work.usage.bytes).toBe(0);
});
it('rejects RPC-shaped messages and terminates the worker without dispatching capabilities', async () => {
	const { worker, task } = await started();
	worker.emit({ kind: 'secret', name: 'private-key' });
	await expect(task).rejects.toMatchObject({ kind: 'unavailable' });
	expect(worker.terminated).toBe(true);
});
it('cancels running workers and releases reservations and shared slots', async () => {
	const abort = new AbortController();
	const { work, task, worker } = await started(budget(undefined, undefined, abort.signal));
	abort.abort();
	await expect(task).rejects.toMatchObject({ kind: 'canceled' });
	expect(worker.terminated).toBe(true);
	expect(work.usage.bytes).toBe(0);
	const slots = Array.from({ length: 4 }, () => tryWorkerSlot());
	expect(slots.every(Boolean)).toBe(true);
	slots.forEach((release) => release?.());
});
it('waits for the common slot pool and wakes when an Action slot is released', async () => {
	const slots = Array.from({ length: 4 }, () => tryWorkerSlot()!);
	const work = budget();
	try {
		const task = runMigrationWorker(request, work, () => {});
		await Promise.resolve();
		expect(FakeWorker.instances).toHaveLength(0);
		slots[0]();
		await Promise.resolve();
		FakeWorker.instances[0].emit(reply);
		await task;
		expect(work.usage.bytes).toBe(0);
	} finally {
		slots.forEach((release) => release());
	}
});
it('uses the operation deadline while queued and resets the watchdog on each result', async () => {
	vi.useFakeTimers();
	const slots = Array.from({ length: 4 }, () => tryWorkerSlot()!);
	try {
		const queued = runMigrationWorker(request, budget(undefined, 100), () => {});
		const failure = expect(queued).rejects.toMatchObject({ kind: 'timeout' });
		await vi.advanceTimersByTimeAsync(101);
		await failure;
	} finally {
		slots.forEach((release) => release());
	}
	const { worker, task, work } = await started(budget(), 2);
	await vi.advanceTimersByTimeAsync(SANDBOX_LIMITS.wallTimeMs - 1);
	worker.emit(JSON.stringify({ ok: true, result: { kind: 'state', index: 0, value: {} } }));
	await vi.advanceTimersByTimeAsync(SANDBOX_LIMITS.wallTimeMs - 1);
	worker.emit(JSON.stringify({ ok: true, result: { kind: 'state', index: 1, value: {} } }));
	await task;
	expect(work.usage.bytes).toBe(0);
});
