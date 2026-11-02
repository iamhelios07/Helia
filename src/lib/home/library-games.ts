import type { Game } from '#lib/games/model.js';

/** Saved-game fields displayed by the library and navigation rail. */
export type LibraryGame = Pick<Game, 'id' | 'title' | 'genre' | 'description' | 'updatedAt'>;

export function toLibraryGame(game: Game): LibraryGame {
	return {
		id: game.id,
		title: game.title,
		genre: game.genre,
		description: game.description,
		updatedAt: game.updatedAt
	};
}
