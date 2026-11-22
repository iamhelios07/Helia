import { expect, it, vi } from 'vitest';

import { SecretBridge, SecretWorkerBridge } from './bridge.js';

it('never takes credential scope or raw provider identifiers from a UI message', async () => {
	const access = {
			set: vi.fn(),
			has: vi.fn(async () => false),
			remove: vi.fn(),
			ref: vi.fn(async () => 'opaque')
		},
		send = vi.fn();
	const bridge = new SecretBridge(access, send);
	await bridge.receive({
		kind: 'secrets',
		id: '1',
		operation: { kind: 'has', name: 'same-name', gameId: 'other-game' }
	});
	expect(access.has).not.toHaveBeenCalled();
	expect(send).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
	await bridge.receive({
		kind: 'secrets',
		id: '2',
		operation: { kind: 'status', providers: [{ id: 'model-key' }] }
	});
	expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false }));
	await bridge.receive({ kind: 'secrets', id: '3', operation: { kind: 'has', name: 'same-name' } });
	expect(access.has).toHaveBeenCalledWith('same-name');
	expect(send).toHaveBeenLastCalledWith({
		kind: 'secret-response',
		id: '3',
		ok: true,
		result: false
	});
});
it('keeps Worker access read-only and ignores supplied scope outside the validated operation', async () => {
	const has = vi.fn(async () => true),
		ref = vi.fn(async () => 'opaque'),
		port = new MessageChannel(),
		bridge = new SecretWorkerBridge({ has, ref }, () => {});
	const reply = new Promise<unknown>((resolve) => {
		port.port1.onmessage = (event) => resolve(event.data);
	});
	bridge.receive(
		new MessageEvent('message', {
			data: {
				kind: 'secret',
				gameId: 'other-game',
				operation: { kind: 'set', name: 'key', value: 'not-allowed', url: 'https://api.example' }
			},
			ports: [port.port2]
		})
	);
	expect(await reply).toEqual({ ok: false });
	expect(has).not.toHaveBeenCalled();
	expect(ref).not.toHaveBeenCalled();
	bridge.dispose();
	port.port1.close();
});
