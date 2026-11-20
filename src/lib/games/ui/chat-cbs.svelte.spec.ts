import '../../../app.css';
import { beforeEach, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

import { emptyAISettings } from '#lib/app/settings/model.js';
import { savePersonaSettings } from '#lib/app/settings/persona-repository.js';
import { emptyPersonaSettings, upsertPersona } from '#lib/app/settings/personas.js';
import { savePromptSettings } from '#lib/app/settings/prompt-repository.js';
import { emptyPromptSettings } from '#lib/app/settings/prompts.js';
import { parsePromptConfig } from '#lib/games/ai/prompts.js';

import { createRegexRule } from '../regex.js';
import {
	appendUserMessage,
	appendSessionMessage,
	createGame,
	getSessionTimeline,
	updateGameRules,
	updateGameSettings,
	selectSessionBranch,
	commitSessionTransaction
} from '../repository.js';
import SessionChat from './SessionChat.svelte';

vi.mock('#lib/app/settings/repository.js', () => ({ loadAISettings: () => emptyAISettings() }));
vi.mock('#lib/storage/transport.js', async () => {
	const { memoryStorage } = await import('#lib/testing/memory-storage.js');
	return { storageRequest: memoryStorage() };
});
const persona = { id: 'player', name: '백종원', description: '대장장이' };
beforeEach(() => {
	localStorage.clear();
	savePersonaSettings({
		...upsertPersona(emptyPersonaSettings(), persona),
		selectedPersonaId: persona.id
	});
});
async function fixture() {
	const game = await createGame();
	await updateGameRules(game.id, {
		initialState: { gold: 10 },
		scripts: {},
		schema: {
			type: 'object',
			properties: { gold: { type: 'integer' } },
			required: ['gold'],
			additionalProperties: false
		}
	});
	await updateGameSettings(game.id, {
		title: '대장간',
		description: '',
		authorNote: '',
		firstMessage: '{{user}}님, {{game}}에 오셨군요. {{state::gold}}G'
	});
	const mount = () =>
		render(SessionChat, {
			gameId: game.id,
			sessionId: game.activeSessionId,
			gameTitle: '대장간',
			onsessionupdate: vi.fn(),
			onsavingchange: vi.fn()
		});
	return { game, mount };
}
it('refreshes preset toggle conditions in chat without changing messages, state or history', async () => {
	const settings = emptyPromptSettings();
	settings.presets[0].config = parsePromptConfig({ toggles: 'detail=Detailed' });
	savePromptSettings(settings);
	const { game, mount } = await fixture();
	const source = '{{#when::toggle::detail}}자세한 설명{{:else}}짧은 설명{{/when}}';
	await appendUserMessage(game.id, game.activeSessionId, source);
	const before = await getSessionTimeline(game.id, game.activeSessionId);
	mount();
	await expect.element(page.getByText('짧은 설명', { exact: true })).toBeVisible();
	settings.presets[0].config.toggleValues.detail = '1';
	savePromptSettings(settings);
	await expect.element(page.getByText('자세한 설명', { exact: true })).toBeVisible();
	expect(await getSessionTimeline(game.id, game.activeSessionId)).toEqual(before);
});
it('renders user/assistant/opening messages and keeps saved source and composer unchanged', async () => {
	const { game, mount } = await fixture();
	await appendUserMessage(game.id, game.activeSessionId, '{{user}}가 해드리죠!');
	const current = await getSessionTimeline(game.id, game.activeSessionId);
	await appendSessionMessage(game.id, game.activeSessionId, {
		expectedRevision: current.history.progress.revision,
		message: { role: 'assistant', content: '{{user}}님, 기다릴게요.' }
	});
	const screen = mount();
	await expect.element(page.getByText('백종원가 해드리죠!', { exact: true })).toBeVisible();
	await expect.element(page.getByText('백종원님, 기다릴게요.', { exact: true })).toBeVisible();
	await expect
		.element(page.getByText('백종원님, 대장간에 오셨군요. 10G', { exact: true }))
		.toBeVisible();
	const composer = page.getByRole('textbox', { name: '메시지', exact: true });
	await composer.fill('{{user}}가 뭘로 보이십니까?');
	await expect.element(composer).toHaveValue('{{user}}가 뭘로 보이십니까?');
	savePersonaSettings({
		...upsertPersona(emptyPersonaSettings(), { ...persona, name: '여행자' }),
		selectedPersonaId: persona.id
	});
	await expect.element(page.getByText('여행자가 해드리죠!', { exact: true })).toBeVisible();
	await expect.element(composer).toHaveValue('{{user}}가 뭘로 보이십니까?');
	expect(
		(await getSessionTimeline(game.id, game.activeSessionId)).messages.map(
			(message) => message.content
		)
	).toEqual([
		'{{user}}님, {{game}}에 오셨군요. {{state::gold}}G',
		'{{user}}가 해드리죠!',
		'{{user}}님, 기다릴게요.'
	]);
	await screen.unmount();
	mount();
	await expect.element(page.getByText('여행자가 해드리죠!', { exact: true })).toBeVisible();
});
it('refreshes displayed state after branch changes without rewriting opening content', async () => {
	const { game, mount } = await fixture();
	const current = await getSessionTimeline(game.id, game.activeSessionId);
	await commitSessionTransaction(game.id, game.activeSessionId, {
		expectedRevision: current.history.progress.revision,
		parentId: current.history.progress.headId,
		nextState: { gold: 4 },
		action: { name: 'spend', args: {} }
	});
	mount();
	await expect
		.element(page.getByText('백종원님, 대장간에 오셨군요. 4G', { exact: true }))
		.toBeVisible();
	const next = await getSessionTimeline(game.id, game.activeSessionId);
	await selectSessionBranch(game.id, game.activeSessionId, null, next.history.progress.revision);
	await expect
		.element(page.getByText('백종원님, 대장간에 오셨군요. 10G', { exact: true }))
		.toBeVisible();
	expect((await getSessionTimeline(game.id, game.activeSessionId)).messages[0].content).toContain(
		'{{state::gold}}'
	);
});
it('expands CBS generated by display regex and leaves other messages readable after a CBS error', async () => {
	const { game, mount } = await fixture();
	await appendUserMessage(game.id, game.activeSessionId, '{{calc::1/0}}');
	const screen = mount();
	await screen.rerender({
		regex: [{ ...createRegexRule(), pattern: '오셨군요', replacement: '{{user}}의 주문입니다' }]
	});
	await expect
		.element(page.getByText('백종원님, 대장간에 백종원의 주문입니다. 10G', { exact: true }))
		.toBeVisible();
	await expect.element(page.getByRole('alert')).toHaveTextContent('CBS:');
	await expect.element(page.getByText('{{calc::1/0}}', { exact: true })).not.toBeInTheDocument();
	expect((await getSessionTimeline(game.id, game.activeSessionId)).messages[1].content).toBe(
		'{{calc::1/0}}'
	);
});
