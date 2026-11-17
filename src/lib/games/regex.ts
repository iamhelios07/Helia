/** Creator-owned chat transformations; array order is execution order. */
export const REGEX_STAGES = [
	{ id: 'input', label: '입력 수정', help: '사용자 입력을 저장하고 AI에 전달하기 전에 적용해요.' },
	{ id: 'output', label: '출력 수정', help: 'AI의 최종 응답을 저장하기 전에 적용해요.' },
	{
		id: 'request',
		label: '요청 수정',
		help: 'AI에 보낼 대화 사본에 적용해요. 저장된 원문은 유지돼요.'
	},
	{
		id: 'display',
		label: '표시 수정',
		help: '화면에만 적용해요. 첫 메시지도 포함하며 원문은 유지돼요.'
	}
] as const;
export type RegexStage = (typeof REGEX_STAGES)[number]['id'];
export type RegexRole = 'user' | 'assistant';
export const REGEX_STAGE_ROLES: Partial<Record<RegexStage, RegexRole>> = {
	input: 'user',
	output: 'assistant'
};
export interface RegexRule {
	id: string;
	name: string;
	enabled: boolean;
	stage: RegexStage;
	roles: RegexRole[];
	pattern: string;
	replacement: string;
	flags: string;
}

export function createRegexRule(): RegexRule {
	return {
		id: crypto.randomUUID(),
		name: '새 규칙',
		enabled: true,
		stage: 'display',
		roles: ['assistant'],
		pattern: '',
		replacement: '',
		flags: 'g'
	};
}

function readRule(value: unknown): RegexRule {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('정규식 규칙은 객체여야 해요.');
	}
	const row = value as Record<string, unknown>;
	for (const key of ['id', 'name', 'pattern', 'replacement', 'flags'] as const) {
		if (typeof row[key] !== 'string') {
			throw new Error(`정규식 ${key}는 문자열이어야 해요.`);
		}
		if (row[key].length > 256 * 1024) {
			throw new Error(`정규식 ${key}가 너무 길어요.`);
		}
	}
	if (typeof row.enabled !== 'boolean' || !REGEX_STAGES.some(({ id }) => id === row.stage)) {
		throw new Error('정규식 사용 여부와 적용 단계를 확인해주세요.');
	}
	if (
		!Array.isArray(row.roles) ||
		!row.roles.length ||
		row.roles.some((r) => r !== 'user' && r !== 'assistant')
	) {
		throw new Error('정규식 대상 메시지를 하나 이상 선택해주세요.');
	}
	if (!(row.id as string).trim()) {
		throw new Error('정규식 규칙 ID가 비어 있어요.');
	}
	return {
		id: row.id as string,
		name: row.name as string,
		enabled: row.enabled,
		stage: row.stage as RegexStage,
		roles: [...new Set(row.roles)] as RegexRole[],
		pattern: row.pattern as string,
		replacement: row.replacement as string,
		flags: row.flags as string
	};
}

/** Structural parsing lets incomplete expressions remain editable in authoring drafts. */
export function readRegexRules(value: unknown): RegexRule[] {
	if (!Array.isArray(value) || value.length > 100) {
		throw new Error('정규식 규칙은 최대 100개의 목록이어야 해요.');
	}
	const rules = value.map(readRule);
	if (new Set(rules.map((r) => r.id)).size !== rules.length) {
		throw new Error('정규식 규칙 ID가 중복되어 있어요.');
	}
	return rules;
}

export function regexProblem(rule: RegexRule): string {
	if (!rule.pattern) {
		return '검색식을 입력해주세요.';
	}
	try {
		new RegExp(rule.pattern, rule.flags);
		return '';
	} catch (error) {
		return error instanceof Error ? error.message : '검색식과 플래그를 확인해주세요.';
	}
}

export function parseRegexRules(value: unknown): RegexRule[] {
	const rules = readRegexRules(value);
	for (const rule of rules) {
		const problem = regexProblem(rule);
		if (rule.enabled && problem) {
			throw new Error(`정규식 ‘${rule.name}’: ${problem}`);
		}
	}
	return rules;
}

/** Pure replacement only: never evaluates code or changes authoritative game data. */
export function applyRegexRules(
	text: string,
	rules: readonly RegexRule[] | undefined,
	stage: RegexStage,
	role: RegexRole
): string {
	for (const rule of rules ?? []) {
		if (rule.enabled && rule.stage === stage && rule.roles.includes(role)) {
			text = text.replace(new RegExp(rule.pattern, rule.flags), rule.replacement);
			if (text.length > 1024 * 1024) {
				throw new Error(`정규식 ‘${rule.name}’의 결과가 너무 길어요.`);
			}
		}
	}
	return text;
}
