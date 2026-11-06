import { expect, it, vi } from 'vitest';
import { POST } from './+server.js';

const request = vi.hoisted(() => vi.fn());
vi.mock('#lib/server/credentials.js', () => ({ serverCredentials: () => ({ request }) }));
const call = (origin: string, body = '{}') =>
	POST({
		request: new Request('http://localhost/api/credentials', {
			method: 'POST',
			headers: { origin, 'content-type': 'application/json' },
			body
		}),
		url: new URL('http://localhost/api/credentials')
	} as Parameters<typeof POST>[0]);
it('rejects opaque creator origins and invalid bodies before accessing credentials', async () => {
	request.mockClear();
	expect((await call('null')).status).toBe(403);
	expect((await call('https://other.example')).status).toBe(403);
	expect((await call('http://localhost', 'invalid')).status).toBe(400);
	expect(request).not.toHaveBeenCalled();
});
it('marks responses no-store and hides untrusted exception details', async () => {
	request.mockResolvedValueOnce({ connection: true });
	const response = await call('http://localhost');
	expect(response.headers.get('cache-control')).toBe('no-store');
	expect(await response.json()).toEqual({ connection: true });
	request.mockRejectedValueOnce(new Error('secret-token-in-error'));
	const failure = await call('http://localhost');
	expect(await failure.text()).not.toContain('secret-token-in-error');
});
