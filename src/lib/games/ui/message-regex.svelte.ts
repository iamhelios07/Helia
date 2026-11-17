import type { Message } from '../model.js';
import type { RegexRule } from '../regex.js';

import { transformRegexMessages } from '../regex-runtime.js';

interface DisplayInput {
	messages: Message[];
	rules?: RegexRule[];
}
/** Keeps stored messages intact and cancels obsolete rendering jobs after checkout or edits. */
export class RegexDisplay {
	private result = $state.raw<(DisplayInput & { output: Message[]; error: string }) | null>(null);
	constructor(private readonly read: () => DisplayInput) {
		$effect(() => {
			const input = this.read();
			const abort = new AbortController();
			void transformRegexMessages(input.messages, input.rules, 'display', abort.signal).then(
				(output) => {
					if (!abort.signal.aborted) {
						this.result = { ...input, output, error: '' };
					}
				},
				(error: unknown) => {
					if (!abort.signal.aborted) {
						this.result = {
							...input,
							output: input.messages,
							error: error instanceof Error ? error.message : '표시 규칙을 실행하지 못했어요.'
						};
					}
				}
			);
			return () => abort.abort();
		});
	}
	get messages() {
		const input = this.read();
		return this.result?.messages === input.messages && this.result.rules === input.rules
			? this.result.output
			: input.messages;
	}
	get error() {
		return this.result?.error ?? '';
	}
}
