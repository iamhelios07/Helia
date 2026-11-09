import '../../../app.css';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';

import { createGame } from '#lib/games/repository.js';
import { memoryAISettingsTransport } from '#lib/testing/ai-settings.js';
import AppFixture from '#lib/testing/AppFixture.svelte';
import fixture from '#lib/testing/fixtures/service-account.json';

import type { CatalogModel } from './credentials.js';

import {
	getCredentialStatus,
	saveCredential,
	deleteCredential,
	fetchProviderModels,
	saveServiceAccountCredential,
	verifyProviderCredential
} from './credentials.js';
import { emptyAISettings, upsertProvider, upsertModel } from './model.js';
import { AI_SETTINGS_KEY, loadAISettings, saveAISettings } from './repository.js';
import { SERVICE_PRESETS } from './services.js';
import { SettingsDialogController } from './settings-dialog-controller.svelte.js';
import { aiSettingsRequest } from './settings-transport.js';
import SettingsDialog from './SettingsDialog.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('./settings-transport.js', () => ({ aiSettingsRequest: vi.fn() }));
vi.mock('./credentials.js', () => ({
	getCredentialStatus: vi.fn(),
	saveCredential: vi.fn(),
	deleteCredential: vi.fn(),
	fetchProviderModels: vi.fn(),
	saveServiceAccountCredential: vi.fn(),
	verifyProviderCredential: vi.fn()
}));
vi.mock('#lib/storage/transport.js', async () => {
	const { memoryStorage } = await import('#lib/testing/memory-storage.js');
	return { storageRequest: memoryStorage() };
});

beforeEach(async () => {
	localStorage.clear();
	vi.mocked(aiSettingsRequest).mockReset().mockImplementation(memoryAISettingsTransport());
	vi.mocked(getCredentialStatus)
		.mockReset()
		.mockImplementation(async (providers) =>
			Object.fromEntries(providers.map((provider) => [provider.id, true]))
		);
	vi.mocked(saveCredential).mockReset().mockResolvedValue();
	vi.mocked(deleteCredential).mockReset().mockResolvedValue();
	vi.mocked(saveServiceAccountCredential).mockReset().mockResolvedValue();
	vi.mocked(verifyProviderCredential).mockReset().mockResolvedValue();
	vi.mocked(fetchProviderModels)
		.mockReset()
		.mockResolvedValue([{ id: 'org/fast', name: 'Fast' }]);
	await page.viewport(1280, 900);
});
afterEach(() => vi.restoreAllMocks());

const dialog = () => page.getByRole('dialog', { name: '설정', exact: true });
const nav = () => page.getByRole('navigation', { name: '설정 메뉴', exact: true });
const stored = () => loadAISettings();
async function seed() {
	const provider = {
		id: 'provider-one',
		name: '내 연결',
		kind: 'openai-compatible' as const,
		baseUrl: 'https://example.com/v1'
	};
	return saveAISettings(
		upsertModel(upsertProvider(emptyAISettings(), provider), {
			id: 'model-one',
			name: '내 모델',
			providerId: provider.id,
			modelId: 'org/model-one'
		})
	);
}
async function newConnection(name = '테스트 연결') {
	await page.getByRole('button', { name: '새 연결', exact: true }).click();
	await page.getByRole('textbox', { name: '연결 이름', exact: true }).fill(name);
}
async function manualModel(name: string, modelId: string) {
	await page.getByRole('button', { name: '모델 직접 추가', exact: true }).click();
	await page.getByRole('textbox', { name: '표시 이름', exact: true }).fill(name);
	await page.getByRole('textbox', { name: '모델 ID', exact: true }).fill(modelId);
	await page.getByRole('button', { name: '모델 저장', exact: true }).click();
	await expect
		.element(page.getByRole('button', { name: `${name} 모델 편집`, exact: true }))
		.toBeVisible();
}

