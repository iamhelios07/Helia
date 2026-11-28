import '../../../app.css';
import { beforeNavigate, goto } from '$app/navigation';
import { beforeEach, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

import { storageRequest } from '#lib/storage/transport.js';

import type { EditorDraft } from '../editor.js';

import { loadAuthoringDraft, saveAuthoringDraft } from '../editor-draft-storage.js';
import { createEditorDraft } from '../editor.js';
import { createGame } from '../repository.js';
import { monacoModel, setMonacoSource } from './editor/monaco-test.js';
import GameEditor from './GameEditor.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn(), beforeNavigate: vi.fn() }));
vi.mock('../editor-draft-storage.js', () => ({
	loadAuthoringDraft: vi.fn(),
	saveAuthoringDraft: vi.fn()
}));
vi.mock('#lib/storage/transport.js', async () => ({
	storageRequest: vi.fn((await import('#lib/testing/memory-storage.js')).memoryStorage())
}));

const drafts = new Map<string, { version: number; draft: EditorDraft | null }>();
beforeEach(async () => {
	vi.clearAllMocks();
	drafts.clear();
	localStorage.clear();
	vi.mocked(goto).mockReset().mockResolvedValue(undefined);
	vi.mocked(loadAuthoringDraft).mockImplementation(async (id) =>
		structuredClone(drafts.get(id) ?? { version: 0, draft: null })
	);
	vi.mocked(saveAuthoringDraft)
		.mockReset()
		.mockImplementation(async (id, draft, version) => {
			const next = structuredClone({ version: version + 1, draft });
			drafts.set(id, next);
			return next;
		});
	await page.viewport(1280, 850);
});

async function setup() {
	const game = await createGame();
	const draft = createEditorDraft(game);
	const code = JSON.parse(draft.documents.code);
	code.files['logic/helper.ts'] = { language: 'typescript', source: 'export const value = 1;' };
	draft.documents.code = JSON.stringify(code, null, 2);
	draft.documents.assets = JSON.stringify({
		luka: {
			name: '인물/루카 #1%.png',
			mime: 'image/png',
			data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
		}
	});
	drafts.set(game.id, { version: 1, draft });
	return game;
}

function mount(gameId: string, documentRoute: string) {
	const view = render(GameEditor, { gameId, documentRoute });
	const root = `/games/${gameId}/edit`;
	vi.mocked(goto).mockImplementation(async (href) => {
		const url = new URL(String(href), window.location.href);
		await view.rerender({
			documentRoute: decodeURIComponent(url.pathname.slice(root.length).replace(/^\//, ''))
		});
	});
	return view;
}

it('canonicalizes the root and navigates document tabs without reloading the editor or losing edits', async () => {
	const game = await setup();
	const view = mount(game.id, '');
	await expect.element(page.getByRole('textbox', { name: '이름', exact: true })).toBeVisible();
	await expect
		.poll(() => vi.mocked(goto).mock.calls[0]?.[0])
		.toBe(`/games/${game.id}/edit/game.json`);
	expect(vi.mocked(goto).mock.calls[0][1]).toMatchObject({
		replace: true,

		reset: false
	});
	await page.getByRole('textbox', { name: '이름', exact: true }).fill('탭 사이에 보존');
	await page.getByRole('button', { name: 'regex.json', exact: true }).click();
	await expect.element(page.getByRole('button', { name: '규칙 추가', exact: true })).toBeVisible();
	expect(vi.mocked(goto).mock.lastCall?.[0]).toBe(`/games/${game.id}/edit/regex.json`);
	await view.rerender({ documentRoute: 'game.json' });
	await expect
		.element(page.getByRole('textbox', { name: '이름', exact: true }))
		.toHaveValue('탭 사이에 보존');
	expect(loadAuthoringDraft).toHaveBeenCalledOnce();
	const leases = () =>
		vi
			.mocked(storageRequest)
			.mock.calls.map(([request]) => request)
			.filter((request) => request.kind === 'editorLease');
	expect(leases()).toEqual([expect.objectContaining({ gameId: game.id, action: 'renew' })]);
	await view.unmount();
	await expect.poll(leases).toEqual([leases()[0], { ...leases()[0], action: 'release' }]);
});

it('opens draft-only nested code directly and retains the same Monaco model on back/forward selection', async () => {
	const game = await setup();
	const view = mount(game.id, 'code/logic/helper.ts');
	const model = await monacoModel('logic/helper.ts 소스');
	await setMonacoSource('logic/helper.ts 소스', 'export const value = 2;');
	await view.rerender({ documentRoute: 'instructions.json' });
	await expect.element(page.getByRole('textbox', { name: '게임 설명', exact: true })).toBeVisible();
	await view.rerender({ documentRoute: 'code/logic/helper.ts' });
	expect(await monacoModel('logic/helper.ts 소스')).toBe(model);
	expect(model.getValue()).toBe('export const value = 2;');
	expect(loadAuthoringDraft).toHaveBeenCalledOnce();
	expect(goto).not.toHaveBeenCalled();
});

it('shows an editor warning after repeated lease renewal failures and clears it on recovery', async () => {
	const game = await setup();
	const wire = vi.mocked(storageRequest);
	const original = wire.getMockImplementation()!;
	let offline = true;
	let renewals = 0;
	wire.mockImplementation((request) => {
		if (request.kind === 'editorLease' && request.action === 'renew') {
			renewals++;
			return offline
				? Promise.reject(Error('offline'))
				: Promise.resolve({ version: 0, records: [] });
		}
		return original(request);
	});
	const view = mount(game.id, 'game.json');
	try {
		await expect.element(page.getByRole('textbox', { name: '이름', exact: true })).toBeVisible();
		await expect.poll(() => renewals).toBe(1);
		const warning = page.getByRole('alert').filter({ hasText: '편집 중인 파일을 보호하지 못하고' });
		await expect.element(warning).not.toBeInTheDocument();
		window.dispatchEvent(new Event('pageshow'));
		await expect.element(warning).toBeVisible();
		offline = false;
		window.dispatchEvent(new Event('pageshow'));
		await expect.element(warning).not.toBeInTheDocument();
	} finally {
		await view.unmount();
		wire.mockImplementation(original);
	}
});

it('renames and removes the current code file using replacement URLs', async () => {
	const game = await setup();
	mount(game.id, 'code/logic/helper.ts');
	await expect
		.element(page.getByRole('textbox', { name: 'logic/helper.ts 소스', exact: true }))
		.toBeVisible();
	await page.getByRole('button', { name: 'logic/helper.ts 작업', exact: true }).click();
	await page.getByRole('button', { name: 'logic/helper.ts 이름 변경', exact: true }).click();
	await page.getByRole('textbox', { name: '이름', exact: true }).fill('renamed.ts');
	await page.getByRole('button', { name: '확인', exact: true }).click();
	await expect
		.element(page.getByRole('textbox', { name: 'logic/renamed.ts 소스', exact: true }))
		.toBeVisible();
	expect(goto).toHaveBeenLastCalledWith(
		`/games/${game.id}/edit/code/logic/renamed.ts`,
		expect.objectContaining({ replace: true })
	);
	await page.getByRole('button', { name: 'logic/renamed.ts 작업', exact: true }).click();
	await page.getByRole('button', { name: 'logic/renamed.ts 삭제', exact: true }).click();
	await page.getByRole('button', { name: '삭제', exact: true }).click();
	await expect
		.element(page.getByRole('tab', { name: '게임 지침', exact: true }))
		.toHaveAttribute('aria-selected', 'true');
	expect(vi.mocked(goto).mock.lastCall?.[0]).toBe(`/games/${game.id}/edit/instructions.json`);
});

it('opens and renames an asset by its visible filename while preserving its identity', async () => {
	const game = await setup();
	mount(game.id, 'assets/인물/루카 #1%.png');
	await expect
		.element(page.getByRole('textbox', { name: '에셋 파일 경로', exact: true }))
		.toHaveValue('인물/루카 #1%.png');
	await page.getByRole('button', { name: '인물/루카 #1%.png 작업', exact: true }).click();
	await page.getByRole('button', { name: '인물/루카 #1%.png 이름 변경', exact: true }).click();
	await page.getByRole('textbox', { name: '이름', exact: true }).fill('새 루카.png');
	await page.getByRole('button', { name: '확인', exact: true }).click();
	await expect
		.element(page.getByRole('textbox', { name: '에셋 파일 경로', exact: true }))
		.toHaveValue('인물/새 루카.png');
	expect(goto).toHaveBeenLastCalledWith(
		`/games/${game.id}/edit/assets/${encodeURIComponent('인물')}/${encodeURIComponent('새 루카.png')}`,
		expect.objectContaining({ replace: true })
	);
});

it('shows missing-file guidance without replacing the requested URL and can open generated declarations', async () => {
	const game = await setup();
	mount(game.id, 'code/deleted.ts');
	await expect.element(page.getByRole('alert').filter({ hasText: '요청한 파일' })).toBeVisible();
	expect(goto).not.toHaveBeenCalled();
	await page.getByRole('button', { name: /runtime\.d\.ts/ }).click();
	await expect
		.element(page.getByRole('textbox', { name: '.helia/runtime.d.ts 소스', exact: true }))
		.toBeVisible();
	expect(vi.mocked(goto).mock.lastCall?.[0]).toBe(`/games/${game.id}/edit/.helia/runtime.d.ts`);
});

it('retains unsaved edits during internal document navigation while guarding a true departure', async () => {
	const game = await setup();
	mount(game.id, 'game.json');
	await expect.element(page.getByRole('textbox', { name: '이름', exact: true })).toBeVisible();
	vi.mocked(saveAuthoringDraft).mockRejectedValue(Error('저장 실패'));
	await page.getByRole('textbox', { name: '이름', exact: true }).fill('아직 보존할 초안');
	const callback = vi.mocked(beforeNavigate).mock.lastCall![0];
	const cancel = vi.fn();
	const target = new URL(`/games/${game.id}/edit/state.json`, window.location.origin);
	const navigation = {
		cancel,
		type: 'goto' as const,
		shallow: false,
		from: null,
		to: {
			url: target,
			params: { id: game.id },
			route: { id: '/games/[id]/edit/[...document]' as const },
			scroll: null
		},
		willUnload: false,
		complete: Promise.resolve()
	};
	callback(navigation);
	expect(cancel).not.toHaveBeenCalled();
	callback({
		...navigation,
		to: { ...navigation.to, url: new URL('/', window.location.origin), route: { id: '/' } }
	});
	expect(cancel).toHaveBeenCalledOnce();
});
