import type { MessageInput } from '#lib/games/model.js';

import { aiError } from './protocol.js';

/** Suppress exact HTML cards already authored by Actions in this invocation. */
export class MessageEchoFilter {
	private pending = '';
	private cards: string[];
	constructor(messages: readonly MessageInput[]) {
		this.cards = [
			...new Set(
				messages
					.filter((message) => message.role === 'assistant')
					.map((message) => message.content.trim())
					.filter((content) => content.startsWith('<') && content.endsWith('>'))
			)
		].sort((a, b) => b.length - a.length);
	}
	push(text: string): string {
		this.pending += text;
		let output = '';
		for (;;) {
			const match = this.nextCard();
			if (!match) {
				const end = this.partialStart();
				output += this.pending.slice(0, end);
				this.pending = this.pending.slice(end);
				return output;
			}
			output += this.pending.slice(0, match.index);
			this.pending = this.pending.slice(match.index + match.card.length);
		}
	}
	finish(): string {
		const text = this.pending;
		this.pending = '';
		return text;
	}
	private nextCard() {
		let match: { index: number; card: string } | undefined;
		for (const card of this.cards) {
			const index = this.pending.indexOf(card);
			if (index >= 0 && (!match || index < match.index)) {
				match = { index, card };
			}
		}
		return match;
	}
	private partialStart() {
		const longest = this.cards[0]?.length ?? 0;
		let index = this.pending.indexOf('<', Math.max(0, this.pending.length - longest + 1));
		while (index >= 0) {
			const suffix = this.pending.slice(index);
			if (this.cards.some((card) => card.startsWith(suffix))) {
				return index;
			}
			index = this.pending.indexOf('<', index + 1);
		}
		return this.pending.length;
	}
}

export function removeMessageEcho(text: string, messages: readonly MessageInput[]): string {
	const filter = new MessageEchoFilter(messages);
	return filter.push(text) + filter.finish();
}

export function agentMessages(
	text: string,
	messages: readonly MessageInput[] = []
): MessageInput[] {
	const content = removeMessageEcho(text, messages);
	if (content.trim()) {
		return [...messages, { role: 'assistant', content }];
	}
	if (!messages.some((message) => message.role === 'assistant')) {
		throw aiError('protocol');
	}
	return [...messages];
}
