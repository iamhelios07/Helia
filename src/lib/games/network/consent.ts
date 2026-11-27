import { isNetworkGrantRemembered, rememberNetworkGrant } from './grants.js';

/** Fired when an allow answer asked to remember its origin but the grant could not be stored. */
export const NETWORK_GRANT_REMEMBER_FAILED = 'helia:network-grant-remember-failed';

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

/** Follows the same same-window notification as the grant store itself. */
function reportRememberFailure(origin: string) {
	if (typeof window === 'undefined') {
		return;
	}
	window.dispatchEvent(new CustomEvent<string>(NETWORK_GRANT_REMEMBER_FAILED, { detail: origin }));
}

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
		// A rejected write never turns the allow into a denial; it only means the dialog comes
		// back next time, which the player is told instead of being left to wonder why.
		if (!rememberNetworkGrant(gameId, origin)) {
			reportRememberFailure(origin);
		}
	}
	return answer.allowed;
}
