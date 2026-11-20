import { isDesktopBuild, isTauri } from '#lib/platform/index.js';

import {
	FILE_ERRORS,
	FILE_LIMITS,
	SessionFileError,
	fileDetails,
	fileScope,
	fileRef,
	fileList,
	filePage,
	storedFile,
	type FileScope,
	type FileListOptions,
	type SessionFiles
} from './model.js';

export interface SessionFileAccess extends SessionFiles {
	subscribe(listener: (ref: string) => void): () => void;
}
interface Notice extends FileScope {
	ref: string;
}
const listeners = new Set<(notice: Notice) => void>();
let channel: BroadcastChannel | undefined;
function publish(notice: Notice) {
	deliver(notice);
	try {
		channel?.postMessage(notice);
	} catch {
		/* Notifications cannot undo a saved file. */
	}
}
function deliver(notice: Notice) {
	for (const listener of listeners) {
		try {
			listener(notice);
		} catch {
			/* A detached view cannot fail a committed write. */
		}
	}
}
function subscribe(scope: FileScope, listener: (ref: string) => void) {
	if (!channel && typeof BroadcastChannel !== 'undefined') {
		channel = new BroadcastChannel('helia:session-files');
		channel.onmessage = ({ data }: MessageEvent<Notice>) => {
			if (!data || typeof data !== 'object') {
				return;
			}
			deliver(data);
		};
	}
	const receive = (notice: Notice) => {
		if (notice.gameId === scope.gameId && notice.sessionId === scope.sessionId) {
			listener(notice.ref);
		}
	};
	listeners.add(receive);
	return () => {
		listeners.delete(receive);
	};
}
function fileError(error: unknown): never {
	if (error instanceof SessionFileError) {
		throw error;
	}
	const code = String(error);
	throw new SessionFileError(FILE_ERRORS.find((item) => code === item) ?? 'FILE_UNAVAILABLE');
}
function base64(bytes: Uint8Array): string {
	let text = '';
	for (let offset = 0; offset < bytes.length; offset += 16384) {
		text += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
	}
	return btoa(text);
}
async function native(scope: FileScope, operation: Record<string, unknown>): Promise<unknown> {
	const host: unknown = Reflect.get(window, '__HELIA_STORAGE__');
	if (!isTauri() || window !== window.top || typeof host !== 'function') {
		throw new SessionFileError('FILE_UNAVAILABLE');
	}
	try {
		return await host({ kind: 'files', ...scope, operation });
	} catch (error) {
		return fileError(error);
	}
}
async function checked(response: Response) {
	if (response.ok) {
		return response;
	}
	const error: unknown = await response.json().catch(() => null);
	const code = error && typeof error === 'object' && 'error' in error ? error.error : '';
	return fileError(code);
}
function remoteQuery(scope: FileScope, endpoint: string) {
	return async function query(
		kind: 'read' | 'stat' | 'list' | 'remove',
		options: Record<string, string | number>
	) {
		if (isDesktopBuild) {
			return native(scope, { kind, ...options });
		}
		const query = new URLSearchParams(
			Object.entries(options).map(([key, value]) => [key, String(value)])
		);
		if (kind === 'stat') {
			query.set('stat', '1');
		}
		const response = await checked(
			await fetch(endpoint + '?' + query, {
				method: kind === 'remove' ? 'DELETE' : 'GET',
				cache: 'no-store'
			})
		);
		if (kind === 'remove') {
			return null;
		}
		return kind === 'read' ? response.blob() : response.json();
	};
}

async function saveRemote(scope: FileScope, endpoint: string, blob: Blob, name: string) {
	if (!(blob instanceof Blob)) {
		throw new SessionFileError('FILE_INPUT');
	}
	const details = fileDetails(name ?? 'file', blob.type || 'application/octet-stream', blob.size);
	const value = isDesktopBuild
		? await native(scope, {
				kind: 'save',
				...details,
				data: base64(new Uint8Array(await blob.arrayBuffer()))
			})
		: await (
				await checked(
					await fetch(endpoint + '?' + new URLSearchParams({ name: details.name }), {
						method: 'POST',
						headers: { 'content-type': details.mime },
						body: blob
					})
				)
			).json();
	const file = storedFile(value);
	return file;
}

export function sessionFiles(input: FileScope): SessionFileAccess {
	const scope = fileScope(input);
	const endpoint = `/api/games/${encodeURIComponent(scope.gameId)}/sessions/${encodeURIComponent(scope.sessionId)}/files`;
	const query = remoteQuery(scope, endpoint);
	return {
		async save(blob, options = {}) {
			const file = await saveRemote(scope, endpoint, blob, options.name ?? 'file');
			publish({ ...scope, ref: file.ref });
			return file;
		},
		async read(ref) {
			const value = await query('read', { ref: fileRef(ref) });
			if (value instanceof Blob) {
				fileDetails('file', value.type, value.size);
				return value;
			}
			if (
				!value ||
				typeof value !== 'object' ||
				!('data' in value) ||
				typeof value.data !== 'string' ||
				value.data.length > Math.ceil(FILE_LIMITS.fileBytes / 3) * 4 ||
				!('info' in value)
			) {
				throw new SessionFileError('FILE_INPUT');
			}
			const info = storedFile(value.info);
			const bytes = Uint8Array.from(atob(value.data), (character) => character.charCodeAt(0));
			if (bytes.length !== info.size) {
				throw new SessionFileError('FILE_INPUT');
			}
			return new Blob([bytes], { type: info.mime });
		},
		async stat(ref) {
			return storedFile(await query('stat', { ref: fileRef(ref) }));
		},
		async list(options: FileListOptions = {}) {
			const page = fileList(options);
			return filePage(
				await query('list', { limit: page.limit, ...(page.cursor ? { cursor: page.cursor } : {}) })
			);
		},
		async remove(ref) {
			await query('remove', { ref: fileRef(ref) });
			publish({ ...scope, ref });
		},
		subscribe: (listener) => subscribe(scope, listener)
	};
}
