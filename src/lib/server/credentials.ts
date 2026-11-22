import Database from 'better-sqlite3';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { RoundRequest } from '#lib/games/ai/protocol.js';

import {
	parseCredentialRequest,
	sameCredentialAddress,
	type CredentialRequest,
	type CredentialValue
} from '#lib/app/settings/credential-protocol.js';
import { parseServiceAccountJson } from '#lib/app/settings/vertex.js';

import { generateProvider } from './generation.js';
import { discoverModels } from './model-catalog.js';
import { PrivateKey, KEY_ERROR } from './private-key.js';
import { validateServiceAccountKey, VertexAuth } from './vertex-auth.js';

class CredentialStore {
	private vertexAuth = new VertexAuth();
	private db: Database.Database;
	private key: PrivateKey;
	constructor(filename: string, keyPath: string) {
		mkdirSync(dirname(filename), { recursive: true });
		this.db = new Database(filename);
		this.db.pragma('busy_timeout = 5000');
		this.db.pragma('journal_mode = WAL');
		this.db.pragma('synchronous = FULL');
		this.db.exec(
			'CREATE TABLE IF NOT EXISTS credentials (id TEXT PRIMARY KEY, nonce BLOB NOT NULL, tag BLOB NOT NULL, ciphertext BLOB NOT NULL)'
		);
		this.key = new PrivateKey(
			keyPath,
			() => !!this.db.prepare('SELECT 1 FROM credentials LIMIT 1').get()
		);
	}
	private read(id: string): CredentialValue | null {
		const row = this.db
			.prepare('SELECT nonce, tag, ciphertext FROM credentials WHERE id = ?')
			.get(id) as { nonce: Buffer; tag: Buffer; ciphertext: Buffer } | undefined;
		if (!row) {
			return null;
		}
		try {
			const decipher = createDecipheriv('aes-256-gcm', this.key.read(false), row.nonce);
			decipher.setAAD(Buffer.from(id));
			decipher.setAuthTag(row.tag);
			const value = JSON.parse(
				Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8')
			) as unknown;
			const saved = value as Record<string, unknown>;
			const command = parseCredentialRequest({
				kind: 'save',
				provider: value,
				...(saved.serviceAccount
					? { serviceAccountJson: JSON.stringify(saved.serviceAccount) }
					: { apiKey: saved.apiKey })
			});
			if (command.kind !== 'save' || command.provider.id !== id) {
				throw new Error(KEY_ERROR);
			}
			return {
				...command.provider,
				...('serviceAccountJson' in command
					? { serviceAccount: parseServiceAccountJson(command.serviceAccountJson) }
					: { apiKey: command.apiKey })
			};
		} catch {
			throw new Error(KEY_ERROR);
		}
	}
	private save(input: Extract<CredentialRequest, { kind: 'save' }>) {
		const credential =
			'serviceAccountJson' in input
				? { serviceAccount: parseServiceAccountJson(input.serviceAccountJson) }
				: { apiKey: input.apiKey };
		if (credential.serviceAccount) {
			validateServiceAccountKey(credential.serviceAccount);
		}
		// A wrong or damaged key must not overwrite any existing encrypted records.
		for (const row of this.db.prepare('SELECT id FROM credentials').all() as { id: string }[]) {
			this.read(row.id);
		}
		const key = this.key.read(true);
		const nonce = randomBytes(12);
		const encrypt = createCipheriv('aes-256-gcm', key, nonce);
		encrypt.setAAD(Buffer.from(input.provider.id));
		const ciphertext = Buffer.concat([
			encrypt.update(JSON.stringify({ ...input.provider, ...credential }), 'utf8'),
			encrypt.final()
		]);
		this.db
			.prepare(
				'INSERT INTO credentials (id,nonce,tag,ciphertext) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET nonce=excluded.nonce,tag=excluded.tag,ciphertext=excluded.ciphertext'
			)
			.run(input.provider.id, nonce, encrypt.getAuthTag(), ciphertext);
		this.vertexAuth.clear();
		return {};
	}
	request = async (value: unknown, signal?: AbortSignal): Promise<unknown> => {
		const input = parseCredentialRequest(value);
		if (input.kind === 'status') {
			return Object.fromEntries(
				input.providers.map((provider) => {
					const secret = this.read(provider.id);
					return [provider.id, secret !== null && sameCredentialAddress(secret, provider)];
				})
			);
		}
		if (input.kind === 'delete') {
			this.db.prepare('DELETE FROM credentials WHERE id = ?').run(input.id);
			this.vertexAuth.clear();
			return {};
		}
		if (input.kind === 'save') {
			return this.save(input);
		}
		const secret = this.read(input.provider.id);
		if (!secret || !sameCredentialAddress(secret, input.provider)) {
			throw new Error('이 연결의 주소와 형식에 사용할 인증 정보를 먼저 저장해주세요.');
		}
		if (input.kind === 'verify') {
			if (!secret.serviceAccount) {
				throw new Error('서비스 계정 인증은 Vertex AI 연결에서 사용할 수 있어요.');
			}
			await this.vertexAuth.accessToken(secret.serviceAccount, signal);
			return { verified: true };
		}
		return discoverModels(secret, signal);
	};

	generate = async (
		input: RoundRequest,
		signal: AbortSignal,
		emit: (chunk: string) => void,
		onActivity?: () => void
	) => {
		const secret = this.read(input.provider.id);
		if (!secret || !sameCredentialAddress(secret, input.provider)) {
			throw new Error('이 연결의 주소와 형식에 사용할 인증 정보를 먼저 저장해주세요.');
		}
		return generateProvider(secret, input, {
			signal,
			emit,
			onActivity,
			accessToken: secret.serviceAccount
				? (signal) => this.vertexAuth.accessToken(secret.serviceAccount!, signal)
				: undefined
		});
	};
	close = () => {
		this.vertexAuth.clear();
		this.db.close();
	};
}
export function openCredentialStore(filename: string, keyPath: string) {
	return new CredentialStore(filename, keyPath);
}

let store: ReturnType<typeof openCredentialStore> | undefined;
export function serverCredentials() {
	const directory = resolve(process.env.HELIA_DATA_DIR ?? 'data');
	return (store ??= openCredentialStore(
		resolve(directory, 'credentials.sqlite'),
		resolve(directory, 'secrets', 'master.key')
	));
}
