import { describe, expect, it } from 'vitest';

import { CBSRenderer, renderCBS, type CBSContext } from './index.js';
import { CBS_LIMITS } from './model.js';

const context: CBSContext = {
	state: {
		gold: 36,
		enabled: true,
		zero: 0,
		no: false,
		empty: '',
		nothing: null,
		phase: 'night_shop',
		inventory: { iron: 3 },
		items: ['검', { name: '방패' }],
		'literal.key': 7
	},
	game: '좋은 장비, 위대한 장비',
	persona: { name: '여행자', description: '{{game}}의 {{user}}' },
	description: '소지금 {{state::gold}}G',
	authornote: '{{user}}의 선택을 기다린다.'
};
const render = (source: string) => renderCBS(source, context);

describe('read-only CBS', () => {
	it.each([
		['{{state::gold}}', '36'],
		['{{state::inventory::iron}}', '3'],
		['{{state::items::1::name}}', '방패'],
		['{{state::literal.key}}', '7'],
		['{{state::zero}}|{{state::no}}|{{state::empty}}|{{state::nothing}}', '0|false||null'],
		['{{state::missing}}', 'null'],
		['{{state::items}}', '["검",{"name":"방패"}]'],
		['{{state}}', JSON.stringify(context.state)],
		['{{game}} / {{user}}', '좋은 장비, 위대한 장비 / 여행자'],
		[
			'{{persona}} / {{userpersona}}',
			'좋은 장비, 위대한 장비의 여행자 / 좋은 장비, 위대한 장비의 여행자'
		],
		['{{description}} / {{author_note}}', '소지금 36G / 여행자의 선택을 기다린다.']
	])('reads state and authored context: %s', (source, expected) => {
		expect(render(source)).toBe(expected);
	});
	it('leaves lookup text, names, slots and unknown functions opaque', () => {
		const state = Object.freeze({ payload: '{{calc::1/0}}' });
		const renderer = new CBSRenderer({
			state,
			game: '{{state::missing}}',
			persona: { name: '{{char}}', description: '' }
		});
		expect(renderer.render('{{state::payload}}')).toBe('{{calc::1/0}}');
		expect(renderer.render('{{game}} {{user}}')).toBe('{{state::missing}} {{char}}');
		expect(renderer.render('x {{slot}} x', '{{calc::1/0}}')).toBe('x {{calc::1/0}} x');
		expect(render('{{unknown::{{calc::1/0}}}}')).toBe('{{unknown::{{calc::1/0}}}}');
		expect(render('{{state{{unknown}}::gold}}')).toBe('{{state{{unknown}}::gold}}');
		expect(render('{{char}} {{bot}} {{getvar::gold}} {{setvar::gold::1}}')).toBe(
			'{{char}} {{bot}} {{getvar::gold}} {{setvar::gold::1}}'
		);
		expect(render('{{slot}}')).toBe('{{slot}}');
		expect(state).toEqual({ payload: '{{calc::1/0}}' });
	});
	it('uses persona defaults and detects recursive authored references', () => {
		expect(renderCBS('{{user}}|{{persona}}|{{game}}', { state: {} })).toBe('플레이어||');
		expect(() =>
			renderCBS('{{description}}', {
				state: {},
				description: '{{authornote}}',
				authornote: '{{description}}'
			})
		).toThrow('순환 참조');
	});
	it('does not traverse prototypes or execute property getters', () => {
		expect(() => render('{{state::__proto__}}')).toThrow('조회 경로');
		expect(() => render('{{dictelement::{"a":1}::constructor}}')).toThrow('조회 경로');
		const state = Object.defineProperty({}, 'secret', {
			get() {
				throw Error('Getter executed');
			}
		});
		expect(renderCBS('{{state::secret}}', { state })).toBe('null');
	});
});

