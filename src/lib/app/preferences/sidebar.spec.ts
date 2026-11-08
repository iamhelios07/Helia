import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	DEFAULT_SIDEBAR_WIDTH,
	MIN_SIDEBAR_WIDTH,
	SIDEBAR_WIDTH_STORAGE_KEY,
	SIDEBAR_COLLAPSED_STORAGE_KEY,
	loadSidebarWidth,
	saveSidebarWidth,
	loadSidebarCollapsed,
	saveSidebarCollapsed
} from './sidebar.js';

afterEach(() => vi.unstubAllGlobals());

describe('sidebar width preference', () => {
	it('stores collapse state separately without changing the width preference', () => {
		const values = new Map<string, string>();
		vi.stubGlobal('localStorage', {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value)
		});
		expect(loadSidebarCollapsed()).toBe(false);
		saveSidebarWidth(470);
		saveSidebarCollapsed(true);
		expect(loadSidebarCollapsed()).toBe(true);
		expect(loadSidebarWidth()).toBe(470);
		saveSidebarCollapsed(false);
		expect(loadSidebarCollapsed()).toBe(false);
		values.set(SIDEBAR_COLLAPSED_STORAGE_KEY, 'invalid');
		expect(loadSidebarCollapsed()).toBe(false);
	});
	it('restores the chosen width without adapting it to a temporary viewport', () => {
		const values = new Map<string, string>();
		vi.stubGlobal('localStorage', {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value)
		});
		expect(loadSidebarWidth()).toBe(DEFAULT_SIDEBAR_WIDTH);
		saveSidebarWidth(472.4);
		expect(values.get(SIDEBAR_WIDTH_STORAGE_KEY)).toBe('472');
		expect(loadSidebarWidth()).toBe(472);
	});

	it('ignores malformed stored widths and invalid writes', () => {
		const getItem = vi.fn();
		const setItem = vi.fn();
		vi.stubGlobal('localStorage', { getItem, setItem });
		for (const value of [null, '', ' ', 'not a number', '-1', '0', '219', 'NaN', 'Infinity']) {
			getItem.mockReturnValue(value);
			expect(loadSidebarWidth()).toBe(DEFAULT_SIDEBAR_WIDTH);
		}
		for (const value of [NaN, Infinity, -Infinity, -1, 0, MIN_SIDEBAR_WIDTH - 1]) {
			saveSidebarWidth(value);
		}
		expect(setItem).not.toHaveBeenCalled();
	});

	it('keeps resizing usable when storage is unavailable', () => {
		vi.stubGlobal('localStorage', {
			getItem: () => {
				throw new Error('Storage blocked');
			},
			setItem: () => {
				throw new Error('Quota exceeded');
			}
		});
		expect(loadSidebarWidth()).toBe(DEFAULT_SIDEBAR_WIDTH);
		expect(() => saveSidebarWidth(400)).not.toThrow();
		expect(loadSidebarCollapsed()).toBe(false);
		expect(() => saveSidebarCollapsed(true)).not.toThrow();
		vi.stubGlobal('localStorage', undefined);
		expect(loadSidebarWidth()).toBe(DEFAULT_SIDEBAR_WIDTH);
		expect(() => saveSidebarWidth(400)).not.toThrow();
		expect(loadSidebarCollapsed()).toBe(false);
		expect(() => saveSidebarCollapsed(true)).not.toThrow();
	});
});
