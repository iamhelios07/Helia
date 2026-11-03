import { storageRequest } from '#lib/storage/transport.js';
import { createGameRepository } from './repository-core.js';
import { runCreatorAction } from '#lib/creator-runtime/browser.js';

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
	getSessionTimeline,
	deleteSessionEvent,
	commitSessionTransaction,
	executeSessionAction,
	subscribeSessionEvents,
	selectSessionBranch,
	deleteSessionResponse,
	saveSessionMemory,
	listSessionMemories
} = createGameRepository(storageRequest, { runAction: runCreatorAction });
