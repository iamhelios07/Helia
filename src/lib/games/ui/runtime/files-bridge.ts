import type { SessionFileAccess } from '../../files/client.js';

import { SessionFileError, fileDetails, fileRef, fileList } from '../../files/model.js';

async function execute(files: SessionFileAccess, input: unknown) {
	if (!input || typeof input !== 'object') {
		throw new SessionFileError('FILE_INPUT');
	}
	const operation = input as Record<string, unknown>;
	if (operation.kind === 'save') {
		if (!(operation.blob instanceof Blob)) {
			throw new SessionFileError('FILE_INPUT');
		}
		const details = fileDetails(
			operation.name,
			operation.blob.type || 'application/octet-stream',
			operation.blob.size
		);
		return files.save(operation.blob, { name: details.name });
	}
	if (operation.kind === 'list') {
		const options = fileList(operation as { cursor?: string; limit?: number });
		return files.list({
			limit: options.limit,
			...(options.cursor ? { cursor: options.cursor } : {})
		});
	}
	const ref = fileRef(operation.ref);
	if (operation.kind === 'read') {
		return files.read(ref);
	}
	if (operation.kind === 'stat') {
		return files.stat(ref);
	}
	if (operation.kind === 'remove') {
		await files.remove(ref);
		return null;
	}
	throw new SessionFileError('FILE_INPUT');
}
export class FileBridge {
	private pending = 0;
	private disposed = false;
	private unsubscribe: () => void;
	constructor(
		private files: SessionFileAccess,
		private send: (message: unknown) => void
	) {
		this.unsubscribe = files.subscribe((ref) => this.send({ kind: 'files-changed', ref }));
	}
	async receive(input: unknown) {
		if (!input || typeof input !== 'object' || this.disposed) {
			return;
		}
		const message = input as Record<string, unknown>;
		if (
			message.kind !== 'files' ||
			typeof message.id !== 'string' ||
			!/^\d{1,12}$/.test(message.id)
		) {
			return;
		}
		const id = message.id;
		if (this.pending >= 16) {
			this.send({ kind: 'file-response', id, ok: false, error: 'FILE_UNAVAILABLE' });
			return;
		}
		this.pending++;
		try {
			const result = await execute(this.files, message.operation);
			if (!this.disposed) {
				this.send({ kind: 'file-response', id, ok: true, result });
			}
		} catch (error) {
			if (!this.disposed) {
				this.send({
					kind: 'file-response',
					id,
					ok: false,
					error: error instanceof SessionFileError ? error.code : 'FILE_UNAVAILABLE'
				});
			}
		} finally {
			this.pending--;
		}
	}
	dispose() {
		this.disposed = true;
		this.unsubscribe();
	}
}