it.each([
	{ id: 'ollama-cloud', name: 'Ollama Cloud', baseUrl: 'https://ollama.com/v1' },
	{ id: 'cerebras', name: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1' },
	{ id: 'nanogpt', name: 'NanoGPT', baseUrl: 'https://nano-gpt.com/api/v1' },
	{ id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com' },
	{ id: 'vercel-ai-gateway', name: 'Vercel AI Gateway', baseUrl: 'https://ai-gateway.vercel.sh/v1' }
])(
	'configures $name without requiring a manually entered API URL',
	async ({ id, name, baseUrl }) => {
		const screen = render(SettingsDialog, { onclose: vi.fn() });
		await page.getByRole('button', { name: '새 연결', exact: true }).click();
		await page.getByRole('button', { name, exact: true }).click();
		await expect
			.element(page.getByRole('textbox', { name: '연결 이름', exact: true }))
			.toHaveValue(name);
		await page.getByLabelText('API 키', { exact: true }).fill('preset-test-only-secret');
		await page.getByRole('button', { name: '모델 선택', exact: true }).click();
		await expect
			.element(page.getByRole('button', { name: 'Fast 모델 추가', exact: true }))
			.toBeVisible();
		expect(saveCredential).toHaveBeenCalledWith(
			expect.objectContaining({ service: id, name, baseUrl, kind: 'openai-compatible' }),
			'preset-test-only-secret'
		);
		expect((await stored()).providers[0].service).toBe(id);
		expect(SERVICE_PRESETS.filter((preset) => preset.id === id)).toHaveLength(1);
		expect(JSON.stringify(await stored())).not.toContain('preset-test-only-secret');
		await screen.unmount();
	}
);

it('opens full-screen settings, traps focus and restores the existing game draft and DOM', async () => {
	const game = await createGame();
	const screen = render(AppFixture, { view: 'game', gameId: game.id });
	const message = page.getByRole('textbox', { name: '메시지', exact: true });
	await message.fill('작성 중인 메시지');
	const node = message.element();
	const gear = page.getByRole('button', { name: '설정', exact: true });
	await gear.click();
	await expect.element(dialog()).toBeVisible();
	await expect.element(page.getByRole('heading', { name: 'API 연결', exact: true })).toBeVisible();
	await userEvent.keyboard('{Tab}');
	expect(dialog().element().contains(document.activeElement)).toBe(true);
	await userEvent.keyboard('{Escape}');
	await expect.poll(() => dialog().query()).toBeNull();
	expect(message.element()).toBe(node);
	await expect.element(message).toHaveValue('작성 중인 메시지');
	await expect.element(gear).toHaveFocus();
	await screen.unmount();
});

it('saves a service key outside metadata, discovers models and supports aliases and default selection', async () => {
	const screen = render(AppFixture, { view: 'home' });
	const gear = page.getByRole('button', { name: '설정', exact: true });
	await gear.click();
	await newConnection();
	await page.getByLabelText('API 키', { exact: true }).fill('test-secret-never-persist');
	await page.getByRole('button', { name: '모델 선택', exact: true }).click();
	await expect
		.element(page.getByRole('button', { name: 'Fast 모델 추가', exact: true }))
		.toBeVisible();
	expect(saveCredential).toHaveBeenCalledWith(
		expect.objectContaining({ service: 'openai', baseUrl: 'https://api.openai.com/v1' }),
		'test-secret-never-persist'
	);
	expect(fetchProviderModels).toHaveBeenCalled();
	expect(JSON.stringify(await stored())).not.toContain('test-secret');
	await expect.element(page.getByLabelText('API 키', { exact: true })).toHaveValue('');
	await page.getByRole('button', { name: 'Fast 모델 추가', exact: true }).click();
	await expect
		.element(page.getByRole('textbox', { name: '모델 ID', exact: true }))
		.toHaveValue('org/fast');
	await page.getByRole('button', { name: '모델 저장', exact: true }).click();
	await manualModel('빠른 모델 별칭', 'org/fast');
	await page.getByRole('button', { name: '빠른 모델 별칭 기본 모델로 설정', exact: true }).click();
	expect((await stored()).models.map((model) => model.modelId)).toEqual(['org/fast', 'org/fast']);
	expect((await stored()).defaultModelId).toBe((await stored()).models[1].id);
	await nav().getByRole('button', { name: '모델', exact: true }).click();
	await expect
		.element(page.getByRole('button', { name: '빠른 모델 별칭 모델 편집', exact: true }))
		.toBeVisible();
	await page.getByRole('button', { name: '설정 닫기', exact: true }).click();
	await gear.click();
	await expect
		.element(page.getByRole('button', { name: '테스트 연결 연결 선택', exact: true }))
		.toBeVisible();
	expect((await stored()).models).toHaveLength(2);
	await screen.unmount();
});

it('filters service choices and permits custom connections with manual models before entering a key', async () => {
	const screen = render(SettingsDialog, { onclose: vi.fn() });
	await page.getByRole('button', { name: '새 연결', exact: true }).click();
	await page.getByRole('textbox', { name: '서비스 검색', exact: true }).fill('사용자');
	await expect
		.element(page.getByRole('button', { name: '사용자 지정', exact: true }))
		.toBeVisible();
	expect(page.getByRole('button', { name: 'OpenAI', exact: true }).query()).toBeNull();
	await page.getByRole('button', { name: '사용자 지정', exact: true }).click();
	await page.getByRole('textbox', { name: '연결 이름', exact: true }).fill('로컬 서비스');
	await page
		.getByRole('textbox', { name: '기본 URL', exact: true })
		.fill('http://localhost:1234/v1');
	await page.getByRole('button', { name: '모델 선택', exact: true }).click();
	await manualModel('로컬 모델', 'local/model');
	expect(saveCredential).not.toHaveBeenCalled();
	expect(fetchProviderModels).not.toHaveBeenCalled();
	expect((await stored()).providers[0]).toMatchObject({
		service: 'custom',
		baseUrl: 'http://localhost:1234/v1'
	});
	expect((await stored()).models[0].modelId).toBe('local/model');
	await screen.unmount();
});

it('stores service-account JSON securely, fills the project and verifies OAuth while keeping model entry manual', async () => {
	const screen = render(SettingsDialog, { onclose: vi.fn() });
	await page.getByRole('button', { name: '새 연결', exact: true }).click();
	await page.getByRole('button', { name: 'Vertex AI', exact: true }).click();
	await expect
		.element(page.getByText('Vertex AI · Service Account JSON', { exact: true }))
		.toBeVisible();
	expect(page.getByLabelText('API 키', { exact: true }).query()).toBeNull();
	await page
		.getByRole('textbox', { name: 'Service Account JSON', exact: true })
		.fill(JSON.stringify(fixture));
	await expect
		.element(page.getByRole('textbox', { name: '프로젝트 ID', exact: true }))
		.toHaveValue('helia-test-project');
	await page.getByRole('textbox', { name: '프로젝트 ID', exact: true }).fill('target-project');
	await page.getByRole('textbox', { name: '리전', exact: true }).fill('us-central1');
	await page.getByRole('button', { name: '모델 선택', exact: true }).click();
	await expect
		.element(page.getByText('Vertex AI에서는 모델 ID를 직접 추가해주세요.', { exact: true }))
		.toBeVisible();
	expect(page.getByRole('button', { name: '모델 목록 불러오기', exact: true }).query()).toBeNull();
	expect(saveServiceAccountCredential).toHaveBeenCalledWith(
		expect.objectContaining({
			service: 'vertex-ai',
			kind: 'google-vertex',
			baseUrl:
				'https://us-central1-aiplatform.googleapis.com/v1/projects/target-project/locations/us-central1/publishers/google',
			vertex: { projectId: 'target-project', location: 'us-central1' }
		}),
		JSON.stringify(fixture)
	);
	await expect
		.element(page.getByRole('textbox', { name: 'Service Account JSON', exact: true }))
		.toHaveValue('');
	await page.getByRole('button', { name: '서비스 계정 인증 확인', exact: true }).click();
	await expect
		.element(page.getByText('서비스 계정 인증을 확인했어요.', { exact: true }))
		.toBeVisible();
	expect(verifyProviderCredential).toHaveBeenCalled();
	await manualModel('Vertex 모델', 'gemini-example');
	await page.getByRole('button', { name: 'Vertex AI 연결 선택', exact: true }).click();
	expect(fetchProviderModels).not.toHaveBeenCalled();
	expect((await stored()).models[0].modelId).toBe('gemini-example');
	expect(JSON.stringify(await stored())).not.toContain('private_key');
	expect(JSON.stringify(await stored())).not.toContain('client_email');
	await screen.unmount();
});

it('retains service-account drafts on failed saves and leaves saved project metadata unchanged during edits', async () => {
	vi.mocked(saveServiceAccountCredential).mockRejectedValueOnce(new Error('보안 저장소 접근 실패'));
	const screen = render(SettingsDialog, { onclose: vi.fn() });
	await page.getByRole('button', { name: '새 연결', exact: true }).click();
	await page.getByRole('button', { name: 'Vertex AI', exact: true }).click();
	const json = page.getByRole('textbox', { name: 'Service Account JSON', exact: true });
	await json.fill(JSON.stringify(fixture));
	await page.getByRole('button', { name: '모델 선택', exact: true }).click();
	await expect.element(page.getByRole('alert')).toHaveTextContent('인증 정보를 저장하지 못했어요');
	await expect.element(json).toHaveValue(JSON.stringify(fixture));
	expect(JSON.stringify(await stored())).not.toContain('PRIVATE KEY');
	await page.getByRole('button', { name: '모델 선택', exact: true }).click();
	await expect.element(json).toHaveValue('');
	await page.getByRole('textbox', { name: '프로젝트 ID', exact: true }).fill('changed-project');
	expect((await stored()).providers[0].vertex?.projectId).toBe('helia-test-project');
	await expect
		.element(page.getByRole('button', { name: '서비스 계정 인증 확인', exact: true }))
		.toBeDisabled();
	await screen.unmount();
});

it('imports a service-account file and rejects oversized files without replacing the stored credential', async () => {
	const screen = render(SettingsDialog, { onclose: vi.fn() });
	await page.getByRole('button', { name: '새 연결', exact: true }).click();
	await page.getByRole('button', { name: 'Vertex AI', exact: true }).click();
	const file = page.getByLabelText('JSON 파일 가져오기', { exact: true });
	await userEvent.upload(
		file,
		new File([JSON.stringify(fixture)], 'service-account.json', { type: 'application/json' })
	);
	await expect
		.element(page.getByRole('textbox', { name: '프로젝트 ID', exact: true }))
		.toHaveValue('helia-test-project');
	await page.getByRole('button', { name: '모델 선택', exact: true }).click();
	await expect
		.element(page.getByRole('textbox', { name: 'Service Account JSON', exact: true }))
		.toHaveValue('');
	expect(saveServiceAccountCredential).toHaveBeenCalledOnce();
	await userEvent.upload(
		file,
		new File(['x'.repeat(65537)], 'too-large.json', { type: 'application/json' })
	);
	await expect.element(page.getByRole('alert')).toHaveTextContent('64KiB');
	await page.getByRole('button', { name: '변경 사항 저장', exact: true }).click();
	expect(saveServiceAccountCredential).toHaveBeenCalledOnce();
	expect(JSON.stringify(await stored())).not.toContain('private_key');
	await screen.unmount();
});

it('discards stale authentication results when the Vertex project is edited', async () => {
	await saveAISettings(
		upsertProvider(emptyAISettings(), {
			id: 'vertex',
			name: 'Vertex AI',
			kind: 'google-vertex',
			baseUrl: '',
			service: 'vertex-ai',
			vertex: { projectId: 'helia-test-project', location: 'global' }
		})
	);
	let finish!: () => void;
	vi.mocked(verifyProviderCredential).mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			})
	);
	const screen = render(SettingsDialog, { onclose: vi.fn() });
	const verify = page.getByRole('button', { name: '서비스 계정 인증 확인', exact: true });
	await expect.element(verify).toBeEnabled();
	await verify.click();
	await expect
		.element(page.getByText('서비스 계정 인증을 확인하는 중…', { exact: true }))
		.toBeVisible();
	const signal = vi.mocked(verifyProviderCredential).mock.calls[0][1];
	await page.getByRole('textbox', { name: '프로젝트 ID', exact: true }).fill('edited-project');
	expect(signal?.aborted).toBe(true);
	finish();
	await expect.element(verify).toBeDisabled();
	expect(page.getByText('서비스 계정 인증을 확인했어요.', { exact: true }).query()).toBeNull();
	expect((await stored()).providers[0].vertex?.projectId).toBe('helia-test-project');
	await screen.unmount();
});

