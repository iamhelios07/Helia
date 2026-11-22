import Database from 'better-sqlite3';
import {
	createCipheriv,
	createDecipheriv,
	createHmac,
	randomBytes,
	timingSafeEqual
} from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { networkHeaders } from '#lib/games/network/protocol.js';
import {
	secretScope,
	secretOperation,
	secretSignatureInput,
	SECRET_MARKER,
	SECRET_ERROR,
	type SecretOperation
} from '#lib/games/secrets/protocol.js';

import { PrivateKey } from './private-key.js';

interface SavedSecret {
	value: string;
	url: string;
}
/** This database, key and record format cannot read provider credentials. */
export class GameSecretStore {
	private db: Database.Database;
	private key: PrivateKey;
	constructor(filename: string, keyPath: string) {
		mkdirSync(dirname(filename), { recursive: true });
		this.db = new Database(filename);
		this.db.pragma('busy_timeout = 5000');
		this.db.pragma('journal_mode = WAL');
		this.db.pragma('synchronous = FULL');
		this.db.exec(
			'CREATE TABLE IF NOT EXISTS game_secrets (game_id TEXT NOT NULL, name TEXT NOT NULL, nonce BLOB NOT NULL, tag BLOB NOT NULL, ciphertext BLOB NOT NULL, PRIMARY KEY(game_id,name))'
		);
		this.key = new PrivateKey(
			keyPath,
			() => !!this.db.prepare('SELECT 1 FROM game_secrets LIMIT 1').get()
		);
	}
	private read(gameId: string, name: string): SavedSecret | null {
		const row = this.db
			.prepare('SELECT nonce,tag,ciphertext FROM game_secrets WHERE game_id=? AND name=?')
			.get(gameId, name) as { nonce: Buffer; tag: Buffer; ciphertext: Buffer } | undefined;
		if (!row) {
			return null;
		}
		const cipher = createDecipheriv('aes-256-gcm', this.key.read(false), row.nonce);
		cipher.setAAD(Buffer.from(JSON.stringify(['game-secret', gameId, name])));
		cipher.setAuthTag(row.tag);
		const value: unknown = JSON.parse(
			Buffer.concat([cipher.update(row.ciphertext), cipher.final()]).toString('utf8')
		);
		const operation = secretOperation({ ...(value as object), name, kind: 'set' });
		if (operation.kind !== 'set') {
			throw new TypeError(SECRET_ERROR);
		}
		return { value: operation.value, url: operation.url };
	}
	request(game: unknown, input: unknown): boolean | string | null {
		try {
			return this.execute(secretScope(game), secretOperation(input));
		} catch {
			throw new TypeError(SECRET_ERROR);
		}
	}
	private execute(gameId: string, input: SecretOperation): boolean | string | null {
		if (input.kind === 'remove') {
			this.db
				.prepare('DELETE FROM game_secrets WHERE game_id=? AND name=?')
				.run(gameId, input.name);
			return null;
		}
		if (input.kind === 'set') {
			this.save(gameId, input);
			return null;
		}
		const saved = this.read(gameId, input.name);
		if (input.kind === 'has') {
			return saved !== null;
		}
		if (!saved) {
			throw new TypeError(SECRET_ERROR);
		}
		return (
			SECRET_MARKER + input.name + ':' + this.signature(gameId, input.name, saved).toString('hex')
		);
	}
	private signature(gameId: string, name: string, secret: SavedSecret) {
		return createHmac('sha256', secret.value)
			.update(secretSignatureInput(gameId, name, secret.url))
			.digest();
	}
	private save(gameId: string, input: Extract<SecretOperation, { kind: 'set' }>) {
		// Verify the active key before replacing any records, even when saving another game's secret.
		for (const row of this.db.prepare('SELECT game_id,name FROM game_secrets').all() as {
			game_id: string;
			name: string;
		}[]) {
			this.read(row.game_id, row.name);
		}
		const nonce = randomBytes(12),
			cipher = createCipheriv('aes-256-gcm', this.key.read(true), nonce);
		cipher.setAAD(Buffer.from(JSON.stringify(['game-secret', gameId, input.name])));
		const ciphertext = Buffer.concat([
			cipher.update(JSON.stringify({ value: input.value, url: input.url }), 'utf8'),
			cipher.final()
		]);
		this.db
			.prepare(
				'INSERT INTO game_secrets (game_id,name,nonce,tag,ciphertext) VALUES (?,?,?,?,?) ON CONFLICT(game_id,name) DO UPDATE SET nonce=excluded.nonce,tag=excluded.tag,ciphertext=excluded.ciphertext'
			)
			.run(gameId, input.name, nonce, cipher.getAuthTag(), ciphertext);
	}
	authorize(
		scope: unknown,
		url: string,
		headers: [string, string][]
	): { headers: [string, string][]; values: string[] } {
		const values = new Set<string>();
		let references = 0;
		const expanded = headers.map(([name, value]): [string, string] => [
			name,
			value.replace(
				/helia-secret:v1:([A-Za-z][\w.-]{0,63}):([a-f0-9]{64})(?![\w.-])/g,
				(_match, key: string, signature: string) => {
					const gameId = secretScope(scope),
						saved = this.read(gameId, key);
					if (++references > 16) {
						throw new TypeError(SECRET_ERROR);
					}
					if (
						!saved ||
						saved.url !== url ||
						!timingSafeEqual(this.signature(gameId, key, saved), Buffer.from(signature, 'hex'))
					) {
						throw new TypeError(SECRET_ERROR);
					}
					values.add(saved.value);
					return saved.value;
				}
			)
		]);
		if (expanded.some(([, value]) => value.includes(SECRET_MARKER))) {
			throw new TypeError(SECRET_ERROR);
		}
		return { headers: networkHeaders(expanded), values: [...values] };
	}
	close() {
		this.db.close();
	}
}
let store: GameSecretStore | undefined;
export function serverGameSecrets() {
	const directory = resolve(process.env.HELIA_DATA_DIR ?? 'data');
	return (store ??= new GameSecretStore(
		resolve(directory, 'game-secrets.sqlite'),
		resolve(directory, 'secrets', 'game-secrets.key')
	));
}
