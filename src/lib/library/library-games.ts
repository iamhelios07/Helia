import type { GameSummary } from '#lib/games/model.js';

/** Saved-game fields displayed by the library and navigation rail. */
export type LibraryGame = Pick<
	GameSummary,
	'id' | 'title' | 'genre' | 'description' | 'updatedAt' | 'editLock'
>;

export function toLibraryGame(game: GameSummary): LibraryGame {
	return {
		id: game.id,
		title: game.title,
		genre: game.genre,
		description: game.description,
		updatedAt: game.updatedAt,
		...(game.editLock === undefined ? {} : { editLock: game.editLock })
	};
}