it('requires confirmation before losing key input through navigation or Escape', async () => {
	const onclose = vi.fn();
	const screen = render(SettingsDialog, { onclose });
	await newConnection('아직 저장 안 함');
	await page.getByLabelText('API 키', { exact: true }).fill('draft-key');
	await nav().getByRole('button', { name: '모델', exact: true }).click();
	await expect
		.element(page.getByRole('dialog', { name: '변경 사항을 버릴까요?', exact: true }))
		.toBeVisible();
	await page.getByRole('button', { name: '돌아가기', exact: true }).click();
	await expect.element(page.getByLabelText('API 키', { exact: true })).toHaveValue('draft-key');
	await userEvent.keyboard('{Escape}');
	await expect
		.element(page.getByRole('dialog', { name: '변경 사항을 버릴까요?', exact: true }))
		.toBeVisible();
	expect(onclose).not.toHaveBeenCalled();
	await page.getByRole('button', { name: '변경 사항 버리기', exact: true }).click();
	expect(onclose).toHaveBeenCalledOnce();
	expect(await stored()).toEqual(emptyAISettings());
	await screen.unmount();
});

it('retains failed key writes for retry without reporting the connection as configured', async () => {
	vi.mocked(saveCredential).mockRejectedValueOnce(new Error('보안 저장소 접근 실패'));
	const screen = render(SettingsDialog, { onclose: vi.fn() });
	await newConnection('재시도 연결');
	await page.getByLabelText('API 키', { exact: true }).fill('retry-secret');
	await page.getByRole('button', { name: '모델 선택', exact: true }).click();
	await expect
		.element(page.getByRole('alert'))
		.toHaveTextContent('연결 설정은 저장했지만 API 키를 저장하지 못했어요');
	await expect.element(page.getByLabelText('API 키', { exact: true })).toHaveValue('retry-secret');
	expect(JSON.stringify(await stored())).not.toContain('retry-secret');
	expect(fetchProviderModels).not.toHaveBeenCalled();
	await page.getByRole('button', { name: '모델 선택', exact: true }).click();
	await expect
		.element(page.getByRole('button', { name: 'Fast 모델 추가', exact: true }))
		.toBeVisible();
	expect((await stored()).providers).toHaveLength(1);
	await screen.unmount();
});

