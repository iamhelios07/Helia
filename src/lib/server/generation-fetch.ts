import { Agent } from 'undici';

import { AI_LIMITS } from '#lib/games/ai/protocol.js';

// Node fetch defaults can expire before our stream inactivity deadline.
// The generation watchdog owns header/body deadlines and aborts the request.
const dispatcher = new Agent({
	headersTimeout: 0,
	bodyTimeout: 0,
	connectTimeout: AI_LIMITS.streamIdleMs
});

export const generationFetch: typeof fetch = (input, init) => {
	const options = { ...init, dispatcher };
	return fetch(input, options);
};
