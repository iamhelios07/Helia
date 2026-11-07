import { expect, it } from 'vitest';
import {
	editAuthoringSchema,
	initialValueFor,
	readAuthoringSource,
	type AuthoringDocument
} from './authoring.js';
import { parseObjectSchema, validateState } from './schema.js';

function fixture(): AuthoringDocument {
	return {
		schema: parseObjectSchema({
			type: 'object',
			properties: {
				party: {
					type: 'array',
					items: {
						type: 'object',
						properties: { hp: { type: 'integer' }, nickname: { type: ['string', 'null'] } },
						required: ['hp'],
						additionalProperties: false
					}
				}
			},
			required: ['party'],
			additionalProperties: false
		}),
		initialState: { party: [{ hp: 10, nickname: null }, { hp: 5 }] }
	};
}

it('renames nested array fields together with every present initial value without changing its input', () => {
	const before = fixture();
	const next = editAuthoringSchema(before, ['party', null], {
		kind: 'rename',
		name: 'hp',
		next: 'health'
	});
	expect(next.initialState).toEqual({ party: [{ health: 10, nickname: null }, { health: 5 }] });
	expect(validateState(next.schema, next.initialState, 'initial')).toEqual(next.initialState);
	expect(before.initialState.party).toEqual([{ hp: 10, nickname: null }, { hp: 5 }]);
});

it('keeps required presence independent of nullability and initializes only explicit new required values', () => {
	const next = editAuthoringSchema(fixture(), ['party', null], {
		kind: 'required',
		name: 'nickname',
		enabled: true
	});
	expect(next.initialState.party).toEqual([
		{ hp: 10, nickname: null },
		{ hp: 5, nickname: '' }
	]);
	expect(validateState(next.schema, next.initialState, 'initial')).toEqual(next.initialState);
	const optional = editAuthoringSchema(next, ['party', null], {
		kind: 'required',
		name: 'nickname',
		enabled: false
	});
	expect(optional.initialState).toEqual(next.initialState);
});

it('preserves missing fields, malformed JSON, and invalid typed values when reading external sources', () => {
	expect(readAuthoringSource('{unfinished').document).toBeNull();
	const invalid = readAuthoringSource(
		JSON.stringify({ ...fixture(), initialState: { party: [{ hp: '10' }] } })
	);
	expect(invalid.document?.initialState).toEqual({ party: [{ hp: '10' }] });
	expect(invalid.validationError).toContain('expected-integer');
	expect(readAuthoringSource(JSON.stringify(fixture())).document?.initialState).toEqual(
		fixture().initialState
	);
});

it('adds optional fields without fabricating values and deletes array fields atomically', () => {
	const added = editAuthoringSchema(fixture(), ['party', null], { kind: 'add', name: 'note' });
	expect(added.initialState).toEqual(fixture().initialState);
	const removed = editAuthoringSchema(added, ['party', null], { kind: 'remove', name: 'hp' });
	expect(removed.initialState.party).toEqual([{ nickname: null }, {}]);
	expect(validateState(removed.schema, removed.initialState, 'initial')).toEqual(
		removed.initialState
	);
});

it('replaces values only on an explicit type edit and preserves field metadata', () => {
	let document = editAuthoringSchema(fixture(), ['party', null, 'hp'], {
		kind: 'metadata',
		key: 'title',
		value: '체력'
	});
	document = editAuthoringSchema(document, ['party', null, 'hp'], { kind: 'type', type: 'array' });
	expect(document.initialState.party).toEqual([{ hp: [], nickname: null }, { hp: [] }]);
	expect(JSON.stringify(document.schema)).toContain('체력');
	expect(validateState(document.schema, document.initialState, 'initial')).toEqual(
		document.initialState
	);
});

it('validates enum edits without silently replacing old values and uses explicit enum choices for new values', () => {
	const document = editAuthoringSchema(fixture(), ['party', null, 'hp'], {
		kind: 'enum',
		values: [1, 2]
	});
	expect(document.initialState).toEqual(fixture().initialState);
	expect(() => validateState(document.schema, document.initialState, 'initial')).toThrow('enum');
	expect(initialValueFor({ type: 'array', items: { type: 'string' }, enum: [['first']] })).toEqual([
		'first'
	]);
	expect(() =>
		editAuthoringSchema(fixture(), ['party', null, 'hp'], { kind: 'enum', values: ['wrong'] })
	).toThrow('expected-integer');
});

it('rejects unsafe and colliding field names without modifying the original', () => {
	const before = fixture();
	expect(() => editAuthoringSchema(before, [], { kind: 'add', name: '__proto__' })).toThrow();
	expect(() =>
		editAuthoringSchema(before, ['party', null], { kind: 'rename', name: 'hp', next: 'nickname' })
	).toThrow();
	expect(before).toEqual(fixture());
});
