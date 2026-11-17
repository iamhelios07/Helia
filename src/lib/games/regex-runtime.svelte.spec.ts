import { expect, it } from 'vitest';

import { transformRegexMessages, transformRegexText } from './regex-runtime.js';
import { createRegexRule } from './regex.js';

it('runs real worker replacements on copies and preserves message metadata', async () => {
	const messages = [
		{ id: 'first', role: 'assistant' as const, content: '[손님: 엘렌]' },
		{ id: 'second', role: 'user' as const, content: '[손님: 엘렌]' }
	];
	const rules = [{ ...createRegexRule(), pattern: '\\[손님: (.*?)\\]', replacement: '<b>$1</b>' }];
	const result = await transformRegexMessages(messages, rules, 'display');
	expect(result).toEqual([{ id: 'first', role: 'assistant', content: '<b>엘렌</b>' }, messages[1]]);
	expect(messages[0].content).toBe('[손님: 엘렌]');
	expect(await transformRegexMessages(messages, rules, 'output')).toBe(messages);
});

it('terminates pathological expressions and can execute again after a timeout', async () => {
	const rule = { ...createRegexRule(), pattern: '(a+)+$', replacement: 'x' };
	await expect(
		transformRegexText('a'.repeat(40) + '!', [rule], { stage: 'display', role: 'assistant' })
	).rejects.toThrow('시간이 초과');
	expect(
		await transformRegexText('a', [{ ...rule, pattern: 'a' }], {
			stage: 'display',
			role: 'assistant'
		})
	).toBe('x');
});

it('cancels in-flight matching', async () => {
	const abort = new AbortController();
	const result = transformRegexText(
		'a'.repeat(40) + '!',
		[{ ...createRegexRule(), pattern: '(a+)+$', replacement: '' }],
		{ stage: 'display', role: 'assistant', signal: abort.signal }
	);
	abort.abort();
	await expect(result).rejects.toThrow('취소');
});
