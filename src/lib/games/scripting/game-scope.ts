import type { ActionRunner } from './protocol.js';

export function gameActions(run: ActionRunner, gameId: string): ActionRunner {
	return (input, options) => run(input, { ...options, gameId });
}
