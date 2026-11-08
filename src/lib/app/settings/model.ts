import { SERVICE_PRESETS, type ServiceId } from './services.js';
import { parseVertexSettings, vertexBaseUrl, type VertexSettings } from './vertex.js';

export const PROVIDER_KINDS = [
	'openai-compatible',
	'openai-responses',
	'anthropic',
	'google',
	'google-interactions',
	'google-vertex'
] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];
export const PROVIDER_KIND_LABELS: Record<ProviderKind, string> = {
	'openai-compatible': 'OpenAI 호환',
	'openai-responses': 'OpenAI Responses',
	anthropic: 'Anthropic',
	google: 'Google',
	'google-interactions': 'Google Interactions',
	'google-vertex': 'Vertex AI'
};

export interface ProviderSettings {
	id: string;
	name: string;
	kind: ProviderKind;
	baseUrl: string;
	service?: ServiceId;
	vertex?: VertexSettings;
}
export interface ModelSettings {
	id: string;
	name: string;
	providerId: string;
	modelId: string;
}
export interface AISettings {
	version: 1;
	providers: ProviderSettings[];
	models: ModelSettings[];
	defaultModelId: string | null;
}

export function emptyAISettings(): AISettings {
	return { version: 1, providers: [], models: [], defaultModelId: null };
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('설정 데이터의 형식이 올바르지 않아요.');
	}
	return value as Record<string, unknown>;
}
function text(value: unknown, label: string, maxLength = 120): string {
	if (
		typeof value !== 'string' ||
		!value.trim() ||
		value.trim().length > maxLength ||
		/\p{Cc}/u.test(value)
	) {
		throw new Error(`${label}을(를) 1~${maxLength}자로 입력해주세요.`);
	}
	return value.trim();
}
function id(value: unknown): string {
	if (typeof value !== 'string' || !/^[\w-]{1,80}$/.test(value)) {
		throw new Error('설정 항목의 식별자가 올바르지 않아요.');
	}
	return value;
}
function endpoint(value: unknown): string {
	const raw = text(value, '기본 URL', 2048);
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error('올바른 기본 URL을 입력해주세요.');
	}
	if (
		!['https:', 'http:'].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new Error('기본 URL은 인증 정보·쿼리·프래그먼트 없는 HTTP 또는 HTTPS 주소여야 해요.');
	}
	return url.href.replace(/\/+$/, '');
}

/** Rebuild a non-secret document instead of persisting arbitrary caller-supplied fields. */
export function parseAISettings(value: unknown): AISettings {
	const input = object(value);
	if (
		input.version !== 1 ||
		!Array.isArray(input.providers) ||
		!Array.isArray(input.models) ||
		input.providers.length > 64 ||
		input.models.length > 256
	) {
		throw new Error('지원하지 않는 설정 형식이거나 설정 항목이 너무 많아요.');
	}
	const providers: ProviderSettings[] = input.providers.map((item: unknown) => {
		const provider = object(item);
		if (!PROVIDER_KINDS.includes(provider.kind as ProviderKind)) {
			throw new Error('지원하지 않는 API 형식이에요.');
		}
		if (
			provider.service !== undefined &&
			!SERVICE_PRESETS.some((preset) => preset.id === provider.service)
		) {
			throw new Error('지원하지 않는 서비스예요.');
		}
		const vertex =
			provider.kind === 'google-vertex' ? parseVertexSettings(provider.vertex) : undefined;
		return {
			id: id(provider.id),
			name: text(provider.name, '프로바이더 이름'),
			kind: provider.kind as ProviderKind,
			baseUrl: vertex
				? vertexBaseUrl(vertex.projectId, vertex.location)
				: endpoint(provider.baseUrl),
			...(vertex ? { vertex } : {}),
			...(provider.service === undefined ? {} : { service: provider.service as ServiceId })
		};
	});
	const providerIds = new Set(providers.map((provider) => provider.id));
	if (providerIds.size !== providers.length) {
		throw new Error('중복된 프로바이더 식별자가 있어요.');
	}
	const models: ModelSettings[] = input.models.map((item: unknown) => {
		const model = object(item);
		const providerId = id(model.providerId);
		if (!providerIds.has(providerId)) {
			throw new Error('모델에 연결할 프로바이더를 먼저 등록해주세요.');
		}
		return {
			id: id(model.id),
			name: text(model.name, '모델 이름'),
			providerId,
			modelId: text(model.modelId, '모델 ID', 256)
		};
	});
	const modelIds = new Set(models.map((model) => model.id));
	if (modelIds.size !== models.length) {
		throw new Error('중복된 모델 식별자가 있어요.');
	}
	const defaultModelId = input.defaultModelId === null ? null : id(input.defaultModelId);
	if (defaultModelId !== null && !modelIds.has(defaultModelId)) {
		throw new Error('기본 모델이 등록된 모델 목록에 없어요.');
	}
	return { version: 1, providers, models, defaultModelId };
}

export function upsertProvider(settings: AISettings, provider: ProviderSettings): AISettings {
	const exists = settings.providers.some((item) => item.id === provider.id);
	return parseAISettings({
		...settings,
		providers: exists
			? settings.providers.map((item) => (item.id === provider.id ? provider : item))
			: [...settings.providers, provider]
	});
}
export function upsertModel(settings: AISettings, model: ModelSettings): AISettings {
	const exists = settings.models.some((item) => item.id === model.id);
	return parseAISettings({
		...settings,
		models: exists
			? settings.models.map((item) => (item.id === model.id ? model : item))
			: [...settings.models, model],
		defaultModelId: settings.defaultModelId ?? model.id
	});
}
export function removeModel(settings: AISettings, modelId: string): AISettings {
	const models = settings.models.filter((model) => model.id !== modelId);
	return parseAISettings({
		...settings,
		models,
		defaultModelId:
			settings.defaultModelId === modelId ? (models[0]?.id ?? null) : settings.defaultModelId
	});
}
export function removeProvider(settings: AISettings, providerId: string): AISettings {
	const models = settings.models.filter((model) => model.providerId !== providerId);
	return parseAISettings({
		...settings,
		providers: settings.providers.filter((provider) => provider.id !== providerId),
		models,
		defaultModelId: models.some((model) => model.id === settings.defaultModelId)
			? settings.defaultModelId
			: (models[0]?.id ?? null)
	});
}
export function selectDefaultModel(settings: AISettings, modelId: string): AISettings {
	return parseAISettings({ ...settings, defaultModelId: modelId });
}
