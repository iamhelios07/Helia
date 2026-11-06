import type { ProviderKind } from './model.js';

export type ServiceId =
	| 'openai'
	| 'anthropic'
	| 'google'
	| 'vertex-ai'
	| 'openrouter'
	| 'ollama-cloud'
	| 'cerebras'
	| 'nanogpt'
	| 'deepseek'
	| 'vercel-ai-gateway'
	| 'custom';
export interface ServicePreset {
	id: ServiceId;
	name: string;
	description: string;
	kind: ProviderKind;
	baseUrl: string;
	keyUrl: string | null;
}
export const SERVICE_PRESETS: readonly ServicePreset[] = [
	{
		id: 'openai',
		name: 'OpenAI',
		description: 'OpenAI API에 연결합니다.',
		kind: 'openai-compatible',
		baseUrl: 'https://api.openai.com/v1',
		keyUrl: 'https://platform.openai.com/api-keys'
	},
	{
		id: 'anthropic',
		name: 'Anthropic',
		description: 'Claude API에 연결합니다.',
		kind: 'anthropic',
		baseUrl: 'https://api.anthropic.com/v1',
		keyUrl: 'https://platform.claude.com/settings/keys'
	},
	{
		id: 'google',
		name: 'Google',
		description: 'Gemini API에 연결합니다.',
		kind: 'google',
		baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
		keyUrl: 'https://aistudio.google.com/apikey'
	},
	{
		id: 'vertex-ai',
		name: 'Vertex AI',
		description: 'Service Account JSON으로 Google Cloud에 연결합니다.',
		kind: 'google-vertex',
		baseUrl: 'https://aiplatform.googleapis.com/v1',
		keyUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts'
	},
	{
		id: 'openrouter',
		name: 'OpenRouter',
		description: '여러 서비스의 모델을 한 연결에서 사용합니다.',
		kind: 'openai-compatible',
		baseUrl: 'https://openrouter.ai/api/v1',
		keyUrl: 'https://openrouter.ai/settings/keys'
	},
	{
		id: 'ollama-cloud',
		name: 'Ollama Cloud',
		description: 'Ollama의 클라우드 모델에 연결합니다.',
		kind: 'openai-compatible',
		baseUrl: 'https://ollama.com/v1',
		keyUrl: 'https://ollama.com/settings/keys'
	},
	{
		id: 'cerebras',
		name: 'Cerebras',
		description: 'Cerebras Inference API에 연결합니다.',
		kind: 'openai-compatible',
		baseUrl: 'https://api.cerebras.ai/v1',
		keyUrl: 'https://cloud.cerebras.ai/platform'
	},
	{
		id: 'nanogpt',
		name: 'NanoGPT',
		description: 'NanoGPT의 모델을 한 연결에서 사용합니다.',
		kind: 'openai-compatible',
		baseUrl: 'https://nano-gpt.com/api/v1',
		keyUrl: 'https://nano-gpt.com/api'
	},
	{
		id: 'deepseek',
		name: 'DeepSeek',
		description: 'DeepSeek API에 연결합니다.',
		kind: 'openai-compatible',
		baseUrl: 'https://api.deepseek.com',
		keyUrl: 'https://platform.deepseek.com/api_keys'
	},
	{
		id: 'vercel-ai-gateway',
		name: 'Vercel AI Gateway',
		description: 'Vercel의 통합 AI 게이트웨이에 연결합니다.',
		kind: 'openai-compatible',
		baseUrl: 'https://ai-gateway.vercel.sh/v1',
		keyUrl: 'https://vercel.com/dashboard/ai-gateway'
	},
	{
		id: 'custom',
		name: '사용자 지정',
		description: 'API 주소와 형식을 직접 설정합니다.',
		kind: 'openai-compatible',
		baseUrl: '',
		keyUrl: null
	}
];
export function getServicePreset(id?: ServiceId): ServicePreset {
	return (
		SERVICE_PRESETS.find((preset) => preset.id === id) ??
		SERVICE_PRESETS[SERVICE_PRESETS.length - 1]
	);
}
