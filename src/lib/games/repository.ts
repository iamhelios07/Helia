import { storageRequest } from '#lib/storage/transport.js';
import { createGameRepository } from './repository-core.js';

export const {
	listGames,
	createGame,
	getGameWorkspace,
	updateGame,
	updateGameSettings,
	updateGameRules,
	createSession,
	selectSession,
	renameSession,
	deleteSession,
	getSessionConversation,
	appendUserMessage,
	getSessionHistory,
	commitSessionTransaction,
	selectSessionBranch,
	deleteSessionResponse,
	saveSessionMemory,
	listSessionMemories
} = createGameRepository(storageRequest);
