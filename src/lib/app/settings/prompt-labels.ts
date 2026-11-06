import type { PromptType } from '#lib/games/ai/prompts.js';

export const PROMPT_TYPE_LABELS: Record<PromptType, string> = {
	plain: '순수 프롬프트',
	jailbreak: '탈옥 프롬프트',
	chat: '챗',
	persona: '페르소나 프롬프트',
	description: '캐릭터 설명',
	authornote: '작가의 노트',
	lorebook: '로어북',
	memory: '장기 기억',
	postEverything: '최종 삽입 프롬프트',
	cot: '생각의 사슬',
	chatML: 'ChatML',
	cache: '캐시 포인트'
};
