import '../../../app.css';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';

import { parsePromptConfig } from '#lib/games/ai/prompts.js';
import risupFixtureUrl from '#lib/testing/fixtures/prompt-preset.risup?url';
import risupresetFixtureUrl from '#lib/testing/fixtures/prompt-preset.risupreset?url';

import {
	loadPromptSettings,
	savePromptSettings,
	PROMPT_SETTINGS_KEY
} from './prompt-repository.js';
import { emptyPromptSettings, upsertPromptPreset } from './prompts.js';
import SettingsDialog from './SettingsDialog.svelte';

vi.mock('./credentials.js', () => ({
	getCredentialStatus: vi.fn(async () => ({})),
	saveCredential: vi.fn(),
	saveServiceAccountCredential: vi.fn(),
	verifyProviderCredential: vi.fn(),
	deleteCredential: vi.fn(),
	fetchProviderModels: vi.fn()
}));

beforeEach(async () => {
	localStorage.clear();
	await page.viewport(1280, 900);
});
afterEach(() => vi.restoreAllMocks());
const nameInput = () => page.getByRole('textbox', { name: '프리셋 이름', exact: true });
const save = () => page.getByRole('button', { name: '프리셋 저장', exact: true });
const discard = () => page.getByRole('dialog', { name: '변경 사항을 버릴까요?', exact: true });
const importFile = () => page.getByLabelText('프롬프트 파일', { exact: true });
async function uploadPrompt(source: unknown, name = 'prompt.json') {
	await userEvent.upload(
		importFile(),
		new File([typeof source === 'string' ? source : JSON.stringify(source)], name, {
			type: 'application/json'
		})
	);
}
async function openPrompts() {
	const onclose = vi.fn();
	const screen = render(SettingsDialog, { onclose });
	await page
		.getByRole('navigation', { name: '설정 메뉴' })
		.getByRole('button', { name: '프롬프트', exact: true })
		.click();
	await expect.element(nameInput()).toBeVisible();
	await expect.element(save()).toBeDisabled();
	return { unmount: () => screen.unmount(), onclose };
}

it('uses translated single-column cards and keeps independently expanded cards clean', async () => {
	const settings = emptyPromptSettings();
	settings.presets[0].config = parsePromptConfig({
		version: 2,
		promptTemplate: [
			{ type: 'plain', text: '첫 프롬프트' },
			{ type: 'persona', text: '여행자', innerFormat: 'Persona: {{slot}}' },
			{ type: 'chat', rangeStart: -5, rangeEnd: 'end' },
			{ type: 'cache', role: 'all', depth: 2 }
		]
	});
	savePromptSettings(settings);
	const screen = await openPrompts();
	const main = page.getByRole('region', { name: '1번 프롬프트 블록', exact: true });
	const mainToggle = main.getByRole('button', { name: '순수 프롬프트', exact: true });
	expectPromptBlockLayout(main);
	const persona = page.getByRole('region', { name: '2번 프롬프트 블록', exact: true });
	await persona.getByRole('button', { name: '페르소나 프롬프트', exact: true }).click();
	await expect.element(mainToggle).toHaveAttribute('aria-expanded', 'true');
	await expect.element(main.getByRole('textbox', { name: '프롬프트', exact: true })).toBeVisible();
	await expect
		.element(persona.getByRole('checkbox', { name: '커스텀 내부 포맷', exact: true }))
		.toBeChecked();
	await expect
		.element(persona.getByRole('textbox', { name: '내부 포맷', exact: true }))
		.toHaveValue('Persona: {{slot}}');
	expect(
		persona
			.element()
			.querySelector('.block-fields > label:last-child')
			?.firstChild?.textContent?.trim()
	).toBe('역할');
	const chat = page.getByRole('region', { name: '3번 프롬프트 블록', exact: true });
	await chat.getByRole('button', { name: '챗', exact: true }).click();
	await expect.element(chat.getByRole('checkbox', { name: '고급', exact: true })).toBeChecked();
	await expect
		.element(chat.getByRole('spinbutton', { name: '범위 시작', exact: true }))
		.toHaveValue(-5);
	await expect.element(save()).toBeDisabled();
	expect(loadPromptSettings()).toEqual(settings);
	await screen.unmount();
});

