import { building } from '$app/env';

import { isDesktopBuild } from '#lib/platform/index.js';
import { serverStorage } from '#lib/server/sqlite.js';

/** Recover before serving requests, including when the next client never reconnects. */
export function init() {
	if (!building && !isDesktopBuild) {
		serverStorage();
	}
}
