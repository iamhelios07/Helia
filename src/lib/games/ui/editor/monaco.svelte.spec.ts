import '../../../../app.css';
import { getTypeScriptWorker } from 'monaco-editor/languages/features/typescript/register.js';
import { afterEach, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';

import { MonacoProject, projectOpenTarget } from './monaco-project.js';
import { getMonacoSource, monacoModel, setMonacoSource } from './monaco-test.js';
import SourceEditor from './SourceEditor.svelte';
const projects: MonacoProject[] = [];
afterEach(() => {
	projects.splice(0).forEach((project) => project.dispose());
});
it('completes imported generic argument fields and type-checks Action and Query callbacks', async () => {
	const session = new MonacoProject();
	projects.push(session);
	const source = `import type {Args} from './args';
helia.defineAction<Args>({name:'buy',run({state,args}){state.gold -= args.price; return state;}});
helia.defineQuery<Args>({name:'read',run({args}){return args.tags;}});
helia.defineAction({name:'rest',run({state}){return state;}});`;
	session.update(
		{
			'main.ts': { language: 'typescript', source },
			'args.ts': {
				language: 'typescript',
				source: "export interface Args {price:number; item:'sword'|'shield'; tags:string[];}"
			}
		},
		'export type GameState = {gold:number};'
	);
	const { monaco } = await session.ready();
	const model = session.model('main.ts', source, 'typescript');
	const host = document.createElement('div');
	document.body.append(host);
	const instance = monaco.editor.create(host, { model });
	try {
		await expect
			.poll(async () => {
				try {
					await getTypeScriptWorker();
					return true;
				} catch {
					return false;
				}
			})
			.toBe(true);
		const proxy = await (await getTypeScriptWorker())(model.uri);
		expect(await proxy.getSemanticDiagnostics(model.uri.toString())).toEqual([]);
		const offset = source.indexOf('args.price') + 'args.'.length;
		const completions = await proxy.getCompletionsAtPosition(model.uri.toString(), offset);
		expect(completions?.entries.map((entry: { name: string }) => entry.name)).toEqual(
			expect.arrayContaining(['price', 'item'])
		);
		model.setValue(source.replace('args.price', 'args.price.toUpperCase()'));
		expect((await proxy.getSemanticDiagnostics(model.uri.toString())).length).toBeGreaterThan(0);
	} finally {
		instance.dispose();
		host.remove();
	}
});
function project(field: string, source = 'helia.getState().') {
	const session = new MonacoProject();
	projects.push(session);
	session.update(
		{ 'main.ts': { language: 'typescript', source } },
		'export type GameState = { ' + field + ': number };'
	);
	return session;
}
it('loads Monaco and its local language worker, completes and edits with the keyboard', async () => {
	const session = project('gold', 'helia.def');
	render(SourceEditor, {
		project: session,
		path: 'main.ts',
		value: 'helia.def',
		language: 'typescript',
		label: '코드',
		onchange: () => {}
	});
	document.querySelector<HTMLElement>('.source-editor')!.style.height = '300px';
	const input = page.getByRole('textbox', { name: '코드', exact: true });
	await expect.element(input).toBeVisible();
	const { monaco } = await session.ready();
	const codeEditor = monaco.editor
		.getEditors()
		.find((item) => item.getModel()?.uri.toString() === session.root + 'main.ts')!;
	codeEditor.focus();
	codeEditor.setPosition({ lineNumber: 1, column: 10 });
	await userEvent.keyboard('{Control>} {/Control}');
	await expect.element(page.getByRole('listbox')).toBeVisible();
	await expect
		.poll(() => document.querySelector('[role=listbox]')?.textContent)
		.toContain('defineAction');
	await expect
		.element(page.getByRole('listbox').getByText('defineAction', { exact: true }))
		.toBeVisible();
	await userEvent.keyboard('{Enter}');
	await expect.poll(() => getMonacoSource('코드')).toBe('helia.defineAction');
	await userEvent.keyboard('{Control>}z{/Control}');
	await expect.poll(() => getMonacoSource('코드')).toBe('helia.def');
});
it('isolates generated state types while switching worker requests between editor projects', async () => {
	const first = project('gold'),
		second = project('health');
	const { monaco } = await first.ready();
	await second.ready();
	const a = first.model('main.ts', '', 'typescript'),
		b = second.model('main.ts', '', 'typescript');
	const host = document.createElement('div');
	document.body.append(host);
	const instance = monaco.editor.create(host, { model: a });
	try {
		const worker = await getTypeScriptWorker();
		const proxy = await worker(a.uri, b.uri);
		const names = async (model: typeof a) =>
			(
				await proxy.getCompletionsAtPosition(model.uri.toString(), model.getValueLength())
			)?.entries.map((item: { name: string }) => item.name) ?? [];
		expect(await names(a)).toContain('gold');
		expect(await names(a)).not.toContain('health');
		expect(await names(b)).toContain('health');
		expect(await names(b)).not.toContain('gold');
		a.setValue('helia.getState().gold.toUpperCase();');
		expect((await proxy.getSemanticDiagnostics(a.uri.toString())).length).toBeGreaterThan(0);
		expect(await names(b)).toContain('health');
	} finally {
		instance.dispose();
		host.remove();
	}
});
it('keeps file undo and view state across tabs, blocks generated types, and diagnoses JSON', async () => {
	const session = project('gold', 'const count = 1;');
	session.update(
		{
			'main.ts': { language: 'typescript', source: 'const count = 1;' },
			'other.ts': { language: 'typescript', source: 'export {};' }
		},
		'export type GameState = {gold:number};',
		{ 'state.json': '{}' }
	);
	const screen = render(SourceEditor, {
		project: session,
		path: 'main.ts',
		value: 'const count = 1;',
		language: 'typescript',
		label: '코드',
		onchange: () => {}
	});
	document.querySelector<HTMLElement>('.source-editor')!.style.height = '300px';
	await setMonacoSource('코드', 'const count = 2;');
	await screen.rerender({ path: 'other.ts', value: 'export {};' });
	await expect.poll(() => getMonacoSource('코드')).toBe('export {};');
	await screen.rerender({ path: 'main.ts', value: 'const count = 2;' });
	const input = page.getByRole('textbox', { name: '코드', exact: true });
	(input.element() as HTMLTextAreaElement).focus();
	await userEvent.keyboard('{Control>}z{/Control}');
	await expect.poll(() => getMonacoSource('코드')).toBe('const count = 1;');
	await screen.rerender({
		path: 'GameState.d.ts',
		value: 'export type GameState = {gold:number};',
		readonly: true
	});
	await expect.element(input).toHaveAttribute('readonly');
	const before = await getMonacoSource('코드');
	await userEvent.keyboard('x');
	expect(await getMonacoSource('코드')).toBe(before);
	await screen.rerender({ path: 'state.json', value: '{bad', language: 'json', readonly: false });
	const json = await monacoModel('코드');
	const { monaco } = await session.ready();
	await expect
		.poll(() => monaco.editor.getModelMarkers({ resource: json.uri }).length)
		.toBeGreaterThan(0);
	const uri = json.uri;
	screen.unmount();
	session.dispose();
	expect(monaco.editor.getModel(uri)).toBeNull();
});

it('checks packaged imports, state completion and TSX APIs without requiring an h import', async () => {
	const session = project('gold');
	session.update(
		{
			'logic.ts': {
				language: 'typescript',
				source:
					"import { amount } from './helper';\nhelia.defineAction({name:'gain',arguments:{},run({state}){state.gold=amount;return state;}});"
			},
			'helper.ts': { language: 'typescript', source: 'export const amount = "wrong";' },
			'view.tsx': {
				language: 'tsx',
				source:
					"import { registerPanel, useGameState, asset } from '@helia/ui';\nregisterPanel({id:'stats',title:'Stats',component:()=> <span>{useGameState().gold}{asset('images/test.png')}</span>});"
			},
			'query.ts': { language: 'typescript', source: 'helia.getState().' }
		},
		'export type GameState = {gold:number};'
	);
	const { monaco } = await session.ready();

	const logic = session.model('logic.ts', '', 'typescript');
	const ui = session.model('view.tsx', '', 'tsx');
	// Opening a source model activates Monaco's native language providers.
	const host = document.createElement('div');
	document.body.append(host);
	const instance = monaco.editor.create(host, { model: logic });
	try {
		const ts = await getTypeScriptWorker();
		const proxy = await ts(logic.uri, ui.uri);
		const errors = await proxy.getSemanticDiagnostics(logic.uri.toString());
		expect(errors.map((item) => String(item.messageText)).join(' ')).toContain('not assignable');
		expect(await proxy.getSemanticDiagnostics(ui.uri.toString())).toEqual([]);
		const query = session.model('query.ts', '', 'typescript');
		instance.setModel(query);
		const completion = await proxy.getCompletionsAtPosition(
			query.uri.toString(),
			query.getValueLength()
		);
		expect(completion.entries.map((item: { name: string }) => item.name)).toContain('gold');
	} finally {
		instance.dispose();
		host.remove();
	}
});

it('resolves helia and @helia/ui symbols to the shipped declaration file', async () => {
	const session = project('gold', "helia.defineAction({name:'buy',run({state}){return state;}});");
	const source =
		"import { useGameState } from '@helia/ui';\nhelia.defineAction({name:'buy',run({state}){return state;}});\nuseGameState();";
	session.update(
		{ 'main.ts': { language: 'typescript', source } },
		'export type GameState = {gold:number};'
	);
	const { monaco } = await session.ready();
	const model = session.model('main.ts', source, 'typescript');
	const host = document.createElement('div');
	document.body.append(host);
	const instance = monaco.editor.create(host, { model });
	try {
		const proxy = await (await getTypeScriptWorker())(model.uri);
		const at = (needle: string) => source.indexOf(needle) + 2;
		for (const needle of ['defineAction', 'useGameState']) {
			const definitions = await proxy.getDefinitionAtPosition(model.uri.toString(), at(needle));
			expect(definitions?.[0]?.fileName).toBe(session.root + '.helia/runtime.d.ts');
		}
		// The opener maps that model onto the declaration tab and refuses foreign models.
		expect(
			projectOpenTarget(session.root, session.root + '.helia/runtime.d.ts', {
				lineNumber: 3,
				column: 7
			})
		).toEqual({ path: '.helia/runtime.d.ts', position: { lineNumber: 3, column: 7 } });
		expect(projectOpenTarget(session.root, 'file:///other/model.ts')).toBeUndefined();
	} finally {
		instance.dispose();
		host.remove();
	}
});

it('reports unused declarations and keeps affecting other files without extra libraries', async () => {
	const session = new MonacoProject();
	projects.push(session);
	session.update(
		{
			'main.ts': {
				language: 'typescript',
				source: "import { gain } from './helper';\nconst unusedLocal = 1;\nexport {};\n"
			},
			'helper.ts': { language: 'typescript', source: 'export const gain = 1;' }
		},
		'export type GameState = {gold:number};'
	);
	const { monaco } = await session.ready();
	const main = session.model('main.ts', '', 'typescript');
	const host = document.createElement('div');
	document.body.append(host);
	// Creating the editor registers Monaco's native language providers for the attached model.
	const instance = monaco.editor.create(host, { model: main });
	try {
		await expect
			.poll(async () => {
				try {
					await getTypeScriptWorker();
					return true;
				} catch {
					return false;
				}
			})
			.toBe(true);
		const proxy = await (
			await getTypeScriptWorker()
		)(main.uri, session.model('helper.ts', '', 'typescript').uri);
		// Unused-code fading comes from suggestion diagnostics' reportsUnnecessary flag.
		const suggestions = await proxy.getSuggestionDiagnostics(main.uri.toString());
		expect(suggestions.some((item) => Boolean(item.reportsUnnecessary))).toBe(true);
		// Cross-file resolution must still work now that files are only models.
		const definitions = await proxy.getDefinitionAtPosition(
			main.uri.toString(),
			main.getValue().indexOf('gain') + 1
		);
		expect(definitions?.[0]?.fileName).toBe(session.root + 'helper.ts');
		// Editing the helper must invalidate the importer, proving models feed the program.
		session
			.model('helper.ts', 'export const gain = 1;', 'typescript')
			.setValue('export const gain = "text";');
		main.setValue("import { gain } from './helper';\nconst total: number = gain;\nexport {};\n");
		await expect
			.poll(async () => (await proxy.getSemanticDiagnostics(main.uri.toString())).length)
			.toBeGreaterThan(0);
	} finally {
		instance.dispose();
		host.remove();
	}
});

it('registers the css language service: markers and highlighting run through the css worker', async () => {
	const session = new MonacoProject();
	projects.push(session);
	session.update({}, '');
	const { monaco } = await session.ready();
	const model = session.model('style.css', '.hp { colr: red; }', 'css');
	const host = document.createElement('div');
	document.body.append(host);
	const instance = monaco.editor.create(host, { model, theme: 'helia' });
	try {
		// cssMode diagnostics come from the css worker; an unknown property must be flagged.
		await expect
			.poll(
				() =>
					monaco.editor
						.getModelMarkers({ resource: model.uri })
						.map((m) => m.message)
						.join('|'),
				{ timeout: 20000 }
			)
			.toContain('Unknown property');
		// The monarch tokenizer produces css token types once the language loads.
		await expect
			.poll(
				() =>
					monaco.editor
						.tokenize('.hp { color: #eab4ae; }', 'css')
						.flat()
						.map((t) => t.type)
						.join('|'),
				{ timeout: 10000 }
			)
			.toContain('attribute.name.css');
	} finally {
		instance.dispose();
		host.remove();
	}
});
