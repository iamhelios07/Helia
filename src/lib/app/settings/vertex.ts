export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const SERVICE_ACCOUNT_LIMIT = 64 * 1024;
const ACCOUNT_ERROR = '올바른 Service Account JSON을 입력해주세요. 서비스 계정 키 파일이 필요해요.';

export interface VertexSettings {
	projectId: string;
	location: string;
}
export interface ServiceAccount {
	type: 'service_account';
	project_id: string;
	private_key_id: string;
	private_key: string;
	client_email: string;
	token_uri: typeof GOOGLE_TOKEN_URL;
}

export function parseVertexSettings(value: unknown): VertexSettings {
	if (!value || typeof value !== 'object') {
		throw new Error('프로젝트 ID와 리전을 입력해주세요.');
	}
	const projectId =
		'projectId' in value && typeof value.projectId === 'string' ? value.projectId.trim() : '';
	const location =
		'location' in value && typeof value.location === 'string' ? value.location.trim() : '';
	if (!/^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{6,20})$/.test(projectId)) {
		throw new Error('올바른 Google Cloud 프로젝트 ID 또는 프로젝트 번호를 입력해주세요.');
	}
	if (!/^(?:global|[a-z]+(?:-[a-z0-9]+)+[0-9])$/.test(location) || location.length > 63) {
		throw new Error('올바른 Vertex AI 리전 또는 global을 입력해주세요.');
	}
	return { projectId, location };
}

export function vertexBaseUrl(projectId: string, location: string): string {
	const vertex = parseVertexSettings({ projectId, location });
	const host =
		vertex.location === 'global'
			? 'aiplatform.googleapis.com'
			: `${vertex.location}-aiplatform.googleapis.com`;
	return `https://${host}/v1/projects/${vertex.projectId}/locations/${vertex.location}/publishers/google`;
}

/** Rebuild only the fields needed for Google's JWT grant; never trust arbitrary token URLs. */
export function parseServiceAccountJson(source: string): ServiceAccount {
	try {
		if (new TextEncoder().encode(source).byteLength > SERVICE_ACCOUNT_LIMIT) {
			throw new Error();
		}
		const value: unknown = JSON.parse(source);
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new Error();
		}
		const record = value as Record<string, unknown>;
		if (record.type !== 'service_account' || record.token_uri !== GOOGLE_TOKEN_URL) {
			throw new Error();
		}
		const project = parseVertexSettings({
			projectId: record.project_id,
			location: 'global'
		}).projectId;
		if (
			typeof record.client_email !== 'string' ||
			record.client_email.length > 254 ||
			!/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.gserviceaccount\.com$/.test(record.client_email)
		) {
			throw new Error();
		}
		if (
			typeof record.private_key_id !== 'string' ||
			!/^[a-zA-Z0-9_-]{1,128}$/.test(record.private_key_id)
		) {
			throw new Error();
		}
		if (
			typeof record.private_key !== 'string' ||
			record.private_key.length > 16384 ||
			!/^-----BEGIN PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PRIVATE KEY-----\r?\n?$/.test(
				record.private_key
			)
		) {
			throw new Error();
		}
		return {
			type: 'service_account',
			project_id: project,
			private_key_id: record.private_key_id,
			private_key: record.private_key,
			client_email: record.client_email,
			token_uri: GOOGLE_TOKEN_URL
		};
	} catch {
		throw new Error(ACCOUNT_ERROR);
	}
}
