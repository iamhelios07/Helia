import type { Game } from './model.js';

import { compileScripts } from './scripting/script-build.js';
import { contentHash } from './state/model.js';
import { buildGameUI } from './ui/runtime/build.js';

/** Builds are derived data; creator code is never executed while preparing them. */
export async function buildRuntime<T extends Pick<Game, 'scripts' | 'ui' | 'schema'>>(
	game: T
): Promise<T> {
	const sourceScripts = Object.fromEntries(
		Object.entries(game.scripts).map(([id, script]) => [
			id,
			{
				language: script.language,
				source: script.source,
				...(script.compiledFor === contentHash([script.source, game.schema])
					? { compiled: script.compiled }
					: {})
			}
		])
	);
	const input = { scripts: sourceScripts, schema: game.schema };
	const compiled = await compileScripts(input);
	const scripts = Object.fromEntries(
		compiled.map(({ id, source }) => [
			id,
			{
				...game.scripts[id],
				compiled: source,
				compiledFor: contentHash([game.scripts[id].source, game.schema])
			}
		])
	);
	const ui = game.ui
		? {
				...game.ui,
				compiled:
					game.ui.compiled?.sourceHash === contentHash([game.ui.entry, game.ui.modules])
						? game.ui.compiled
						: await buildGameUI(game.ui)
			}
		: undefined;
	return { ...game, scripts, ui };
}
