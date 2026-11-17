import { applyRegexRules, type RegexRole, type RegexRule, type RegexStage } from './regex.js';

self.onmessage = (
	event: MessageEvent<{
		messages: { role: RegexRole; content: string }[];
		rules: RegexRule[];
		stage: RegexStage;
	}>
) => {
	try {
		const { messages, rules, stage } = event.data;
		const content = messages.map((m) => applyRegexRules(m.content, rules, stage, m.role));
		self.postMessage({ content });
	} catch (error) {
		self.postMessage({
			error: error instanceof Error ? error.message : '정규식을 실행하지 못했어요.'
		});
	}
};
