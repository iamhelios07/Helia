import { runCreatorAction } from '#lib/games/scripting/browser.js';
import { storageRequest } from '#lib/storage/transport.js';

import { publishSessionAIEvent } from './ai/activity.js';
import { invokeSessionAI } from './ai/browser.js';
import { createGameRepository } from './repository-core.js';

export const {
	listGames,
	createGame,
	getGameWorkspace,
	updateGame,
	updateGameSettings,
	applyGameDraft,
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
	subscribeSessionChanges,
	selectSessionBranch,
	deleteSessionResponse,
	saveSessionMemory,
	listSessionMemories,
	commitSessionAgent,
	executeSessionAgentHook
} = createGameRepository(storageRequest, {
	runAction: runCreatorAction,
	requestAI: (gameId, sessionId, input) => {
		void invokeSessionAI(gameId, sessionId, input).catch((error) =>
			publishSessionAIEvent(gameId, sessionId, {
				type: 'error',
				message: error instanceof Error ? error.message : 'AI 요청을 완료하지 못했어요.'
			})
		);
	}
});