it('creates a preset, edits ordered blocks and options, saves explicitly, selects it globally and restores it on reload', async () => {
	let screen = await openPrompts();
	await page.getByRole('button', { name: '새 프리셋', exact: true }).click();
	await nameInput().fill('서사 프롬프트');
	expect(page.getByText('공통 내용', { exact: true }).query()).toBeNull();
	const main = page.getByRole('region', { name: '1번 프롬프트 블록', exact: true });
	await main
		.getByRole('textbox', { name: '프롬프트', exact: true })
		.fill('장면을 생생하게 묘사하세요.');
	const persona = page.getByRole('region', { name: '3번 프롬프트 블록', exact: true });
	await persona.getByRole('button', { name: '페르소나 프롬프트', exact: true }).click();
	await persona.getByRole('textbox', { name: '프롬프트', exact: true }).fill('여행자');
	await persona.getByRole('checkbox', { name: '커스텀 내부 포맷', exact: true }).click();
	await persona.getByRole('textbox', { name: '내부 포맷', exact: true }).fill('Persona: {{slot}}');
	expect(persona.getByRole('combobox', { name: '특수 타입', exact: true }).query()).toBeNull();
	const post = page.getByRole('region', { name: '8번 프롬프트 블록', exact: true });
	await post.getByRole('button', { name: '최종 삽입 프롬프트', exact: true }).click();
	await post.getByRole('textbox', { name: '프롬프트', exact: true }).fill('장면을 마무리하세요.');
	await page.getByRole('button', { name: '블록 추가', exact: true }).click();
	const added = page.getByRole('region', { name: '9번 프롬프트 블록', exact: true });
	await added.getByRole('textbox', { name: '이름', exact: true }).fill('보충 지시');
	await added.getByRole('combobox', { name: '타입', exact: true }).selectOptions('jailbreak');
	await added.getByRole('combobox', { name: '특수 타입', exact: true }).selectOptions('globalNote');
	await added.getByRole('combobox', { name: '역할', exact: true }).selectOptions('user');
	expect(
		added.getByRole('combobox', { name: '역할 덮어쓰기 (role2)', exact: true }).query()
	).toBeNull();
	await added.getByRole('textbox', { name: '프롬프트', exact: true }).fill('추가 지시');
	await page.getByRole('button', { name: '9번 블록 위로', exact: true }).click();
	await page.getByRole('checkbox', { name: '8번 블록 사용', exact: true }).click();
	await page.getByText('생성 옵션', { exact: true }).click();
	await page.getByRole('spinbutton', { name: '최대 출력 토큰', exact: true }).fill('8192');
	await page.getByRole('checkbox', { name: '시스템으로 채팅 보내기', exact: true }).click();
	await page.getByRole('textbox', { name: '어시스턴트 프리필', exact: true }).fill('이야기:');
	expect(loadPromptSettings().presets).toHaveLength(1);
	await save().click();
	const saved = loadPromptSettings();
	const preset = saved.presets.find((preset) => preset.name === '서사 프롬프트')!;
	expect(saved.selectedPresetId).toBe('default');
	expectSavedPrompt(preset);
	await page.getByRole('button', { name: '기본 프롬프트로 사용', exact: true }).click();
	expect(loadPromptSettings().selectedPresetId).toBe(preset.id);
	await screen.unmount();
	screen = await openPrompts();
	await expect.element(nameInput()).toHaveValue('서사 프롬프트');
	await page.getByRole('button', { name: 'JSON 내보내기', exact: true }).click();
	const exported = JSON.parse(
		(
			page
				.getByRole('textbox', { name: '내보낼 프롬프트 JSON', exact: true })
				.element() as HTMLTextAreaElement
		).value
	);
	expect(exported).toEqual({ version: 1, name: preset.name, config: preset.config });
	await screen.unmount();
});

