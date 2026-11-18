import '../../../app.css';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

import { createGame, getGameWorkspace } from '#lib/games/repository.js';
import HistoryWorkspaceFixture from '#lib/testing/HistoryWorkspaceFixture.svelte';

import { loadPersonaSettings, savePersonaSettings } from './persona-repository.js';
import { bindPersona, emptyPersonaSettings, personaSessionKey, upsertPersona } from './personas.js';
import SettingsDialog from './SettingsDialog.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('#lib/app/settings/repository.js', () => ({
	saveAISettings: vi.fn(),
	loadAISettings: async () => ({
		version: 1,
		providers: [
			{ id: 'api', name: 'API', kind: 'openai-compatible', baseUrl: 'https://example.com/v1' }
		],
		models: [{ id: 'model', name: 'Test model', providerId: 'api', modelId: 'test' }],
		defaultModelId: 'model'
	})
}));
vi.mock('./credentials.js', () => ({
	getCredentialStatus: vi.fn(async () => ({})),
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

const first = { id: 'first', name: '여행자', description: '별을 찾는 여행자' };
const second = { id: 'second', name: '기사', description: '서약을 지키는 기사' };
beforeEach(async () => {
	localStorage.clear();
	savePersonaSettings({
		...upsertPersona(upsertPersona(emptyPersonaSettings(), first), second),
		selectedPersonaId: first.id
	});
	await page.viewport(1280, 900);
});
afterEach(() => vi.restoreAllMocks());

async function openPersonas() {
	const screen = render(SettingsDialog, { onclose: vi.fn() });
	await page
		.getByRole('navigation', { name: '설정 메뉴' })
		.getByRole('button', { name: '페르소나', exact: true })
		.click();
	await expect
		.element(page.getByRole('textbox', { name: '이름', exact: true }))
		.toHaveValue(first.name);
	return screen;
}
it('autosaves edits and flushes the last change before leaving settings', async () => {
	await openPersonas();
	await page.getByRole('button', { name: '새 페르소나', exact: true }).click();
	await page.getByRole('textbox', { name: '이름', exact: true }).fill('대장장이');
	await page.getByRole('textbox', { name: '설명', exact: true }).fill('마을의 새 대장장이');
	await expect
		.element(page.getByRole('button', { name: '페르소나 저장', exact: true }))
		.not.toBeInTheDocument();
	await expect
		.poll(
			() =>
				loadPersonaSettings().personas.find((persona) => persona.name === '대장장이')?.description
		)
		.toBe('마을의 새 대장장이');
	const added = loadPersonaSettings().personas.find((persona) => persona.name === '대장장이')!;
	expect(added.description).toBe('마을의 새 대장장이');
	await page.getByRole('button', { name: '현재 페르소나로 사용', exact: true }).click();
	expect(loadPersonaSettings().selectedPersonaId).toBe(added.id);
	await page
		.getByRole('dialog', { name: '설정', exact: true })
		.screenshot({ path: '../../../../data/verification/personas/settings.png' });
	await page.viewport(400, 720);
	const editor = page.getByRole('region', { name: '페르소나 설정', exact: true }).element();
	expect(editor.scrollWidth).toBeLessThanOrEqual(editor.clientWidth + 1);
	await page.getByRole('textbox', { name: '설명', exact: true }).fill('마지막 입력도 자동 저장');
	await page
		.getByRole('navigation', { name: '설정 메뉴' })
		.getByRole('button', { name: '모델', exact: true })
		.click();
	await expect.element(page.getByRole('heading', { name: '모델', exact: true })).toBeVisible();
	await expect
		.element(page.getByRole('dialog', { name: '변경 사항을 버릴까요?', exact: true }))
		.not.toBeInTheDocument();
	expect(
		loadPersonaSettings().personas.find((persona) => persona.id === added.id)?.description
	).toBe('마지막 입력도 자동 저장');
});

it('preserves failed autosaves for retry and saves valid input when closing immediately', async () => {
	const screen = await openPersonas();
	const original = Storage.prototype.setItem;
	const fail = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
		this: Storage,
		key,
		value
	) {
		if (key === 'helia:persona-settings') {
			throw new Error('Quota');
		}
		original.call(this, key, value);
	});
	await page.getByRole('textbox', { name: '설명', exact: true }).fill('실패해도 유지할 설명');
	await expect.element(page.getByRole('button', { name: '다시 저장', exact: true })).toBeVisible();
	await expect
		.element(page.getByRole('textbox', { name: '설명', exact: true }))
		.toHaveValue('실패해도 유지할 설명');
	expect(loadPersonaSettings().personas[0].description).toBe(first.description);
	fail.mockRestore();
	await page.getByRole('button', { name: '다시 저장', exact: true }).click();
	expect(loadPersonaSettings().personas[0].description).toBe('실패해도 유지할 설명');
	await page.getByRole('textbox', { name: '설명', exact: true }).fill('닫기 전 마지막 입력');
	await page.getByRole('button', { name: '설정 닫기', exact: true }).click();
	expect(loadPersonaSettings().personas[0].description).toBe('닫기 전 마지막 입력');
	await screen.unmount();
});

it('keeps invalid names out of storage and cancels pending writes when deleting or switching personas', async () => {
	await openPersonas();
	await page.getByRole('textbox', { name: '이름', exact: true }).fill('');
	await expect
		.element(page.getByRole('alert'))
		.toHaveTextContent('페르소나 이름을 1~120자로 입력해주세요.');
	expect(loadPersonaSettings().personas[0].name).toBe(first.name);
	await page.getByRole('textbox', { name: '이름', exact: true }).fill('새 여행자');
	await page.getByRole('textbox', { name: '설명', exact: true }).fill('인물 전환 직전 입력');
	await page
		.getByRole('navigation', { name: '페르소나 목록' })
		.getByRole('button', { name: second.name, exact: true })
		.click();
	expect(loadPersonaSettings().personas[0].description).toBe('인물 전환 직전 입력');
	await page.getByRole('button', { name: '복제', exact: true }).click();
	expect(loadPersonaSettings().personas.map((persona) => persona.name)).toEqual([
		'새 여행자',
		'기사',
		'기사 복사본'
	]);
	await page.getByRole('textbox', { name: '설명', exact: true }).fill('삭제할 인물의 입력');
	await page.getByRole('button', { name: '기사 복사본 작업', exact: true }).click();
	await page.getByRole('button', { name: '기사 복사본 삭제', exact: true }).click();
	await page
		.getByRole('dialog', { name: '삭제 확인', exact: true })
		.getByRole('button', { name: '삭제', exact: true })
		.click();
	expect(loadPersonaSettings().personas.map((persona) => persona.name)).toEqual([
		'새 여행자',
		'기사'
	]);
});
it('uses shared rename/delete dialogs and clears deleted session bindings', async () => {
	const key = personaSessionKey('game', 'session');
	savePersonaSettings(bindPersona(loadPersonaSettings(), key, first.id));
	await openPersonas();
	await page.getByRole('button', { name: '여행자 작업', exact: true }).click();
	await page.getByRole('button', { name: '여행자 이름 변경', exact: true }).click();
	const rename = page.getByRole('dialog', { name: '이름 변경', exact: true });
	await rename.getByRole('textbox', { name: '이름', exact: true }).fill('방랑자');
	await rename.getByRole('button', { name: '확인', exact: true }).click();
	await expect
		.element(page.getByRole('textbox', { name: '이름', exact: true }))
		.toHaveValue('방랑자');
	expect(loadPersonaSettings().bindings[key]).toBe(first.id);
	await page.getByRole('button', { name: '방랑자 작업', exact: true }).click();
	await page.getByRole('button', { name: '방랑자 삭제', exact: true }).click();
	await page
		.getByRole('dialog', { name: '삭제 확인', exact: true })
		.getByRole('button', { name: '삭제', exact: true })
		.click();
	expect(loadPersonaSettings().bindings[key]).toBeNull();
	expect(loadPersonaSettings().personas.map((persona) => persona.id)).toEqual([second.id]);
});

it('places model and persona controls below the session list and retains bindings after remount', async () => {
	const game = await createGame();
	const workspace = (await getGameWorkspace(game.id))!;
	const props = {
		game,
		session: workspace.sessions[0],
		onsessionupdate: vi.fn(),
		onsavingchange: vi.fn()
	};
	const screen = render(HistoryWorkspaceFixture, props);
	const binding = page.getByRole('combobox', { name: '페르소나 바인드', exact: true });
	await expect.element(binding).toBeEnabled();
	await expect
		.element(binding.getByRole('option', { name: second.name, exact: true }))
		.toBeInTheDocument();
	await binding.selectOptions(second.id);
	expect(loadPersonaSettings().bindings[personaSessionKey(game.id, game.activeSessionId)]).toBe(
		second.id
	);
	const model = page
		.getByRole('combobox', { name: '모델', exact: true })
		.element()
		.getBoundingClientRect();
	const persona = binding.element().getBoundingClientRect();
	const list = page
		.getByRole('navigation', { name: '세션 목록', exact: true })
		.element()
		.getBoundingClientRect();
	expect(model.top).toBeGreaterThan(list.bottom);
	expect(model.top - list.bottom).toBeLessThan(70);
	expect(persona.top).toBeGreaterThan(model.bottom);
	expect(persona.bottom).toBeLessThan(600);
	await page
		.getByRole('complementary', { name: '게임 세션', exact: true })
		.screenshot({ path: '../../../../data/verification/personas/sidebar.png' });
	savePersonaSettings({ ...loadPersonaSettings(), selectedPersonaId: second.id });
	savePersonaSettings({ ...loadPersonaSettings(), selectedPersonaId: first.id });
	await expect.element(binding).toHaveValue(second.id);
	await screen.unmount();
	render(HistoryWorkspaceFixture, props);
	await expect.element(binding).toHaveValue(second.id);
	await binding.selectOptions(':current');
	expect(
		loadPersonaSettings().bindings[personaSessionKey(game.id, game.activeSessionId)]
	).toBeUndefined();
	await binding.selectOptions(':none');
	expect(
		loadPersonaSettings().bindings[personaSessionKey(game.id, game.activeSessionId)]
	).toBeNull();
});
