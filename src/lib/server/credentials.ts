import Database from 'better-sqlite3';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
	closeSync,
	existsSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeFileSync
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
	parseCredentialRequest,
	sameCredentialAddress,
	type CredentialValue
} from '#lib/app/settings/credential-protocol.js';
import { discoverModels } from './model-catalog.js';
import { parseServiceAccountJson } from '#lib/app/settings/vertex.js';
import { validateServiceAccountKey, VertexAuth } from './vertex-auth.js';
import { generateProvider } from './generation.js';
import type { RoundRequest } from '#lib/games/ai/protocol.js';

const STORE_ERROR = '보안 저장소를 사용할 수 없어요. 저장 경로와 접근 권한을 확인해주세요.';
const KEY_ERROR =
	'암호화 키를 읽거나 확인할 수 없어요. 원래 키 파일을 복구하거나 저장된 API 키를 명시적으로 삭제한 후 다시 등록해주세요.';
const securedDirectories = new Set<string>();
/** Restrict the new private directory before putting any secret in it, including on Windows. */
function privateDirectory(path: string, keyPath: string) {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(STORE_ERROR);
	if (process.platform === 'win32') {
		if (!securedDirectories.has(path)) {
			execFileSync(
				'powershell.exe',
				[
					'-NoProfile',
					'-NonInteractive',
					'-Command',
					`
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object System.Security.AccessControl.DirectorySecurity
# Restrict the DACL without requesting WRITE_OWNER on inherited project directories.
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
(Get-Item -LiteralPath $env:HELIA_PRIVATE_DIRECTORY).SetAccessControl($acl)
if (Test-Path -LiteralPath $env:HELIA_PRIVATE_KEY) {
  $fileAcl = New-Object System.Security.AccessControl.FileSecurity
  $fileAcl.SetAccessRuleProtection($true, $false)
  $fileAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')))
  (Get-Item -LiteralPath $env:HELIA_PRIVATE_KEY).SetAccessControl($fileAcl)
}
`
				],
				{
					env: { ...process.env, HELIA_PRIVATE_DIRECTORY: path, HELIA_PRIVATE_KEY: keyPath },
					stdio: 'ignore',
					windowsHide: true
				}
			);
			securedDirectories.add(path);
		}
	} else if ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
		throw new Error(STORE_ERROR);
}

