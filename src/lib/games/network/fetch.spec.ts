import { expect, it, vi } from 'vitest';

import { fetchWithPermission } from './fetch.js';
import {
	decodeBytes,
	encodeBytes,
	networkURL,
	parseNetworkRequest,
	NETWORK_LIMITS
} from './protocol.js';

const request = {
	url: 'https://api.example/start',
	method: 'POST',
	headers: [
		['authorization', 'Bearer test'],
		['content-type', 'application/json']
	] as [string, string][],
	body: btoa('{}'),
	redirect: 'follow' as const
};
const signal = () => new AbortController().signal;

it('requires consent before sending and preserves binary bytes and authorization', async () => {
	const permission = vi.fn<import('./fetch.js').NetworkPermission>().mockResolvedValue(false);
	const send = vi
		.fn<typeof import('./transport.js').networkHop>()
		.mockImplementation(async () => new Response());
	await expect(fetchWithPermission(request, signal(), permission, send)).rejects.toThrow(
		'permission'
	);
	expect(send).not.toHaveBeenCalled();
	permission.mockResolvedValue(true);
	await fetchWithPermission(request, signal(), permission, send);
	expect(send.mock.calls[0][0]).toEqual(expect.objectContaining(requestWithoutRedirect()));
	const bytes = new Uint8Array([0, 255, 128, 10]);
	expect(decodeBytes(encodeBytes(bytes))).toEqual(bytes);
});
function requestWithoutRedirect() {
	const { redirect: _, ...wire } = request;
	void _;
	return wire;
}
it('checks each redirect origin and strips credentials when crossing origins', async () => {
	const permission = vi.fn<import('./fetch.js').NetworkPermission>().mockResolvedValue(true);
	const send = vi
		.fn<typeof import('./transport.js').networkHop>()
		.mockResolvedValueOnce(
			new Response(null, { status: 302, headers: { location: 'https://cdn.example/image' } })
		)
		.mockResolvedValueOnce(new Response(new Uint8Array([0, 255]), { status: 201 }));
	const result = await fetchWithPermission(request, signal(), permission, send);
	expect(permission.mock.calls.map((call) => call[0])).toEqual([
		'https://api.example',
		'https://cdn.example'
	]);
	expect(send.mock.calls[1][0]).toEqual({
		url: 'https://cdn.example/image',
		method: 'GET',
		headers: [],
		body: null
	});
	expect(result).toMatchObject({ url: 'https://cdn.example/image', redirected: true });
	expect(new Uint8Array(await result.response.arrayBuffer())).toEqual(new Uint8Array([0, 255]));
});
it('honors manual/error redirects, preserves POST for 307 and rejects redirect loops', async () => {
	const permission = async () => true;
	const send = vi
		.fn<typeof import('./transport.js').networkHop>()
		.mockImplementation(
			async () => new Response(null, { status: 307, headers: { location: '/next' } })
		);
	const manual = await fetchWithPermission(
		{ ...request, redirect: 'manual' },
		signal(),
		permission,
		send
	);
	expect(manual.response.status).toBe(307);
	await expect(
		fetchWithPermission({ ...request, redirect: 'error' }, signal(), permission, send)
	).rejects.toThrow('redirect');
	send.mockClear();
	await expect(fetchWithPermission(request, signal(), permission, send)).rejects.toThrow(
		'redirect'
	);
	expect(send.mock.calls).toHaveLength(21);
	expect(send.mock.calls[1][0]).toMatchObject({
		method: 'POST',
		body: btoa('{}'),
		headers: request.headers
	});
});
it('cancels before network access and rejects forbidden URLs, headers and oversized bodies', async () => {
	const abort = new AbortController();
	abort.abort();
	const permission = vi.fn(async () => true);
	await expect(fetchWithPermission(request, abort.signal, permission)).rejects.toThrow();
	expect(permission).not.toHaveBeenCalled();
	for (const url of ['file:///secret', 'data:text/plain,secret', 'https://user:key@example.com']) {
		expect(() => networkURL(url)).toThrow();
	}
	for (const header of [
		'cookie',
		'host',
		'origin',
		'sec-fetch-site',
		'proxy-authorization',
		'accept-encoding'
	]) {
		expect(() => parseNetworkRequest({ ...request, headers: [[header, 'value']] })).toThrow();
	}
	expect(() => parseNetworkRequest({ ...request, method: 'CONNECT' })).toThrow();
	expect(() => parseNetworkRequest({ ...request, method: 'GET' })).toThrow();
	expect(() =>
		parseNetworkRequest({ ...request, body: 'a'.repeat(NETWORK_LIMITS.requestBytes * 2) })
	).toThrow();
	expect(() => parseNetworkRequest({ ...request, body: '!!!!' })).toThrow();
	expect(() =>
		parseNetworkRequest({
			...request,
			body: encodeBytes(new Uint8Array(NETWORK_LIMITS.requestBytes))
		})
	).not.toThrow();
});
