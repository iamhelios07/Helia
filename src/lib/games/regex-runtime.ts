import { applyRegexRules, type RegexRole, type RegexRule, type RegexStage } from './regex.js';

interface TextMessage {
	role: RegexRole;
	content: string;
}
export const REGEX_TIMEOUT_MS = 1500;

/** Browser matching runs off the UI thread so a pathological expression is cancellable. */
export async function transformRegexMessages<T extends TextMessage>(
	messages: T[],
	rules: RegexRule[] | undefined,
	stage: RegexStage,
	signal?: AbortSignal
): Promise<T[]> {
	if (signal?.aborted) {
		throw new Error('정규식 실행이 취소되었어요.');
	}
	const active = rules?.filter((r) => r.enabled && r.stage === stage);
	if (!active?.length || !messages.some((m) => active.some((r) => r.roles.includes(m.role)))) {
		return messages;
	}
	if (typeof Worker === 'undefined') {
		return messages.map((m) => ({
			...m,
			content: applyRegexRules(m.content, active, stage, m.role)
		}));
	}
	const content = await workerContent(messages, active, stage, signal);
	return messages.map((m, i) => ({ ...m, content: content[i] }));
}

function workerContent(
	messages: TextMessage[],
	rules: RegexRule[],
	stage: RegexStage,
	signal?: AbortSignal
): Promise<string[]> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(new URL('./regex-worker.ts', import.meta.url), { type: 'module' });
		const finish = (error?: string, content?: string[]) => {
			clearTimeout(timeout);
			signal?.removeEventListener('abort', cancel);
			worker.terminate();
			if (error) {
				reject(new Error(error));
			} else {
				resolve(content!);
			}
		};
		const cancel = () => finish('정규식 실행이 취소되었어요.');
		const timeout = setTimeout(
			() => finish('정규식 실행 시간이 초과되었어요. 검색식을 단순하게 수정해주세요.'),
			REGEX_TIMEOUT_MS
		);
		signal?.addEventListener('abort', cancel, { once: true });
		worker.onerror = () => finish('정규식 실행기를 시작하지 못했어요.');
		worker.onmessage = (event: MessageEvent<{ content?: string[]; error?: string }>) =>
			finish(event.data.error, event.data.content);
		try {
			// Strip Svelte proxies and send only the text that rules are allowed to edit.
			worker.postMessage(
				JSON.parse(
					JSON.stringify({
						messages: messages.map(({ role, content }) => ({ role, content })),
						rules,
						stage
					})
				)
			);
		} catch {
			finish('정규식 실행 요청을 전달하지 못했어요.');
		}
	});
}

export async function transformRegexText(
	text: string,
	rules: RegexRule[] | undefined,
	context: { stage: RegexStage; role: RegexRole; signal?: AbortSignal }
): Promise<string> {
	const [result] = await transformRegexMessages(
		[{ role: context.role, content: text }],
		rules,
		context.stage,
		context.signal
	);
	return result.content;
}