describe('CBS expressions', () => {
	it.each([
		['{{equal::01::1}}|{{not_equal::01::1}}', '0|1'],
		['{{greater::10::2}}|{{less::1::2}}|{{greater_equal::2::2}}|{{less_equal::3::2}}', '1|1|1|0'],
		['{{and::true::1}}|{{or::0::true}}|{{not::false}}', '1|1|1'],
		['{{trim::  x  }}|{{upper::Hello}}|{{LOWER::Hello}}', 'x|HELLO|hello'],
		['{{replace::banana::a::$&}}', 'b$&n$&n$&'],
		['{{contains::forest::ore}}|{{startswith::forest::for}}|{{endswith::forest::est}}', '1|1|1'],
		['{{length::한글}}|{{length::😀}}', '2|2'],
		['{{array::검::방패}}|{{makearray}}', '["검","방패"]|[]'],
		['{{join::{{split::검,방패::,}}:: / }}', '검 / 방패'],
		[
			'{{arraylength::{{state::items}}}}|{{arrayelement::["a","b"]::-1}}|{{arrayelement::[]::0}}',
			'2|b|null'
		],
		['{{objectelement::{"zero":0,"no":false}::zero}}|{{dictelement::{"no":false}::no}}', '0|false'],
		['{{dictelement::{"s":"::}}","nested":{"a":1}}::s}}', '::}}'],
		['{{join::["a",{"name":"b"}]::,}}', 'a,{"name":"b"}'],
		['{{br}}{{blank}}{{bo}}state{{bc}}{{cbr}}', '\n{{state}}\\n']
	])('evaluates expressions: %s', (source, expected) => {
		expect(render(source)).toBe(expected);
	});
	it.each([
		['{{calc::(2+3)*4}}', '20'],
		['{{? 2+3*4}}', '14'],
		['{{calc::{{state::gold}}*1.2}}', '43.199999999999996'],
		['{{floor::{{calc::46*1.2}}}}', '55'],
		['{{calc::2^3^2}}', '512'],
		['{{calc::-2^2}}', '-4'],
		['{{calc::(-2)^2}}', '4'],
		['{{calc::10%3}}', '1'],
		['{{calc::1e2+.5}}', '100.5'],
		['{{round::3.6}}|{{floor::3.6}}|{{ceil::3.1}}|{{abs::-3}}', '4|3|4|3']
	])('calculates without executing code: %s', (source, expected) => {
		expect(render(source)).toBe(expected);
	});
	it.each([
		'{{calc::1/0}}',
		'{{calc::globalThis.alert(1)}}',
		'{{calc::2(3)}}',
		'{{calc::(2+3}}',
		'{{calc::1e999}}',
		'{{greater::abc::1}}',
		'{{trim}}',
		'{{game::x}}',
		'{{split::a}}',
		'{{arraylength::not JSON}}',
		'{{arrayelement::{}::0}}',
		'{{arrayelement::[]::0.5}}'
	])('reports invalid expressions: %s', (source) => {
		expect(() => render(source)).toThrow('CBS:');
	});
});

describe('CBS blocks and limits', () => {
	it.each([
		['{{#when::{{state::phase}}::is::night_shop}}상점{{:else}}영업{{/when}}', '상점'],
		['{{#when {{state::enabled}}}}yes{{:else}}no{{/when}}', 'yes'],
		['{{#when::2}}yes{{:else}}no{{/when}}', 'no'],
		['{{#when::0}}bad {{calc::1/0}}{{:else}}good{{/when}}', 'good'],
		['{{#when::1}}good{{:else}}{{state::__proto__}}{{/when}}', 'good'],
		['{{#when::1}}{{#when::0}}bad{{:else}}nested{{/when}}{{/}}', 'nested'],
		['{{#when::not::0::and::2::>::1}}yes{{/when}}', 'yes'],
		['{{#when::0::or::1::and::0}}yes{{:else}}no{{/when}}', 'no'],
		['{{#when::1}}\n  indented\n{{/when}}', '  indented'],
		['{{#when::keep::1}}\n  indented\n{{/when}}', '\n  indented\n'],
		['{{#escape}} {{state::gold}} {{/escape}}', '{{state::gold}}'],
		['{{#escape::keep}} {{state::gold}} {{/escape}}', ' {{state::gold}} '],
		['{{#escape}}broken {{ syntax{{/escape}}', 'broken {{ syntax'],
		['{{replace::{{#escape}}a::b{{/escape}}::a::x}}', 'x::b']
	])('renders blocks: %s', (source, expected) => {
		expect(render(source)).toBe(expected);
	});
	it.each([
		'{{trim::x',
		'{{#when::1}}x',
		'{{:else}}',
		'{{/when}}',
		'{{#when::1}}x{{:else}}a{{:else}}b{{/when}}',
		'{{#escape}}x',
		'{{#escape::invalid}}x{{/escape}}',
		'{{#when::1::unknown::2}}x{{/when}}',
		'{{#each [1] as item}}x{{/each}}'
	])('reports malformed or unsupported blocks: %s', (source) => {
		expect(() => render(source)).toThrow('CBS:');
	});
	it('bounds nesting, parsing, JSON collections and expanding replacements', () => {
		expect(() => render('x'.repeat(CBS_LIMITS.source + 1))).toThrow('입력 크기');
		expect(() => render('{{trim::'.repeat(40) + 'x' + '}}'.repeat(40))).toThrow('중첩');
		expect(() => render('{{blank}}'.repeat(11000))).toThrow('식 개수');
		expect(() => render(`{{replace::${'a'.repeat(3000)}::a::${'b'.repeat(1000)}}}`)).toThrow(
			'출력 크기'
		);
		expect(() => render(`{{arraylength::${JSON.stringify(Array(10001).fill(0))}}}`)).toThrow(
			'항목 수'
		);
		expect(JSON.parse(render(`{{makearray::${Array(256).fill('x').join('::')}}}`))).toHaveLength(
			256
		);
		expect(() => render(`{{makearray::${Array(257).fill('x').join('::')}}}`)).toThrow('인자 개수');
	});
	it('trims long runs of blank lines without scanning their suffixes repeatedly', () => {
		expect(render(`{{#when::1}}${' \n'.repeat(15000)}text{{/when}}`)).toBe('text');
	});
});
