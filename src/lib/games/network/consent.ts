import { isNetworkGrantRemembered, rememberNetworkGrant } from './grants.js';

export interface ConsentAnswer {
	allowed: boolean;
	/** Honored only for an allow answer; a denial is never remembered. */
	remember: boolean;
}
export type ConsentPrompt = (
	origin: string,
	signal: AbortSignal,
	canRemember: boolean
) => Promise<ConsentAnswer>;

/**
 * A remembered grant only skips the dialog. The origin has already passed the shared fetch
 * normalization, and the host still applies its own address checks to every request.
 */
export async function resolveConsent(
	origin: string,
	signal: AbortSignal,
	gameId: string | undefined,
	prompt: ConsentPrompt
): Promise<boolean> {
	if (signal.aborted) {
		return false;
	}
	if (gameId && isNetworkGrantRemembered(gameId, origin)) {
		return true;
	}
	const answer = await prompt(origin, signal, gameId !== undefined);
	if (answer.allowed && answer.remember && gameId && !signal.aborted) {
		rememberNetworkGrant(gameId, origin);
	}
	return answer.allowed;
}
