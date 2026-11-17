import { expect, it } from 'vitest';

import type { MessageInput } from '#lib/games/model.js';

import { agentMessages, MessageEchoFilter, removeMessageEcho } from './message-echo.js';

const card = '<style>.receipt{color:gold}</style><article>제작 영수증 · 25G</article>';
const messages: MessageInput[] = [{ role: 'assistant', content: card }];

it.each([
	[card + '손님 반응', '손님 반응'],
	['앞 이야기' + card + '뒤 이야기', '앞 이야기뒤 이야기'],
	['손님 반응' + card, '손님 반응'],
	[card + card + '손님 반응', '손님 반응'],
	['<article>다른 영수증</article>', '<article>다른 영수증</article>'],
	['<style>.receipt', '<style>.receipt']
])('removes only complete exact copies: %s', (text, expected) => {
	expect(removeMessageEcho(text, messages)).toBe(expected);
});

it('preserves both sides of every streaming chunk boundary', () => {
	const text = '앞 이야기' + card + '손님 반응' + card;
	for (let split = 0; split <= text.length; split++) {
		const filter = new MessageEchoFilter(messages);
		const output =
			filter.push(text.slice(0, split)) + filter.push(text.slice(split)) + filter.finish();
		expect(output, `split ${split}`).toBe('앞 이야기손님 반응');
	}
	const filter = new MessageEchoFilter(messages);
	expect([...text].map((char) => filter.push(char)).join('') + filter.finish()).toBe(
		'앞 이야기손님 반응'
	);
});

it('does not suppress user cards or ordinary prose and recognizes multiple authored cards', () => {
	const other = '<b>두 번째 카드</b>';
	const authored: MessageInput[] = [
		...messages,
		{ role: 'assistant', content: other },
		{ role: 'assistant', content: '안녕하세요' },
		{ role: 'user', content: '<b>사용자 카드</b>' }
	];
	expect(removeMessageEcho(card + other + '안녕하세요<b>사용자 카드</b>', authored)).toBe(
		'안녕하세요<b>사용자 카드</b>'
	);
});

it('retains an authored answer without appending a blank final message', () => {
	expect(agentMessages(card, messages)).toEqual(messages);
	expect(agentMessages(card + '손님 반응', messages)).toEqual([
		...messages,
		{ role: 'assistant', content: '손님 반응' }
	]);
	expect(() => agentMessages(' ', [{ role: 'user', content: card }])).toThrow();
});
