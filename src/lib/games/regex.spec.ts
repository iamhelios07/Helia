import { describe, expect, it } from 'vitest';

import { applyRegexRules, createRegexRule, parseRegexRules, readRegexRules } from './regex.js';

describe('creator chat regex rules', () => {
	it('uses captures, literal replacement strings, flags and array order without mutating rules', () => {
		const rules = [
			{ ...createRegexRule(), pattern: '\\[손님: (.*?)\\]', replacement: '<b>$1</b>' },
			{ ...createRegexRule(), pattern: '<b>(.*?)</b>', replacement: '<strong>$1</strong>' }
		];
		const before = JSON.stringify(rules);
		expect(applyRegexRules('[손님: 엘렌] [손님: 토마스]', rules, 'display', 'assistant')).toBe(
			'<strong>엘렌</strong> <strong>토마스</strong>'
		);
		expect(applyRegexRules('[손님: 엘렌]', [...rules].reverse(), 'display', 'assistant')).toBe(
			'<b>엘렌</b>'
		);
		expect(JSON.stringify(rules)).toBe(before);
		expect(
			applyRegexRules(
				'aA',
				[{ ...rules[0], pattern: 'a', replacement: '$&!', flags: 'i' }],
				'display',
				'assistant'
			)
		).toBe('a!A');
	});
	it('isolates stages, roles and disabled rules', () => {
		const rule = { ...createRegexRule(), pattern: 'old', replacement: 'new' };
		expect(applyRegexRules('old', [rule], 'request', 'assistant')).toBe('old');
		expect(applyRegexRules('old', [rule], 'display', 'user')).toBe('old');
		expect(applyRegexRules('old', [{ ...rule, enabled: false }], 'display', 'assistant')).toBe(
			'old'
		);
		expect(applyRegexRules('old', [rule], 'display', 'assistant')).toBe('new');
	});
	it('preserves incomplete drafts but rejects enabled invalid expressions at apply time', () => {
		const rule = { ...createRegexRule(), pattern: '[' };
		expect(readRegexRules([rule])[0].pattern).toBe('[');
		expect(() => parseRegexRules([rule])).toThrow('정규식');
		expect(parseRegexRules([{ ...rule, enabled: false }])[0].enabled).toBe(false);
		expect(() => parseRegexRules([{ ...rule, pattern: 'a', flags: 'gg' }])).toThrow();
		expect(() => parseRegexRules([{ ...rule, pattern: '' }])).toThrow('검색식');
	});
	it('validates untrusted shapes, duplicate IDs and expansion limits', () => {
		const rule = { ...createRegexRule(), pattern: 'a' };
		expect(() => readRegexRules([rule, rule])).toThrow('중복');
		expect(() => readRegexRules([{ ...rule, roles: [] }])).toThrow('대상');
		expect(() => readRegexRules([{ ...rule, roles: ['system'] }])).toThrow('대상');
		expect(() => readRegexRules([{ ...rule, stage: 'unknown' }])).toThrow('단계');
		expect(() => readRegexRules({})).toThrow('목록');
		expect(() =>
			applyRegexRules(
				'a'.repeat(100),
				[{ ...rule, replacement: 'b'.repeat(20000) }],
				'display',
				'assistant'
			)
		).toThrow('결과가 너무 길어요');
	});
});