export function openCredentialStore(filename: string, keyPath: string) {
	const vertexAuth = new VertexAuth();
	mkdirSync(dirname(filename), { recursive: true });
	const db = new Database(filename);
	db.pragma('busy_timeout = 5000');
	db.pragma('journal_mode = WAL');
	db.pragma('synchronous = FULL');
	db.exec(
		'CREATE TABLE IF NOT EXISTS credentials (id TEXT PRIMARY KEY, nonce BLOB NOT NULL, tag BLOB NOT NULL, ciphertext BLOB NOT NULL)'
	);

	function masterKey(create: boolean): Buffer {
		try {
			privateDirectory(dirname(keyPath), keyPath);
		} catch {
			throw new Error(STORE_ERROR);
		}
		try {
			if (!existsSync(keyPath)) {
				if (!create || db.prepare('SELECT 1 FROM credentials LIMIT 1').get())
					throw new Error(KEY_ERROR);
				const temporary = `${keyPath}.${randomBytes(12).toString('hex')}.tmp`;
				let descriptor: number | undefined;
				try {
					descriptor = openSync(temporary, 'wx', 0o600);
					writeFileSync(descriptor, randomBytes(32));
					fsyncSync(descriptor);
					closeSync(descriptor);
					descriptor = undefined;
					try {
						linkSync(temporary, keyPath);
					} catch (error) {
						if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST'))
							throw error;
					}
					if (process.platform !== 'win32') {
						const directory = openSync(dirname(keyPath), 'r');
						try {
							fsyncSync(directory);
						} finally {
							closeSync(directory);
						}
					}
				} finally {
					if (descriptor !== undefined) closeSync(descriptor);
					if (existsSync(temporary)) unlinkSync(temporary);
				}
			}
			const stat = lstatSync(keyPath);
			if (
				!stat.isFile() ||
				stat.isSymbolicLink() ||
				stat.size !== 32 ||
				(process.platform !== 'win32' &&
					((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
			)
				throw new Error(KEY_ERROR);
			const key = readFileSync(keyPath);
			if (key.length !== 32) throw new Error(KEY_ERROR);
			return key;
		} catch {
			throw new Error(KEY_ERROR);
		}
	}
	function read(id: string): CredentialValue | null {
		const row = db
			.prepare('SELECT nonce, tag, ciphertext FROM credentials WHERE id = ?')
			.get(id) as { nonce: Buffer; tag: Buffer; ciphertext: Buffer } | undefined;
		if (!row) return null;
		try {
			const decipher = createDecipheriv('aes-256-gcm', masterKey(false), row.nonce);
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
			if (command.kind !== 'save' || command.provider.id !== id) throw new Error(KEY_ERROR);
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
	async function request(value: unknown, signal?: AbortSignal): Promise<unknown> {
		const input = parseCredentialRequest(value);
		if (input.kind === 'status')
			return Object.fromEntries(
				input.providers.map((provider) => {
					const secret = read(provider.id);
					return [provider.id, secret !== null && sameCredentialAddress(secret, provider)];
				})
			);
		if (input.kind === 'delete') {
			db.prepare('DELETE FROM credentials WHERE id = ?').run(input.id);
			vertexAuth.clear();
			return {};
		}
		if (input.kind === 'save') {
			const credential =
				'serviceAccountJson' in input
					? { serviceAccount: parseServiceAccountJson(input.serviceAccountJson) }
					: { apiKey: input.apiKey };
			if (credential.serviceAccount) validateServiceAccountKey(credential.serviceAccount);
			// A wrong or damaged key must not overwrite any existing encrypted records.
			for (const row of db.prepare('SELECT id FROM credentials').all() as { id: string }[])
				read(row.id);
			const key = masterKey(true);
			const nonce = randomBytes(12);
			const encrypt = createCipheriv('aes-256-gcm', key, nonce);
			encrypt.setAAD(Buffer.from(input.provider.id));
			const ciphertext = Buffer.concat([
				encrypt.update(JSON.stringify({ ...input.provider, ...credential }), 'utf8'),
				encrypt.final()
			]);
			db.prepare(
				'INSERT INTO credentials (id,nonce,tag,ciphertext) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET nonce=excluded.nonce,tag=excluded.tag,ciphertext=excluded.ciphertext'
			).run(input.provider.id, nonce, encrypt.getAuthTag(), ciphertext);
			vertexAuth.clear();
			return {};
		}
		const secret = read(input.provider.id);
		if (!secret || !sameCredentialAddress(secret, input.provider))
			throw new Error('이 연결의 주소와 형식에 사용할 인증 정보를 먼저 저장해주세요.');
		if (input.kind === 'verify') {
			if (!secret.serviceAccount)
				throw new Error('서비스 계정 인증은 Vertex AI 연결에서 사용할 수 있어요.');
			await vertexAuth.accessToken(secret.serviceAccount, signal);
			return { verified: true };
		}
		return discoverModels(secret, signal);
	}
	return {
		request,
		async generate(input: RoundRequest, signal: AbortSignal, emit: (chunk: string) => void) {
			const secret = read(input.provider.id);
			if (!secret || !sameCredentialAddress(secret, input.provider))
				throw new Error('이 연결의 주소와 형식에 사용할 인증 정보를 먼저 저장해주세요.');
			return generateProvider(
				secret,
				input,
				signal,
				emit,
				secret.serviceAccount
					? (signal) => vertexAuth.accessToken(secret.serviceAccount!, signal)
					: undefined
			);
		},
		close: () => {
			vertexAuth.clear();
			db.close();
		}
	};
}

let store: ReturnType<typeof openCredentialStore> | undefined;
export function serverCredentials() {
	const directory = resolve(process.env.HELIA_DATA_DIR ?? 'data');
	return (store ??= openCredentialStore(
		resolve(directory, 'credentials.sqlite'),
		resolve(directory, 'secrets', 'master.key')
	));
}
