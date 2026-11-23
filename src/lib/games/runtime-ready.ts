import type { Game } from './model.js';

export function runtimeReady(game: Pick<Game, 'scripts' | 'ui'>): boolean {
	return (
		Object.values(game.scripts).every(
			(script) => script.compiled !== undefined || !!script.artifact
		) &&
		(!game.ui || !!game.ui.compiled || !!game.ui.artifact)
	);
}
