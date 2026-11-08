import { createPublicKey, verify } from 'node:crypto';
import { expect, it, vi } from 'vitest';

import { GOOGLE_TOKEN_URL, parseServiceAccountJson } from '#lib/app/settings/vertex.js';
import fixture from '#lib/testing/fixtures/service-account.json';

import { VertexAuth, validateServiceAccountKey } from './vertex-auth.js';

const account = parseServiceAccountJson(JSON.stringify(fixture));
it('signs Google JWT grants with the account RSA key and renews cached tokens before expiry', async () => {
	let now = 1_700_000_000_000;
	const send = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
		const params = init!.body as URLSearchParams;
		expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
		const assertion = params.get('assertion')!;
		const [header, claims, signature] = assertion.split('.');
		expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toMatchObject({
			alg: 'RS256',
			kid: account.private_key_id
		});
		expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({
			iss: account.client_email,
			scope: 'https://www.googleapis.com/auth/cloud-platform',
			aud: GOOGLE_TOKEN_URL,
			iat: now / 1000,
			exp: now / 1000 + 3600
		});
		expect(
			verify(
				'RSA-SHA256',
				Buffer.from(`${header}.${claims}`),
				createPublicKey(account.private_key),
				Buffer.from(signature, 'base64url')
			)
		).toBe(true);
		return Response.json({
			access_token: `test-token-${send.mock.calls.length}`,
			expires_in: 3600,
			token_type: 'Bearer'
		});
	});
	const auth = new VertexAuth(send, () => now);
	expect(await auth.accessToken(account)).toBe('test-token-1');
	expect(send.mock.calls[0][0]).toBe(GOOGLE_TOKEN_URL);
	expect(send.mock.calls[0][1]?.redirect).toBe('error');
	expect(await auth.accessToken(account)).toBe('test-token-1');
	expect(send).toHaveBeenCalledTimes(1);
	now += 3541_000;
	expect(await auth.accessToken(account)).toBe('test-token-2');
	auth.clear();
	expect(await auth.accessToken(account)).toBe('test-token-3');
});
it('hides token server errors and rejects invalid keys or token responses without caching failures', async () => {
	expect(() =>
		validateServiceAccountKey({ ...account, private_key: 'invalid-private-key' })
	).toThrow('RSA 개인 키');
	const send = vi.fn<typeof fetch>();
	const auth = new VertexAuth(send);
	for (const response of [
		Response.json({ error: account.private_key }, { status: 400 }),
		Response.json({ access_token: 'secret-token', expires_in: 0, token_type: 'Bearer' }),
		Response.json({ access_token: 'secret-token', expires_in: 3600, token_type: 'Other' })
	]) {
		send.mockResolvedValueOnce(response);
		await expect(auth.accessToken(account)).rejects.toThrow('서비스 계정 인증에 실패');
	}
	expect(send).toHaveBeenCalledTimes(3);
	send.mockRejectedValueOnce(new Error(`remote echoed ${account.private_key}`));
	await expect(auth.accessToken(account)).rejects.not.toThrow('PRIVATE KEY');
});