it('removes connection metadata and credentials while preserving unrelated connections', async () => {
	await seed();
	let settings = upsertProvider(await stored(), {
		id: 'provider-two',
		name: '다른 연결',
		kind: 'google',
		baseUrl: 'https://other.example.com'
	});
	settings = upsertModel(settings, {
		id: 'model-two',
		name: '다른 모델',
		providerId: 'provider-two',
		modelId: 'other-model'
	});
	await saveAISettings(settings);
	const screen = render(SettingsDialog, { onclose: vi.fn() });
	await page.getByRole('button', { name: '연결 삭제', exact: true }).click();
	const confirmation = page.getByRole('dialog', { name: 'API 연결을 삭제할까요?', exact: true });
	await expect.element(confirmation).toHaveTextContent('모델 1개도 함께 삭제');
	await page.getByRole('button', { name: '돌아가기', exact: true }).click();
	expect(deleteCredential).not.toHaveBeenCalled();
	await page.getByRole('button', { name: '연결 삭제', exact: true }).click();
	await confirmation.getByRole('button', { name: '연결 삭제', exact: true }).click();
	await expect
		.poll(async () => (await stored()).providers.map((provider) => provider.id))
		.toEqual(['provider-two']);
	expect(deleteCredential).toHaveBeenCalledWith('provider-one');
	expect((await stored()).models.map((model) => model.id)).toEqual(['model-two']);
	expect((await stored()).defaultModelId).toBe('model-two');
	await screen.unmount();
});

