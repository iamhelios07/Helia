import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearSettingsDraft, loadSettingsDraft, storeSettingsDraft } from './settings-draft.js';

afterEach(() => {
	vi.restoreAllMocks();
	localStorage.clear();
});

describe('pending settings recovery', () => {
	const input = {
		title: '게임',
		description: '  설명\n',
		firstMessage: '\n첫 장면',
		authorNote: ''
	};
	it('keeps recovery data separate for each game and preserves text', () => {
		storeSettingsDraft('first', input);
		storeSettingsDraft('second', { ...input, title: '다른 게임' });
		expect(loadSettingsDraft('first')).toEqual(input);
		expect(loadSettingsDraft('second')?.title).toBe('다른 게임');
	});
	it('does not erase a newer edit when an older save completes', () => {
		const latest = { ...input, authorNote: '마지막 수정' };
		storeSettingsDraft('first', latest);
		clearSettingsDraft('first', input);
		expect(loadSettingsDraft('first')).toEqual(latest);
		clearSettingsDraft('first', latest);
		expect(loadSettingsDraft('first')).toBeNull();
	});
	it('rejects malformed recovery data', () => {
		for (const value of [
			'{',
			'[]',
			'null',
			'{"title":42}',
			JSON.stringify({ ...input, firstMessage: null })
		]) {
			localStorage.setItem('helia:settings-draft:first', value);
			expect(loadSettingsDraft('first')).toBeNull();
		}
	});
	it('allows autosave to continue when recovery storage is blocked', () => {
		vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
			throw new Error('Blocked');
		});
		vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new Error('Full');
		});
		expect(() => storeSettingsDraft('first', input)).not.toThrow();
		expect(loadSettingsDraft('first')).toBeNull();
		expect(() => clearSettingsDraft('first', input)).not.toThrow();
	});
});
