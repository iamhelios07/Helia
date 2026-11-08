import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { expect, it, vi } from 'vitest';

import { openCredentialStore } from './credentials.js';

function removeTestDirectory(root: string) {
	if (!resolve(root).startsWith(resolve(process.cwd()) + sep + '.credential-path-test-')) {
		throw new Error('Unexpected test cleanup path');
	}
	rmSync(root, { recursive: true, force: true });
}

it('creates a credential key on the project drive without requiring Windows ownership privileges', async () => {
	// The system temp directory can inherit different Windows ownership rights than the project.
	const root = mkdtempSync(join(process.cwd(), '.credential-path-test-'));
	const keyPath = join(root, 'secrets', 'master.key');
	let store = openCredentialStore(join(root, 'credentials.sqlite'), keyPath);
	const provider = {
		id: 'path-test',
		kind: 'openai-compatible',
		baseUrl: 'https://example.com/v1'
	};
	try {
		await store.request({ kind: 'save', provider, apiKey: 'test-only-not-a-real-key' });
		expect(readFileSync(keyPath)).toHaveLength(32);
		expect(await store.request({ kind: 'status', providers: [provider] })).toEqual({
			'path-test': true
		});
		store.close();
		vi.resetModules();
		const { openCredentialStore: reopen } = await import('./credentials.js');
		store = reopen(join(root, 'credentials.sqlite'), keyPath);
		expect(await store.request({ kind: 'status', providers: [provider] })).toEqual({
			'path-test': true
		});
	} finally {
		store.close();
		removeTestDirectory(root);
	}
});