it('guards section changes, preset changes and closing while keeping cancelled edits intact', async () => {
	const screen = await openPrompts();
	await page.getByRole('button', { name: '새 프리셋', exact: true }).click();
	await nameInput().fill('아직 저장하지 않은 프리셋');
	await page
		.getByRole('navigation', { name: '설정 메뉴' })
		.getByRole('button', { name: 'API 연결', exact: true })
		.click();
	await expect.element(discard()).toBeVisible();
	await discard().getByRole('button', { name: '돌아가기', exact: true }).click();
	await expect.element(nameInput()).toHaveValue('아직 저장하지 않은 프리셋');
	await page.getByRole('combobox', { name: '편집할 프리셋', exact: true }).selectOptions('default');
	await expect.element(discard()).toBeVisible();
	await discard().getByRole('button', { name: '변경 사항 버리기', exact: true }).click();
	await expect.element(nameInput()).toHaveValue('기본 프롬프트');
	await nameInput().fill('닫기 전 변경');
	await page.getByRole('button', { name: '설정 닫기', exact: true }).click();
	await expect.element(discard()).toBeVisible();
	expect(screen.onclose).not.toHaveBeenCalled();
	await userEvent.keyboard('{Escape}');
	await expect.element(nameInput()).toHaveValue('닫기 전 변경');
	await page.getByRole('button', { name: '설정 닫기', exact: true }).click();
	await discard().getByRole('button', { name: '변경 사항 버리기', exact: true }).click();
	expect(screen.onclose).toHaveBeenCalledOnce();
	expect(loadPromptSettings().presets).toHaveLength(1);
	await screen.unmount();
});

it('keeps draft contents and persisted settings intact after a storage failure, then retries', async () => {
	const screen = await openPrompts();
	await nameInput().fill('다시 저장할 프리셋');
	const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
		throw new Error('Write failed');
	});
	await save().click();
	await expect.element(page.getByRole('alert')).toHaveTextContent('입력 내용은 유지');
	await expect.element(nameInput()).toHaveValue('다시 저장할 프리셋');
	expect(localStorage.getItem(PROMPT_SETTINGS_KEY)).toBeNull();
	storage.mockRestore();
	await save().click();
	expect(loadPromptSettings().presets[0].name).toBe('다시 저장할 프리셋');
	await expect.element(save()).toBeDisabled();
	await screen.unmount();
});

it('imports Risu JSON as a new editable preset while excluding game lorebook and unrelated data', async () => {
	const screen = await openPrompts();
	const source = {
		name: '가져온 설정',
		mainPrompt: 'A narrator',
		maxResponse: 1234,
		jailbreakToggle: false,
		chainOfThought: false,
		promptTemplate: [
			{ type: 'plain', type2: 'main', role: 'assistant', role2: 'user', text: 'Fallback' },
			{ type: 'persona', role: 'bot', role2: 'user', text: 'A traveler' },
			{ type: 'description', role: 'user', role2: 'system' },
			{
				type: 'chat',
				role: 'system',
				role2: 'bot',
				rangeStart: -8,
				rangeEnd: 'end',
				chatAsOriginalOnSystem: true
			},
			{ type: 'cache', role: 'all', role2: 'system', depth: 2 }
		],
		lorebook: [{ keys: ['secret'], content: 'Game-only lore' }],
		apiKey: 'untrusted-imported-field'
	};
	await uploadPrompt(source);
	await expect.element(nameInput()).toHaveValue('가져온 설정');
	expect(loadPromptSettings().presets).toHaveLength(1);
	await save().click();
	const imported = loadPromptSettings().presets.find((preset) => preset.name === '가져온 설정')!;
	expect(imported.config).toMatchObject({
		version: 2,
		maxTokens: 1234,
		jailbreakEnabled: false,
		cotEnabled: false
	});
	expect(imported.config.promptTemplate).toEqual([
		{ type: 'plain', type2: 'main', role: 'bot', text: 'A narrator' },
		{ type: 'persona', role: 'user', text: 'A traveler' },
		{ type: 'description', role: 'system' },
		{ type: 'chat', rangeStart: -8, rangeEnd: 'end', chatAsOriginalOnSystem: true },
		{ type: 'cache', role: 'all', depth: 2 }
	]);
	expect(imported.config.promptTemplate.every((block) => !Object.hasOwn(block, 'role2'))).toBe(
		true
	);
	expect(imported.config).not.toHaveProperty('mainPrompt');
	expect(imported.config).not.toHaveProperty('globalNote');
	expect(imported.config).not.toHaveProperty('persona');
	expect(imported.config).not.toHaveProperty('postEverything');
	expect(localStorage.getItem(PROMPT_SETTINGS_KEY)).not.toContain('Game-only lore');
	expect(localStorage.getItem(PROMPT_SETTINGS_KEY)).not.toContain('untrusted-imported-field');
	await screen.unmount();
});

