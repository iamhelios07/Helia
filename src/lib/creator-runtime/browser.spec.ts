import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runCreatorAction } from './browser.js';
import { SANDBOX_LIMITS, type ActionRequest } from './protocol.js';

class TestWorker {
	static instances: TestWorker[] = [];
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onmessageerror: (() => void) | null = null;
	onerror: ((event: { preventDefault: () => void }) => void) | null = null;
	postMessage = vi.fn();
	terminate = vi.fn();
	constructor() {
		TestWorker.instances.push(this);
	}
	respond(value: unknown) {
		this.onmessage?.({ data: value });
	}
}
const input: ActionRequest = {
	scripts: {},
	schema: {
		type: 'object',
		properties: { gold: { type: 'integer' } },
		additionalProperties: false
	},
	state: { gold: 100 },
	action: { name: 'buy', args: {} }
};
beforeEach(() => {
	TestWorker.instances = [];
	vi.stubGlobal('Worker', TestWorker);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

it('enforces the host watchdog even if the interpreter cannot reply', async () => {
	vi.useFakeTimers();
	const pending = runCreatorAction(input);
	const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' });
	await vi.advanceTimersByTimeAsync(SANDBOX_LIMITS.wallTimeMs);
	await assertion;
	expect(TestWorker.instances[0].terminate).toHaveBeenCalledOnce();
});
it('terminates on cancellation and ignores late worker replies', async () => {
	const controller = new AbortController();
	const pending = runCreatorAction(input, { signal: controller.signal });
	const worker = TestWorker.instances[0];
	controller.abort();
	worker.respond(JSON.stringify({ ok: true, result: { state: { gold: 0 } } }));
	await expect(pending).rejects.toMatchObject({ code: 'canceled' });
	expect(worker.terminate).toHaveBeenCalledOnce();
});
it.each([
	{},
	JSON.stringify({ ok: true, result: { state: { gold: 'bad' } } }),
	JSON.stringify({ ok: false, code: 'made-up' }),
	'not JSON'
])('rejects malformed replies and releases the worker: %j', async (reply) => {
	const pending = runCreatorAction(input);
	TestWorker.instances[0].respond(reply);
	await expect(pending).rejects.toMatchObject({ code: 'protocol' });
	expect(TestWorker.instances[0].terminate).toHaveBeenCalledOnce();
});
it('limits concurrent workers and releases every slot after completion', async () => {
	const pending = Array.from({ length: 4 }, () => runCreatorAction(input));
	await expect(runCreatorAction(input)).rejects.toMatchObject({ code: 'busy' });
	for (const worker of TestWorker.instances)
		worker.respond(JSON.stringify({ ok: true, result: { state: { gold: 80 } } }));
	expect(await Promise.all(pending)).toHaveLength(4);
	const next = runCreatorAction(input);
	TestWorker.instances[4].respond(JSON.stringify({ ok: true, result: { state: { gold: 70 } } }));
	expect(await next).toEqual({ state: { gold: 70 } });
});
it('validates against the captured input schema rather than a mutated caller object', async () => {
	const request = structuredClone(input);
	const pending = runCreatorAction(request);
	request.schema.properties.gold = { type: 'string' };
	TestWorker.instances[0].respond(JSON.stringify({ ok: true, result: { state: { gold: 80 } } }));
	expect(await pending).toEqual({ state: { gold: 80 } });
});