it('ignores a late catalogue response after selecting a different connection', async () => {
	await seed();
	await saveAISettings(
		upsertProvider(await stored(), {
			id: 'provider-two',
			name: '다른 연결',
			kind: 'google',
			baseUrl: 'https://other.example.com'
		})
	);
	let finish!: (models: CatalogModel[]) => void;
	vi.mocked(fetchProviderModels)
		.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				})
		)
		.mockResolvedValue([{ id: 'other', name: 'Other' }]);
	const screen = render(SettingsDialog, { onclose: vi.fn() });
	await expect.poll(() => getCredentialStatus).toHaveBeenCalled();
	await page.getByRole('button', { name: '내 연결 연결 선택', exact: true }).click();
	await expect.poll(() => fetchProviderModels).toHaveBeenCalledTimes(1);
	const signal = vi.mocked(fetchProviderModels).mock.calls[0][1];
	await page.getByRole('button', { name: '다른 연결 연결 선택', exact: true }).click();
	await expect
		.element(page.getByRole('button', { name: 'Other 모델 추가', exact: true }))
		.toBeVisible();
	expect(signal?.aborted).toBe(true);
	finish([{ id: 'old', name: 'Old response' }]);
	await expect
		.poll(() => page.getByRole('button', { name: 'Old response 모델 추가', exact: true }).query())
		.toBeNull();
	await expect
		.element(page.getByRole('button', { name: 'Other 모델 추가', exact: true }))
		.toBeVisible();
	await screen.unmount();
});

