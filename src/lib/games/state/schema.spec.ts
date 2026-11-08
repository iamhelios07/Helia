import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import fixtures from './schema-fixtures.json';
import {
	generateStateTypes,
	parseSchema,
	parseStateDocument,
	StateValidationError,
	validateValue
} from './schema.js';

describe('state schema profile', () => {
	it.each(fixtures)('$name (same fixtures as the native validator)', (fixture) => {
		if (fixture.schemaValid === false) {
			expect(() => parseSchema(fixture.schema)).toThrow(StateValidationError);
			return;
		}
		expect(parseSchema(fixture.schema)).toEqual(fixture.schema);
		for (const value of fixture.valid ?? []) {
			expect(validateValue(fixture.schema, value, 'load')).toEqual(value);
		}
		for (const value of fixture.invalid ?? []) {
			expect(() => validateValue(fixture.schema, value, 'load')).toThrow(StateValidationError);
		}
	});
});

describe('state schema profile', () => {
	it('reports the validation phase and nested array path without changing the input', () => {
		const schema = {
			type: 'object',
			properties: { items: fixtures[2].schema },
			additionalProperties: false
		};
		const value = { items: [{ id: 'sword', amount: 'two' }] };
		try {
			validateValue(schema, value, 'arguments');
			expect.unreachable();
		} catch (error) {
			expect(error).toMatchObject({
				phase: 'arguments',
				path: ['items', 0, 'amount'],
				code: 'expected-integer'
			});
		}
		expect(value.items[0].amount).toBe('two');
	});
});

describe('state schema profile', () => {
	it('validates initial state, returns detached data and rejects invalid documents', () => {
		const input = { schema: fixtures[0].schema, initialState: { hp: 100 } };
		const parsed = parseStateDocument(input);
		input.initialState.hp = 0;
		expect(parsed.initialState.hp).toBe(100);
		expect(() => parseStateDocument({ ...input, initialState: { hp: '100' } })).toThrow(/initial/);
		expect(() => parseStateDocument({ ...input, extra: true })).toThrow();
		expect(() => parseStateDocument({ schema: { type: 'string' }, initialState: 'x' })).toThrow(
			/root/
		);
	});
});

describe('state schema profile', () => {
	it('rejects unsupported or unsafe JavaScript values without evaluating accessors', () => {
		let calls = 0;
		const getter = Object.defineProperty({}, 'type', {
			enumerable: true,
			get() {
				calls++;
				return 'number';
			}
		});
		expect(() => parseSchema(getter)).toThrow();
		expect(calls).toBe(0);
		for (const value of [undefined, NaN, Infinity, 1n, new Date(), new Array(2)]) {
			expect(() => validateValue({ type: 'number' }, value, 'commit')).toThrow();
		}
	});
});

describe('state schema profile', () => {
	it('generates type-checked declarations preserving optional, enum, array and nullable semantics', () => {
		const schema = {
			type: 'object',
			properties: {
				target: { type: ['string', 'null'] },
				mode: { type: 'string', enum: ['idle', 'combat'] },
				inventory: fixtures[2].schema
			},
			required: ['target', 'mode', 'inventory'],
			additionalProperties: false
		};
		const declaration = generateStateTypes(schema);
		expect(declaration).toContain('"target": string | null');
		expect(declaration).toContain('"mode": "idle" | "combat"');
		expect(declaration).toContain('Array<');
		expect(generateStateTypes(fixtures[0].schema)).toContain('"hp": number');
		expect(
			generateStateTypes({
				type: 'object',
				properties: { note: { type: 'string' } },
				additionalProperties: false
			})
		).toContain('"note"?: string');
		const programSource =
			declaration +
			'\nconst good: GameState = {target:null,mode:"idle",inventory:[]};\n// @ts-expect-error invalid enum\nconst bad: GameState = {target:null,mode:"invalid",inventory:[]};';
		const options: ts.CompilerOptions = {
			strict: true,
			noEmit: true,
			target: ts.ScriptTarget.ESNext,
			types: []
		};
		const host = ts.createCompilerHost(options);
		const original = host.getSourceFile.bind(host);
		host.getSourceFile = (name, language, ...rest) =>
			name === 'generated.ts'
				? ts.createSourceFile(name, programSource, language, true)
				: original(name, language, ...rest);
		const program = ts.createProgram(['generated.ts'], options, host);
		expect(
			ts
				.getPreEmitDiagnostics(program)
				.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
		).toEqual([]);
	});
});
