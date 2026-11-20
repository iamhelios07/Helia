import { describe, expect, it } from 'vitest';

import { renderCBS } from './cbs/index.js';
import {
	parsePromptToggles,
	parseToggleValues,
	reconcileToggleValues,
	toggleControls
} from './prompt-toggles.js';
import { assemblePrompt, importPromptPreset, parsePromptConfig } from './prompts.js';

const source = [
	'ignored comment',
	'=Narration=group',
	'detail=Detailed',
	'style=Style=select=Concise,Poetic',
	'note=Note=text',
	'context=Context=textarea',
	'=Choose your style=caption',
	'=Advanced=divider',
	'==groupEnd'
].join('\r\n');

describe('preset toggles', () => {
	it('retains compatible values and resets incompatible controls after definition edits', () => {
		expect(
			reconcileToggleValues('detail=Detailed\nstyle=Style=select=Short,Long\nnote=Note=text', {
				detail: '2',
				style: '1',
				note: 'Keep this',
				removed: 'old'
			})
		).toEqual({ detail: '0', style: '1', note: 'Keep this' });
	});
	it('imports Risu controls, captions, dividers and groups and exports canonical settings', () => {
		const imported = importPromptPreset({ customPromptTemplateToggle: source });
		expect(imported.toggles).toBe(source);
		expect(imported.toggleValues).toEqual({ detail: '0', style: '0', note: '', context: '' });
		expect(parsePromptToggles(source)).toEqual([
			{
				type: 'group',
				label: 'Narration',
				children: [
					{ type: 'checkbox', key: 'detail', label: 'Detailed' },
					{ type: 'select', key: 'style', label: 'Style', options: ['Concise', 'Poetic'] },
					{ type: 'text', key: 'note', label: 'Note' },
					{ type: 'textarea', key: 'context', label: 'Context' },
					{ type: 'caption', label: 'Choose your style' },
					{ type: 'divider', label: 'Advanced' }
				]
			}
		]);
		expect(parsePromptConfig(JSON.parse(JSON.stringify(imported)))).toEqual(imported);
		expect(toggleControls(parsePromptToggles(source))).toHaveLength(4);
	});
	it.each([
		'detail=First\ndetail=Duplicate',
		'__proto__=Unsafe',
		'key=Choice=select=',
		'x'.repeat(65537),
		'\n'.repeat(512),
		'==group\n'.repeat(9)
	])('rejects invalid definitions without changing the source', (input) => {
		expect(() => parsePromptToggles(input)).toThrow();
	});
	it('validates selected indices and checkbox values and bounds text values', () => {
		const items = parsePromptToggles(source);
		for (const values of [
			{ style: '2' },
			{ style: '01' },
			{ detail: 'true' },
			{ note: 1 },
			{ context: 'x'.repeat(32769) }
		]) {
			expect(() => parseToggleValues(items, values)).toThrow();
		}
		expect(parseToggleValues(items, { note: '{{calc::1/0}}', unrelated: 'discard' })).toEqual({
			detail: '0',
			style: '0',
			note: '{{calc::1/0}}',
			context: ''
		});
	});
});

describe('preset toggle CBS', () => {
	it('evaluates Risu toggle operators and reads text without reparsing it', () => {
		const context = { state: {}, toggles: { detail: '1', style: '1', note: '{{calc::1/0}}' } };
		const render = (text: string) => renderCBS(text, context);
		expect(render('{{#when::toggle::detail::and::style::tis::1}}yes{{:else}}no{{/when}}')).toBe(
			'yes'
		);
		expect(render('{{#when::not::toggle::detail}}no{{:else}}yes{{/when}}')).toBe('yes');
		expect(render('{{#when::style::tisnot::0}}yes{{/when}}')).toBe('yes');
		expect(render('{{#when::toggle::missing}}no{{:else}}yes{{/when}}')).toBe('yes');
		expect(render('{{getglobalvar::toggle_note}}|{{toggle::note}}')).toBe(
			'{{calc::1/0}}|{{calc::1/0}}'
		);
		expect(() => render('{{getglobalvar::unrelated}}')).toThrow('toggle_');
		expect(() => render('{{#when::toggle}}x{{/when}}')).toThrow();
		expect(render('{{toggle::constructor}}')).toBe('0');
	});
	it('uses preset values throughout prompt assembly without modifying state or raw messages', () => {
		const ai = parsePromptConfig({
			toggles: source,
			toggleValues: { detail: '1', style: '1', note: 'Extra directions' },
			promptTemplate: [
				{
					type: 'plain',
					text: '{{#when::toggle::detail}}Detailed{{/when}} {{#when::style::tis::1}}Poetic{{/when}} {{getglobalvar::toggle_note}}'
				}
			]
		});
		const state = Object.freeze({ gold: 10 });
		const context = {
			settings: { description: '', firstMessage: '', authorNote: '' },
			messages: [],
			transactions: [],
			memories: [],
			state
		};
		expect(assemblePrompt(ai, context)[0].content).toBe('Detailed Poetic Extra directions');
		expect(state).toEqual({ gold: 10 });
		expect(ai.promptTemplate[0].text).toContain('{{#when');
	});
});
