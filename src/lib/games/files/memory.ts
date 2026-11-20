import type { SessionFileAccess } from './client.js';
import type { StoredFile } from './model.js';

import { FILE_LIMITS, SessionFileError, fileDetails, fileRef, fileList } from './model.js';

/** Each authoring preview owns a separate store that disappears with that preview. */
export function memorySessionFiles(): SessionFileAccess {
	const files = new Map<string, { info: StoredFile; blob: Blob }>();
	const listeners = new Set<(ref: string) => void>();
	const notify = (ref: string) => {
		for (const listener of listeners) {
			try {
				listener(ref);
			} catch {
				/* Match committed host notification behavior. */
			}
		}
	};
	function get(ref: string) {
		const file = files.get(fileRef(ref));
		if (!file) {
			throw new SessionFileError('FILE_NOT_FOUND');
		}
		return file;
	}
	return {
		async save(blob, options = {}) {
			if (!(blob instanceof Blob)) {
				throw new SessionFileError('FILE_INPUT');
			}
			const details = fileDetails(
				options.name ?? 'file',
				blob.type || 'application/octet-stream',
				blob.size
			);
			const used = [...files.values()].reduce((sum, file) => sum + file.info.size, 0);
			if (used + blob.size > FILE_LIMITS.sessionBytes || files.size >= FILE_LIMITS.count) {
				throw new SessionFileError('FILE_QUOTA');
			}
			const info = {
				ref: 'helia-file:' + crypto.randomUUID(),
				...details,
				createdAt: new Date().toISOString()
			};
			files.set(info.ref, { info, blob: blob.slice(0, blob.size, details.mime) });
			notify(info.ref);
			return { ...info };
		},
		async read(ref) {
			const { blob } = get(ref);
			return blob.slice(0, blob.size, blob.type);
		},
		async stat(ref) {
			return { ...get(ref).info };
		},
		async list(options = {}) {
			const page = fileList(options);
			const rows = [...files.values()]
				.filter((file) => file.info.ref > page.cursor)
				.sort((a, b) => a.info.ref.localeCompare(b.info.ref))
				.slice(0, page.limit + 1);
			const more = rows.length > page.limit;
			if (more) {
				rows.pop();
			}
			return {
				files: rows.map((row) => ({ ...row.info })),
				nextCursor: more ? rows.at(-1)!.info.ref : null
			};
		},
		async remove(ref) {
			get(ref);
			files.delete(ref);
			notify(ref);
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		}
	};
}
