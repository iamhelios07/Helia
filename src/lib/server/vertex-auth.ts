import { createHash, createPrivateKey, sign } from 'node:crypto';
import { GOOGLE_TOKEN_URL, type ServiceAccount } from '#lib/app/settings/vertex.js';

const AUTH_ERROR =
	'서비스 계정 인증에 실패했어요. JSON 키 상태와 Google Cloud 설정을 확인해주세요.';
export function validateServiceAccountKey(account: ServiceAccount): void {
	try {
		const key = createPrivateKey(account.private_key);
		if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048)
			throw new Error();
	} catch {
		throw new Error(
			'서비스 계정의 RSA 개인 키를 읽을 수 없어요. 올바른 JSON 키를 다시 가져와 주세요.'
		);
	}
}

/** Host-only tokens: never persisted or returned by the settings endpoint. */
export class VertexAuth {
	private tokens = new Map<string, { token: string; expires: number }>();
	constructor(
		private send: typeof fetch = (...args) => fetch(...args),
		private now: () => number = Date.now
	) {}
	clear() {
		this.tokens.clear();
	}
	async accessToken(account: ServiceAccount, signal?: AbortSignal): Promise<string> {
		validateServiceAccountKey(account);
		const fingerprint = createHash('sha256').update(JSON.stringify(account)).digest('hex');
		const cached = this.tokens.get(fingerprint);
		if (cached && cached.expires > this.now() + 60000) return cached.token;
		this.tokens.delete(fingerprint);
		try {
			const issued = Math.floor(this.now() / 1000);
			const header = Buffer.from(
				JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: account.private_key_id })
			).toString('base64url');
			const claims = Buffer.from(
				JSON.stringify({
					iss: account.client_email,
					scope: 'https://www.googleapis.com/auth/cloud-platform',
					aud: GOOGLE_TOKEN_URL,
					iat: issued,
					exp: issued + 3600
				})
			).toString('base64url');
			const input = `${header}.${claims}`;
			const assertion = `${input}.${sign('RSA-SHA256', Buffer.from(input), account.private_key).toString('base64url')}`;
			const response = await this.send(GOOGLE_TOKEN_URL, {
				method: 'POST',
				redirect: 'error',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
					assertion
				}),
				signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])])
			});
			if (!response.ok || !response.body) throw new Error();
			const reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let size = 0;
			try {
				while (true) {
					const { value, done } = await reader.read();
					if (done) break;
					size += value.byteLength;
					if (size > 65536) throw new Error();
					chunks.push(value);
				}
			} finally {
				await reader.cancel().catch(() => {});
			}
			const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
			if (
				!payload ||
				typeof payload !== 'object' ||
				!('access_token' in payload) ||
				!('expires_in' in payload) ||
				!('token_type' in payload)
			)
				throw new Error();
			const { access_token: token, expires_in: expires, token_type: type } = payload;
			if (
				typeof token !== 'string' ||
				!token ||
				token.length > 16384 ||
				/\p{Cc}/u.test(token) ||
				typeof expires !== 'number' ||
				!Number.isInteger(expires) ||
				expires <= 60 ||
				expires > 3600 ||
				typeof type !== 'string' ||
				type.toLowerCase() !== 'bearer'
			)
				throw new Error();
			if (this.tokens.size >= 64) this.tokens.clear();
			this.tokens.set(fingerprint, { token, expires: this.now() + expires * 1000 });
			return token;
		} catch {
			throw new Error(AUTH_ERROR);
		}
	}
}