it.each([
	{ name: 'prompt-preset.risup', url: risupFixtureUrl },
	{ name: 'prompt-preset.risupreset', url: risupresetFixtureUrl }
])(
	'decodes $name directly into an editable unsaved preset in the browser',
	async ({ name, url }) => {
		const screen = await openPrompts();
		const response = await fetch(url);
		expect(response.ok).toBe(true);
		await userEvent.upload(
			importFile(),
			new File([await response.arrayBuffer()], name, { type: 'application/octet-stream' })
		);
		await expect.element(nameInput()).toHaveValue('Risu preset');
		await expect
			.element(page.getByRole('textbox', { name: '프롬프트', exact: true }))
			.toHaveValue('You are a narrator.');
		await expect
			.element(page.getByRole('combobox', { name: '역할', exact: true }))
			.toHaveValue('user');
		expect(loadPromptSettings().presets).toHaveLength(1);
		await save().click();
		const preset = loadPromptSettings().presets.at(-1)!;
		expect(preset.name).toBe('Risu preset');
		expect(preset.config.maxTokens).toBe(256);
		expect(preset.config.promptTemplate[0]).toMatchObject({
			text: 'You are a narrator.',
			role: 'user'
		});
		await screen.unmount();
	}
);

it('loads legacy preset bodies into their matching block editors without dirtying the draft and saves canonical block text', async () => {
	localStorage.setItem(
		PROMPT_SETTINGS_KEY,
		JSON.stringify({
			version: 1,
			selectedPresetId: 'legacy',
			presets: [
				{
					id: 'legacy',
					name: '기존 프리셋',
					config: {
						version: 1,
						mainPrompt: '기존 메인',
						globalNote: '기존 글로벌',
						persona: '기존 페르소나',
						postEverything: '기존 후처리',
						promptTemplate: [
							{ type: 'plain', type2: 'main', text: '메인 대체 본문' },
							{ type: 'plain', type2: 'globalNote', text: '글로벌 대체 본문' },
							{ type: 'persona', innerFormat: 'Persona: {{slot}}' },
							{ type: 'postEverything' }
						]
					}
				}
			]
		})
	);
	const screen = await openPrompts();
	expect(page.getByText('공통 내용', { exact: true }).query()).toBeNull();
	const expectedBodies = ['기존 메인', '기존 글로벌', '기존 페르소나', '기존 후처리'];
	for (let index = 0; index < expectedBodies.length; index++) {
		const block = page.getByRole('region', { name: `${index + 1}번 프롬프트 블록`, exact: true });
		const toggle = block.getByRole('button').first();
		if (toggle.element().getAttribute('aria-expanded') !== 'true') {
			await toggle.click();
		}
		await expect
			.element(block.getByRole('textbox', { name: '프롬프트', exact: true }))
			.toHaveValue(expectedBodies[index]);
	}
	await expect.element(save()).toBeDisabled();
	const main = page.getByRole('region', { name: '1번 프롬프트 블록', exact: true });
	await main.getByRole('textbox', { name: '프롬프트', exact: true }).fill('직접 편집한 메인');
	await save().click();
	const config = loadPromptSettings().presets[0].config;
	expect(config.version).toBe(2);
	expect(config.promptTemplate.map((block) => block.text)).toEqual([
		'직접 편집한 메인',
		'기존 글로벌',
		'기존 페르소나',
		'기존 후처리'
	]);
	const persistedConfig = JSON.parse(localStorage.getItem(PROMPT_SETTINGS_KEY)!).presets[0].config;
	for (const field of ['mainPrompt', 'globalNote', 'persona', 'postEverything']) {
		expect(persistedConfig).not.toHaveProperty(field);
	}
	await expect.element(save()).toBeDisabled();
	await screen.unmount();
});

