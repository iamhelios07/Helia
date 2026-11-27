import type { Game } from './model.js';

import { compileAuthoringGame } from './code-project.js';
import { contentHash } from './state/model.js';

type Runtime = Pick<Game, 'scripts' | 'ui'>;
const CAPACITY = 4;

/** Repository-local LRU: app/compiler upgrades start empty, and no installed data is written. */
export class LockedPlayRuntimeCache {
	private entries = new Map<string, { fingerprint: string; runtime: Promise<Runtime> }>();

	async prepare(game: Game): Promise<Runtime> {
		// Include persisted build caches too: buildRuntime can use them as compiler input.
		const fingerprint = contentHash([game.id, game.schema, game.code, game.scripts, game.ui]);
		let entry = this.entries.get(game.id);
		if (entry?.fingerprint !== fingerprint) {
			entry = {
				fingerprint,
				runtime: compileAuthoringGame(game).then(({ scripts, ui }) => ({ scripts, ui }))
			};
		}
		this.entries.delete(game.id);
		this.entries.set(game.id, entry);
		if (this.entries.size > CAPACITY) {
			const oldest = this.entries.keys().next();
			if (!oldest.done) {
				this.entries.delete(oldest.value);
			}
		}
		try {
			// Callers must not be able to mutate the result reused by another play open.
			return structuredClone(await entry.runtime);
		} catch (error) {
			if (this.entries.get(game.id) === entry) {
				this.entries.delete(game.id);
			}
			throw error;
		}
	}
}