it('retains a failed metadata save and rejects URLs containing credentials', async () => {
	const screen = render(SettingsDialog, { onclose: vi.fn() });
	await page.getByRole('button', { name: '새 연결', exact: true }).click();
	await page.getByRole('button', { name: '사용자 지정', exact: true }).click();
	await page.getByRole('textbox', { name: '연결 이름', exact: true }).fill('저장 재시도');
	const url = page.getByRole('textbox', { name: '기본 URL', exact: true });
	await url.fill('https://example.com?key=secret');
	await page.getByRole('button', { name: '모델 선택', exact: true }).click();
	await expect.element(page.getByRole('alert')).toHaveTextContent('인증 정보');
	expect(localStorage.getItem(AI_SETTINGS_KEY)).toBeNull();
	await url.fill('https://example.com');
	vi.mocked(aiSettingsRequest).mockRejectedValueOnce(new Error('설정을 저장하지 못했어요.'));
	await page.getByRole('button', { name: '모델 선택', exact: true }).click();
	await expect.element(page.getByRole('alert')).toHaveTextContent('저장하지 못했어요');
	await expect
		.element(page.getByRole('textbox', { name: '연결 이름', exact: true }))
		.toHaveValue('저장 재시도');
	await page.getByRole('button', { name: '모델 선택', exact: true }).click();
	await expect.poll(async () => (await stored()).providers[0]?.name).toBe('저장 재시도');
	await screen.unmount();
});

it('does not overwrite unreadable settings and can retry after storage recovery', async () => {
	localStorage.setItem(AI_SETTINGS_KEY, 'invalid-json');
	const screen = render(SettingsDialog, { onclose: vi.fn() });
	await expect.element(page.getByRole('alert')).toHaveTextContent('불러오지 못했어요');
	expect(localStorage.getItem(AI_SETTINGS_KEY)).toBe('invalid-json');
	localStorage.removeItem(AI_SETTINGS_KEY);
	await seed();
	await page.getByRole('button', { name: '다시 불러오기', exact: true }).click();
	await expect
		.element(page.getByRole('button', { name: '내 모델 모델 편집', exact: true }))
		.toBeVisible();
	await screen.unmount();
});

it('reopens host settings after browser storage is cleared', async () => {
	await seed();
	const screen = render(AppFixture, { view: 'home' });
	const gear = page.getByRole('button', { name: '설정', exact: true });
	await gear.click();
	await expect
		.element(page.getByRole('button', { name: '내 모델 모델 편집', exact: true }))
		.toBeVisible();
	await page.getByRole('button', { name: '설정 닫기', exact: true }).click();
	localStorage.clear();
	await gear.click();
	await expect
		.element(page.getByRole('button', { name: '내 연결 연결 선택', exact: true }))
		.toBeVisible();
	expect((await stored()).defaultModelId).toBe('model-one');
	await screen.unmount();
});

it('retries a failed host load without enabling mutations before settings arrive', async () => {
	await seed();
	vi.mocked(aiSettingsRequest).mockRejectedValueOnce(new Error('host unavailable'));
	const screen = render(SettingsDialog, { onclose: vi.fn() });
	await expect.element(page.getByRole('alert')).toHaveTextContent('불러오지 못했어요');
	await expect.element(page.getByRole('button', { name: '새 연결', exact: true })).toBeDisabled();
	await page.getByRole('button', { name: '다시 불러오기', exact: true }).click();
	await expect
		.element(page.getByRole('button', { name: '내 모델 모델 편집', exact: true }))
		.toBeVisible();
	expect((await stored()).models).toHaveLength(1);
	await screen.unmount();
});