it('loads legacy final roles cleanly and preserves the single role through save, export and Helia import', async () => {
	localStorage.setItem(
		PROMPT_SETTINGS_KEY,
		JSON.stringify({
			version: 1,
			selectedPresetId: 'legacy-role',
			presets: [
				{
					id: 'legacy-role',
					name: '기존 역할 프리셋',
					config: {
						...parsePromptConfig(undefined),
						promptTemplate: [
							{ type: 'persona', role: 'system', role2: 'user', text: '유지할 본문' }
						]
					}
				}
			]
		})
	);
	const screen = await openPrompts();
	const block = page.getByRole('region', { name: '1번 프롬프트 블록', exact: true });
	const role = block.getByRole('combobox', { name: '역할', exact: true });
	await expect.element(role).toHaveValue('user');
	expect(
		block.getByRole('combobox', { name: '역할 덮어쓰기 (role2)', exact: true }).query()
	).toBeNull();
	await expect.element(save()).toBeDisabled();
	await role.selectOptions('bot');
	await save().click();
	const storedBlock = JSON.parse(localStorage.getItem(PROMPT_SETTINGS_KEY)!).presets[0].config
		.promptTemplate[0];
	expect(storedBlock).toEqual({ type: 'persona', role: 'bot', text: '유지할 본문' });
	await page.getByRole('button', { name: 'JSON 내보내기', exact: true }).click();
	const exported = (
		page
			.getByRole('textbox', { name: '내보낼 프롬프트 JSON', exact: true })
			.element() as HTMLTextAreaElement
	).value;
	expect(JSON.parse(exported).config.promptTemplate[0]).toEqual(storedBlock);
	expect(exported).not.toContain('role2');
	await uploadPrompt(exported);
	await expect
		.element(page.getByRole('combobox', { name: '역할', exact: true }))
		.toHaveValue('bot');
	await save().click();
	expect(loadPromptSettings().presets.at(-1)!.config.promptTemplate[0]).toEqual(storedBlock);
	await screen.unmount();
});

it('opens the file picker directly and leaves the current draft unchanged when picking is cancelled', async () => {
	const screen = await openPrompts();
	const nativeClick = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
	await page.getByRole('button', { name: '가져오기', exact: true }).click();
	expect(nativeClick).toHaveBeenCalledOnce();
	expect(nativeClick.mock.contexts[0]).toBe(importFile().element());
	expect(importFile().element().getAttribute('accept')).toBe(
		'.json,.preset,.risupreset,.risup,application/json'
	);
	importFile()
		.element()
		.dispatchEvent(new Event('cancel', { bubbles: true }));
	await expect.element(nameInput()).toHaveValue('기본 프롬프트');
	await expect.element(save()).toBeDisabled();
	expect(
		page.getByRole('textbox', { name: '가져올 프롬프트 JSON', exact: true }).query()
	).toBeNull();
	expect(
		page.getByRole('button', { name: '새 프리셋으로 가져오기', exact: true }).query()
	).toBeNull();
	expect(localStorage.getItem(PROMPT_SETTINGS_KEY)).toBeNull();
	await screen.unmount();
});

