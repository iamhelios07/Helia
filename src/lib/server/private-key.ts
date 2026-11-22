import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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
import { dirname } from 'node:path';

const STORE_ERROR = '보안 저장소를 사용할 수 없어요. 저장 경로와 접근 권한을 확인해주세요.';
export const KEY_ERROR =
	'암호화 키를 읽거나 확인할 수 없어요. 원래 키 파일을 복구하거나 저장된 API 키를 명시적으로 삭제한 후 다시 등록해주세요.';
const securedDirectories = new Set<string>();
/** Restrict the new private directory before putting any secret in it, including on Windows. */
function privateDirectory(path: string, keyPath: string) {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new Error(STORE_ERROR);
	}
	if (process.platform === 'win32') {
		const securedPath = JSON.stringify([path, keyPath]);
		if (!securedDirectories.has(securedPath)) {
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
			securedDirectories.add(securedPath);
		}
	} else if ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
		throw new Error(STORE_ERROR);
	}
}

function linkMasterKey(temporary: string, keyPath: string) {
	try {
		linkSync(temporary, keyPath);
	} catch (error) {
		if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) {
			throw error;
		}
	}
}
function syncKeyDirectory(keyPath: string) {
	if (process.platform === 'win32') {
		return;
	}
	const directory = openSync(dirname(keyPath), 'r');
	try {
		fsyncSync(directory);
	} finally {
		closeSync(directory);
	}
}
function createMasterKey(keyPath: string) {
	const temporary = `${keyPath}.${randomBytes(12).toString('hex')}.tmp`;
	let descriptor: number | undefined;
	try {
		descriptor = openSync(temporary, 'wx', 0o600);
		writeFileSync(descriptor, randomBytes(32));
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		linkMasterKey(temporary, keyPath);
		syncKeyDirectory(keyPath);
	} finally {
		if (descriptor !== undefined) {
			closeSync(descriptor);
		}
		if (existsSync(temporary)) {
			unlinkSync(temporary);
		}
	}
}
export class PrivateKey {
	constructor(
		private keyPath: string,
		private hasRecords: () => boolean
	) {}
	read(create: boolean): Buffer {
		try {
			privateDirectory(dirname(this.keyPath), this.keyPath);
		} catch {
			throw new Error(STORE_ERROR);
		}
		try {
			if (!existsSync(this.keyPath)) {
				if (!create || this.hasRecords()) {
					throw new Error(KEY_ERROR);
				}
				createMasterKey(this.keyPath);
			}
			const stat = lstatSync(this.keyPath);
			if (
				!stat.isFile() ||
				stat.isSymbolicLink() ||
				stat.size !== 32 ||
				(process.platform !== 'win32' &&
					((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
			) {
				throw new Error(KEY_ERROR);
			}
			const key = readFileSync(this.keyPath);
			if (key.length !== 32) {
				throw new Error(KEY_ERROR);
			}
			return key;
		} catch {
			throw new Error(KEY_ERROR);
		}
	}
}