it('keeps connection mutations busy until the asynchronous metadata write finishes', async () => {
	const onclose = vi.fn();
	const screen = render(SettingsDialog, { onclose });
	await newConnection('느린 연결');
	const key = page.getByLabelText('API 키', { exact: true });
	await key.fill('pending-secret');
	let finish!: () => void;
	const pending = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const backend = vi.mocked(aiSettingsRequest).getMockImplementation()!;
	vi.mocked(aiSettingsRequest).mockImplementationOnce(async (request) => {
		expect(request.kind).toBe('write');
		await pending;
		return backend(request);
	});
	await page.getByRole('button', { name: '모델 선택', exact: true }).click();
	await expect.element(dialog()).toHaveAttribute('aria-busy', 'true');
	await expect.element(key).toBeDisabled();
	await expect
		.element(page.getByRole('button', { name: '저장하는 중…', exact: true }))
		.toBeDisabled();
	await userEvent.keyboard('{Escape}');
	expect(onclose).not.toHaveBeenCalled();
	expect(saveCredential).not.toHaveBeenCalled();
	finish();
	await expect
		.element(page.getByRole('button', { name: 'Fast 모델 추가', exact: true }))
		.toBeVisible();
	expect((await stored()).providers[0].name).toBe('느린 연결');
	await screen.unmount();
});

it('retains a model draft through a pending failed write and allows retry', async () => {
	await seed();
	const screen = render(SettingsDialog, { onclose: vi.fn() });
	await page.getByRole('button', { name: '내 모델 모델 편집', exact: true }).click();
	const name = page.getByRole('textbox', { name: '표시 이름', exact: true });
	await name.fill('다시 저장할 모델');
	let fail!: (error: Error) => void;
	vi.mocked(aiSettingsRequest).mockImplementationOnce(
		() =>
			new Promise((_, reject) => {
				fail = reject;
			})
	);
	await page.getByRole('button', { name: '모델 저장', exact: true }).click();
	await expect.element(dialog()).toHaveAttribute('aria-busy', 'true');
	await expect.element(name).toHaveValue('다시 저장할 모델');
	const requests = vi.mocked(aiSettingsRequest).mock.calls.length;
	await page.getByRole('button', { name: '모델 저장', exact: true }).click();
	expect(aiSettingsRequest).toHaveBeenCalledTimes(requests);
	await userEvent.keyboard('{Escape}');
	await expect.element(name).toBeVisible();
	fail(new Error('모델 저장 실패'));
	await expect
		.element(page.getByRole('alert').filter({ hasText: '모델 저장 실패' }).first())
		.toBeVisible();
	await expect.element(name).toHaveValue('다시 저장할 모델');
	expect((await stored()).models[0].name).toBe('내 모델');
	await page.getByRole('button', { name: '모델 저장', exact: true }).click();
	await expect
		.element(page.getByRole('button', { name: '다시 저장할 모델 모델 편집', exact: true }))
		.toBeVisible();
	expect((await stored()).models[0].name).toBe('다시 저장할 모델');
	await screen.unmount();
});

it('ignores stale and disposed settings loads without starting credential requests', async () => {
	const settings = await seed();
	const controller = new SettingsDialogController();
	let finish!: (snapshot: { settings: typeof settings; revision: number }) => void;
	vi.mocked(aiSettingsRequest).mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			})
	);
	const stale = controller.load();
	await controller.load();
	finish({ settings: emptyAISettings(), revision: 1 });
	await stale;
	expect(controller.settings.models[0].id).toBe('model-one');
	controller.dispose();
	vi.mocked(getCredentialStatus).mockClear();
	const disposed = new SettingsDialogController();
	vi.mocked(aiSettingsRequest).mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			})
	);
	const pending = disposed.load();
	disposed.dispose();
	finish({ settings, revision: 2 });
	await pending;
	expect(disposed.ready).toBe(false);
	expect(disposed.settings).toEqual(emptyAISettings());
	expect(getCredentialStatus).not.toHaveBeenCalled();
});