it('shows file errors without replacing the current draft and imports a valid file without another confirmation step', async () => {
	const screen = await openPrompts();
	await uploadPrompt('{invalid', 'bad.json');
	await expect.element(page.getByRole('alert')).toBeVisible();
	await expect.element(nameInput()).toHaveValue('기본 프롬프트');
	await expect.element(importFile()).toHaveValue('');
	await uploadPrompt({ name: '잘못된 프리셋', config: null });
	await expect.element(page.getByRole('alert')).toBeVisible();
	await expect.element(nameInput()).toHaveValue('기본 프롬프트');
	await expect.element(save()).toBeDisabled();
	expect(loadPromptSettings().presets).toHaveLength(1);
	await uploadPrompt({ name: '파일 프리셋', config: parsePromptConfig(undefined) });
	await expect.element(nameInput()).toHaveValue('파일 프리셋');
	expect(page.getByRole('alert').query()).toBeNull();
	await expect.element(save()).toBeEnabled();
	expect(loadPromptSettings().presets).toHaveLength(1);
	await save().click();
	expect(loadPromptSettings().presets).toHaveLength(2);
	await screen.unmount();
});

it('guards replacing unsaved edits and accepts the same file again after cancelling the replacement', async () => {
	const screen = await openPrompts();
	await nameInput().fill('유지할 수정 내용');
	const file = new File(
		[
			JSON.stringify({
				name: '새로 가져온 프리셋',
				config: parsePromptConfig({ promptTemplate: [{ type: 'plain', text: '새 본문' }] })
			})
		],
		'same-prompt.json',
		{ type: 'application/json' }
	);
	await userEvent.upload(importFile(), file);
	await expect.element(discard()).toBeVisible();
	await discard().getByRole('button', { name: '돌아가기', exact: true }).click();
	await expect.element(nameInput()).toHaveValue('유지할 수정 내용');
	await expect.element(importFile()).toHaveValue('');
	expect(localStorage.getItem(PROMPT_SETTINGS_KEY)).toBeNull();
	await userEvent.upload(importFile(), file);
	await expect.element(discard()).toBeVisible();
	await discard().getByRole('button', { name: '변경 사항 버리기', exact: true }).click();
	await expect.element(nameInput()).toHaveValue('새로 가져온 프리셋');
	await expect
		.element(page.getByRole('textbox', { name: '프롬프트', exact: true }))
		.toHaveValue('새 본문');
	expect(loadPromptSettings().presets).toHaveLength(1);
	await save().click();
	expect(loadPromptSettings().presets).toHaveLength(2);
	await screen.unmount();
});

it('duplicates and confirms deletion of presets while keeping at least one preset', async () => {
	const screen = await openPrompts();
	await expect
		.element(page.getByRole('button', { name: '프리셋 삭제', exact: true }))
		.toBeDisabled();
	await page.getByRole('button', { name: '복제', exact: true }).click();
	await expect.element(nameInput()).toHaveValue('기본 프롬프트 복사본');
	await save().click();
	expect(loadPromptSettings().presets).toHaveLength(2);
	await page.getByRole('button', { name: '프리셋 삭제', exact: true }).click();
	const confirmation = page.getByRole('dialog', { name: '프롬프트 프리셋 삭제', exact: true });
	await confirmation.getByRole('button', { name: '돌아가기', exact: true }).click();
	expect(loadPromptSettings().presets).toHaveLength(2);
	await page.getByRole('button', { name: '프리셋 삭제', exact: true }).click();
	await confirmation.getByRole('button', { name: '프리셋 삭제', exact: true }).click();
	expect(loadPromptSettings().presets).toHaveLength(1);
	await expect.element(nameInput()).toHaveValue('기본 프롬프트');
	await expect
		.element(page.getByRole('button', { name: '프리셋 삭제', exact: true }))
		.toBeDisabled();
	await screen.unmount();
});

