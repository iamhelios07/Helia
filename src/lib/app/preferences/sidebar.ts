export const SIDEBAR_WIDTH_STORAGE_KEY = 'helia:sidebar-width';
export const SIDEBAR_COLLAPSED_STORAGE_KEY = 'helia:sidebar-collapsed';
export const DEFAULT_SIDEBAR_WIDTH = 320;
export const MIN_SIDEBAR_WIDTH = 220;

function isSidebarWidth(value: number): boolean {
	return Number.isFinite(value) && value >= MIN_SIDEBAR_WIDTH;
}

/** A device preference, deliberately separate from any game's data. */
export function loadSidebarWidth(): number {
	try {
		const stored = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
		if (stored !== null) {
			const width = Number(stored);
			if (isSidebarWidth(width)) {
				return Math.round(width);
			}
		}
	} catch {
		// The workspace remains usable when storage is blocked or during SSR.
	}
	return DEFAULT_SIDEBAR_WIDTH;
}

export function saveSidebarWidth(width: number): void {
	if (!isSidebarWidth(width)) {
		return;
	}
	try {
		localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(width)));
	} catch {
		// A preference write failure must not interrupt interaction with the game.
	}
}

export function loadSidebarCollapsed(): boolean {
	try {
		return localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true';
	} catch {
		return false;
	}
}

export function saveSidebarCollapsed(collapsed: boolean): void {
	try {
		localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(collapsed));
	} catch {
		// The toggle still works when preferences cannot be persisted.
	}
}