it('rejects stale controller saves without overwriting newer settings or losing the model draft', async () => {
	await seed();
	const controller = new SettingsDialogController();
	await controller.load();
	controller.editModel(controller.settings.models[0]);
	controller.modelDraft!.name = '이 창의 변경';
	const latest = await stored();
	await saveAISettings(
		upsertModel(latest, { ...latest.models[0], name: '다른 창의 변경' }),
		latest
	);
	await controller.saveModel(new SubmitEvent('submit'));
	expect(controller.modelDraft?.name).toBe('이 창의 변경');
	expect(controller.modelError).toContain('다른 창');
	expect(controller.busy).toBe(false);
	expect((await stored()).models[0].name).toBe('다른 창의 변경');
	controller.dispose();
});

it('does not delete credentials when a stale connection deletion conflicts', async () => {
	await seed();
	const controller = new SettingsDialogController();
	await controller.load();
	const provider = controller.settings.providers[0];
	const latest = await stored();
	await saveAISettings(
		upsertProvider(latest, { ...latest.providers[0], name: '다른 창의 연결 변경' }),
		latest
	);
	await controller.deleteConnection(provider);
	expect(deleteCredential).not.toHaveBeenCalled();
	expect(controller.error).toContain('다른 창');
	expect(controller.settings.providers).toHaveLength(1);
	expect((await stored()).providers[0].name).toBe('다른 창의 연결 변경');
	expect((await stored()).models[0].id).toBe('model-one');
	controller.dispose();
});

it('applies deleted metadata before credential cleanup and reports cleanup failures explicitly', async () => {
	await seed();
	const controller = new SettingsDialogController();
	await controller.load();
	let fail!: (error: Error) => void;
	vi.mocked(deleteCredential).mockImplementationOnce(
		() =>
			new Promise((_, reject) => {
				fail = reject;
			})
	);
	const deleting = controller.deleteConnection(controller.settings.providers[0]);
	await expect.poll(() => deleteCredential).toHaveBeenCalledWith('provider-one');
	expect(controller.settings.providers).toHaveLength(0);
	expect(controller.providerDraft).toBeNull();
	expect(controller.busy).toBe(true);
	expect((await stored()).models).toHaveLength(0);
	fail(new Error('보안 저장소 접근 실패'));
	await deleting;
	expect(controller.error).toContain('API 연결은 삭제했지만 인증 정보를 정리하지 못했어요.');
	expect(controller.status).toBe('');
	expect(controller.busy).toBe(false);
	controller.dispose();
});

it('does not apply a pending save after disposal or start a second mutation while busy', async () => {
	await seed();
	const controller = new SettingsDialogController();
	await controller.load();
	let finish!: () => void;
	const pending = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const backend = vi.mocked(aiSettingsRequest).getMockImplementation()!;
	vi.mocked(aiSettingsRequest).mockImplementationOnce(async (request) => {
		await pending;
		return backend(request);
	});
	const original = controller.settings;
	const saving = controller.persist(() => emptyAISettings(), '저장 완료');
	expect(controller.busy).toBe(true);
	expect(await controller.persist(() => emptyAISettings(), '중복 저장')).toBe(false);
	controller.dispose();
	finish();
	expect(await saving).toBe(false);
	expect(controller.settings).toBe(original);
	expect(controller.status).toBe('');
});

it.each([
	{ width: 390, height: 844 },
	{ width: 1000, height: 400 }
])('keeps settings and model editing reachable at $width by $height', async ({ width, height }) => {
	await page.viewport(width, height);
	await seed();
	const screen = render(SettingsDialog, { onclose: vi.fn() });
	await page.getByRole('button', { name: '내 모델 모델 편집', exact: true }).click();
	const bounds = dialog().element().getBoundingClientRect();
	expect(bounds.left).toBeGreaterThanOrEqual(0);
	expect(bounds.right).toBeLessThanOrEqual(width);
	expect(bounds.bottom).toBeLessThanOrEqual(height);
	await page.getByRole('textbox', { name: '표시 이름', exact: true }).fill('화면 크기 변경');
	await page.getByRole('button', { name: '모델 저장', exact: true }).click();
	expect((await stored()).models[0].name).toBe('화면 크기 변경');
	await screen.unmount();
});