it('keeps all prompt controls within a narrow viewport and allows keyboard editing of cache and chat blocks', async () => {
	savePromptSettings(
		upsertPromptPreset(emptyPromptSettings(), {
			id: 'compact',
			name: '좁은 화면',
			config: parsePromptConfig({
				promptTemplate: [
					{ type: 'cache', role: 'all', depth: 2 },
					{ type: 'chat', rangeStart: -5, rangeEnd: 'end' }
				]
			})
		})
	);
	await page.viewport(390, 844);
	const screen = await openPrompts();
	await page.getByRole('combobox', { name: '편집할 프리셋', exact: true }).selectOptions('compact');
	const cache = page.getByRole('region', { name: '1번 프롬프트 블록', exact: true });
	await cache.getByRole('spinbutton', { name: '깊이', exact: true }).fill('3');
	const chat = page.getByRole('region', { name: '2번 프롬프트 블록', exact: true });
	await chat.getByRole('button', { name: '챗', exact: true }).click();
	expect(chat.getByRole('combobox', { name: '역할', exact: true }).query()).toBeNull();
	await chat.getByRole('spinbutton', { name: '범위 시작', exact: true }).fill('-9');
	await save().click();
	expect(
		loadPromptSettings().presets.find((preset) => preset.id === 'compact')!.config.promptTemplate
	).toMatchObject([{ depth: 3 }, { rangeStart: -9 }]);
	const dialog = page.getByRole('dialog', { name: '설정', exact: true }).element();
	expect(dialog.scrollWidth).toBeLessThanOrEqual(390);
	const panel = page.getByRole('region', { name: '프롬프트 설정', exact: true }).element();
	expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
	await screen.unmount();
});

function expectPromptBlockLayout(main: ReturnType<typeof page.getByRole>) {
	const type = main
		.getByRole('combobox', { name: '타입', exact: true })
		.element() as HTMLSelectElement;
	expect(Array.from(type.options, (option) => option.text)).toEqual([
		'순수 프롬프트',
		'탈옥 프롬프트',
		'생각의 사슬',
		'페르소나 프롬프트',
		'캐릭터 설명',
		'로어북',
		'최종 삽입 프롬프트',
		'장기 기억',
		'작가의 노트',
		'챗',
		'ChatML',
		'캐시 포인트'
	]);
	const special = main
		.getByRole('combobox', { name: '특수 타입', exact: true })
		.element() as HTMLSelectElement;
	expect(Array.from(special.options, (option) => option.text)).toEqual([
		'특수 타입 없음',
		'메인 프롬프트',
		'글로벌 노트'
	]);
	const role = main
		.getByRole('combobox', { name: '역할', exact: true })
		.element() as HTMLSelectElement;
	expect(Array.from(role.options, (option) => option.text)).toEqual([
		'시스템 프롬프트',
		'유저',
		'캐릭터'
	]);
	expect(
		Array.from(main.element().querySelectorAll('.block-fields > label'), (label) =>
			label.firstChild?.textContent?.trim()
		)
	).toEqual(['이름', '타입', '특수 타입', '프롬프트', '역할']);
	const bounds = [
		main.getByRole('textbox', { name: '이름', exact: true }).element(),
		type,
		special,
		main.getByRole('textbox', { name: '프롬프트', exact: true }).element(),
		role
	].map((control) => control.getBoundingClientRect());
	expect(bounds.every((rect) => rect.x === bounds[0].x && rect.width === bounds[0].width)).toBe(
		true
	);
	expect(bounds.every((rect, index) => index === 0 || rect.y > bounds[index - 1].y)).toBe(true);
}

function expectSavedPrompt(preset: ReturnType<typeof loadPromptSettings>['presets'][number]) {
	expect(preset.config).toMatchObject({
		version: 2,
		maxTokens: 8192,
		promptSettings: { sendChatAsSystem: true, assistantPrefill: '이야기:' }
	});
	expect(preset.config.promptTemplate[0]).toMatchObject({
		type: 'plain',
		type2: 'main',
		text: '장면을 생생하게 묘사하세요.'
	});
	expect(preset.config.promptTemplate[2]).toMatchObject({
		type: 'persona',
		text: '여행자',
		innerFormat: 'Persona: {{slot}}'
	});
	expect(preset.config.promptTemplate[8]).toMatchObject({
		type: 'postEverything',
		text: '장면을 마무리하세요.'
	});
	expect(preset.config.promptTemplate[7]).toMatchObject({
		name: '보충 지시',
		type: 'jailbreak',
		type2: 'globalNote',
		role: 'user',
		text: '추가 지시',
		enabled: false
	});
}
