import { describe, expect, it } from 'vitest';

import { renderCBS } from './index.js';
import { migrateCBS } from './migrate.js';
import { CBS_LIMITS } from './model.js';

const context = { state: {}, toggles: { oil: '1', paranumg: '0' } };

describe('deprecated CBS blocks', () => {
	it.each([
		[
			'{{#if 1}}\n  first\n    second\n{{/if}}',
			'{{#when::legacy::1}}\n  first\n    second\n{{/when}}',
			'first\nsecond'
		],
		[
			'{{#if_pure 1}}\n  first\n    second\n{{/if_pure}}',
			'{{#when::keep::1}}\n  first\n    second\n{{/when}}',
			'\n  first\n    second\n'
		],
		['{{#if_pure 0}}hidden{{/if}}', '{{#when::keep::0}}hidden{{/when}}', ''],
		['{{#if::true}}  inline  {{/}}', '{{#when::legacy::true}}  inline  {{/when}}', 'inline']
	])('converts blocks while preserving whitespace semantics: %s', (source, expected, rendered) => {
		const migrated = migrateCBS(source);
		expect(migrated).toEqual({ text: expected, changes: 1 });
		expect(renderCBS(migrated.text, context)).toBe(rendered);
		expect(migrateCBS(migrated.text)).toEqual({ text: migrated.text, changes: 0 });
	});
	it('matches nested legacy and current blocks including blocks inside function arguments', () => {
		const source =
			'{{trim::{{#if_pure 1}} outer {{#when::1}}{{#if 1}} inner {{/}}{{/when}} {{/if_pure}}}}';
		const migrated = migrateCBS(source);
		expect(migrated.changes).toBe(2);
		expect(renderCBS(migrated.text, context)).toBe('outer inner');
	});
	it('leaves literal examples and JSON content untouched', () => {
		const literal = '{{#escape::keep}}{{#if_pure broken}} {{? 1=1}} {{/escape}}';
		expect(migrateCBS(literal)).toEqual({ text: literal, changes: 0 });
		const json = '{{#if_pure 1}}{{dictelement::{"nested":{"n":1},"value":"::}}"}::value}}{{/}}';
		expect(renderCBS(migrateCBS(json).text, context)).toBe('::}}');
	});
	it.each(['pure', 'puredisplay', 'pure_display'])(
		'converts #%s into a non-evaluating literal block',
		(name) => {
			const source = `{{#${name}}}  {{#if 1}}{{calc::1/0}}{{/if}}  {{/${name}}}`;
			const migrated = migrateCBS(source);
			expect(migrated.changes).toBe(1);
			expect(renderCBS(migrated.text, context)).toBe('{{#if 1}}{{calc::1/0}}{{/if}}');
			expect(migrateCBS(migrated.text).changes).toBe(0);
		}
	);
	it('quotes literal escape delimiters without exposing their contents to evaluation', () => {
		const source = '{{#pure}} {{#escape}} {{calc::1/0}} {{/escape}} {{/pure}}';
		const migrated = migrateCBS(source);
		expect(renderCBS(migrated.text, context)).toBe('{{#escape}} {{calc::1/0}} {{/escape}}');
		expect(migrateCBS(migrated.text).changes).toBe(0);
	});
});

describe('imported Risu calculations', () => {
	it('retains the source dialect for nested arithmetic without changing Helia arithmetic', () => {
		const old = '{{#if_pure {{? {{? 2^3^2}}=64}}}}{{? -2^2}}{{/if_pure}}';
		expect(renderCBS(migrateCBS(old).text, context)).toBe('4');
		expect(renderCBS(migrateCBS('{{? 2^3^2}}', true).text, context)).toBe('64');
		expect(renderCBS(migrateCBS('{{? 2^3^2}}').text, context)).toBe('512');
	});
	it('converts the nested oil/paranumg condition and renders all switch/selection combinations', () => {
		const source =
			'{{#if_pure {{? {{? {{getglobalvar::toggle_oil}}=1}} || {{? {{getglobalvar::toggle_paranumg}}=7}}=1}}}}\nEnabled\n{{/if_pure}}';
		const migrated = migrateCBS(source);
		expect(migrated.text).not.toContain('#if_pure');
		expect(migrated.text).toContain('calc::legacy');
		expect(migrated.changes).toBe(4);
		for (const [oil, paranumg, expected] of [
			['0', '0', ''],
			['1', '0', '\nEnabled\n'],
			['0', '7', '\nEnabled\n'],
			['1', '7', '\nEnabled\n']
		]) {
			expect(renderCBS(migrated.text, { state: {}, toggles: { oil, paranumg } })).toBe(expected);
		}
	});
	it.each([
		['{{? 1 || 0 && 0}}', '0'],
		['{{? 2<3}}|{{? 3>=3}}|{{? 2!=2}}', '1|1|0'],
		['{{calc::(2+1)=3}}', '1'],
		['{{?::!0}}', '1'],
		['{{? null=0}}', '1'],
		['{{? -2^2=4}}', '1'],
		['{{? 2^3^2=64}}', '1']
	])('preserves numeric legacy precedence and comparisons: %s', (source, expected) => {
		const migrated = migrateCBS(source);
		expect(renderCBS(migrated.text, context)).toBe(expected);
		expect(migrateCBS(migrated.text).changes).toBe(0);
	});
	it('keeps ordinary arithmetic and current blocks unchanged and rejects host access in legacy math', () => {
		const source = '{{calc::2^3^2}} {{#when::keep::1}} content {{/when}}';
		expect(migrateCBS(source)).toEqual({ text: source, changes: 0 });
		expect(renderCBS(source, context)).toBe('512  content ');
		expect(() => renderCBS('{{calc::legacy::globalThis.alert(1)=0}}', context)).toThrow('CBS:');
		expect(() => renderCBS('{{calc::legacy::1/0}}', context)).toThrow('CBS:');
		expect(() => renderCBS('{{calc::unknown::1}}', context)).toThrow('CBS:');
	});
});

describe('migration failures and bounds', () => {
	it.each([
		'{{#if_pure 1}}missing end',
		'{{#if 1}}a{{:else}}b{{/if}}',
		'{{#if_pure 1}}a{{:else}}b{{/if_pure}}',
		'{{/if}}',
		'{{#if}}x{{/if}}',
		'{{#if 1::or::0}}x{{/if}}',
		'{{#if_pure {{? 1=1}}}broken',
		'{{#pure}}missing end'
	])('rejects ambiguous or malformed rewrites: %s', (source) => {
		expect(() => migrateCBS(source)).toThrow();
	});
	it('bounds input, nested calls and block stacks before running any expressions', () => {
		expect(() => migrateCBS('x'.repeat(CBS_LIMITS.source + 1))).toThrow('입력 크기');
		expect(() => migrateCBS('{{#if 1}}'.repeat(34) + '{{/if}}'.repeat(34))).toThrow('중첩');
		expect(() =>
			migrateCBS('{{#if ' + '{{trim::'.repeat(34) + '1' + '}}'.repeat(34) + '}}x{{/if}}')
		).toThrow('중첩');
	});
});
