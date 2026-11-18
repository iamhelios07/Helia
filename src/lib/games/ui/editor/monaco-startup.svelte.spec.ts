import '../../../../app.css';
import { expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

import type { CodeDiagnostic } from '../../code-authoring.js';

import { MonacoProject } from './monaco-project.js';
import { monacoModel } from './monaco-test.js';
import SourceEditor from './SourceEditor.svelte';

it.each([1, 2])(
	'loads authoring declarations in native diagnostics on editor opening %i without needing a source refresh',
	async () => {
		const project = new MonacoProject();
		const source =
			"import { registerPanel, useGameState } from '@helia/ui';\nimport { amount } from './helper';\nregisterPanel({id:'stats',title:'Stats',component:()=> <div><span>{useGameState().gold + amount}</span></div>});\nconst sentinel: number = 'intentional type error';";
		const reports: CodeDiagnostic[][] = [];
		project.update(
			{
				'ui.tsx': { language: 'tsx', source },
				'helper.ts': { language: 'typescript', source: 'export const amount = 1;' }
			},
			'export type GameState = {gold:number};',
			{},
			(items) => reports.push(items)
		);
		const view = render(SourceEditor, {
			project,
			path: 'ui.tsx',
			value: source,
			language: 'tsx',
			label: '초기 코드'
		});
		try {
			await expect
				.element(page.getByRole('textbox', { name: '초기 코드', exact: true }))
				.toBeVisible();
			await expect
				.poll(
					() =>
						reports.some((items) =>
							items.some((item) => item.message.includes('not assignable to type'))
						),
					{ timeout: 15000 }
				)
				.toBe(true);
			const first = reports.find((items) =>
				items.some((item) => item.message.includes('not assignable to type'))
			)!;
			const model = await monacoModel('초기 코드');
			model.setValue(source + '\n');
			await expect
				.poll(
					() =>
						(reports.at(-1) ?? []).filter((item) =>
							/Cannot find module|JSX\.IntrinsicElements/.test(item.message)
						),
					{ timeout: 5000 }
				)
				.toEqual([]);
			expect(
				first.filter((item) => /Cannot find module|JSX\.IntrinsicElements/.test(item.message))
			).toEqual([]);
		} finally {
			await view.unmount();
			project.dispose();
		}
	}
);
