import { expect, it } from 'vitest';

import { validateGameReleaseContent } from '../versioning-validation.js';
import {
	checkContentComplexity,
	checkPackageSize,
	CONTENT_CHARACTER_LIMIT,
	CONTENT_NODE_LIMIT,
	PACKAGE_LIMITS,
	parsePackageJson,
	serializedRequestSize,
	serializePackageJson
} from './limits.js';

it.each(Object.entries(PACKAGE_LIMITS))(
	'accepts exactly the %s limit and rejects one more',
	(_name, maximum) => {
		expect(() => checkPackageSize(maximum, maximum)).not.toThrow();
		expect(() => checkPackageSize(maximum + 1, maximum)).toThrow();
	}
);

it.each([-1, 0.5, NaN, Infinity])('rejects invalid size %s', (size) => {
	expect(() => checkPackageSize(size)).toThrow();
});

it('measures actual JSON bytes including escapes, Unicode, surrogate pairs and keys', () => {
	for (const value of ['\0', '한', '🌌', '\ud800', { ['한'.repeat(100)]: '\0' }]) {
		expect(serializedRequestSize(value)).toBe(
			new TextEncoder().encode(JSON.stringify(value)).length
		);
	}
	expect(serializedRequestSize('\0')).toBe(8);
	expect(serializedRequestSize('🌌')).toBe(6);
});

it('sorts integer-looking and Unicode keys by UTF-16, without changing arrays or numbers', () => {
	const input = JSON.parse('{"2":2,"10":10,"😀":1,"":2,"__proto__":null,"array":[2,1],"zero":-0}');
	expect(serializePackageJson(input)).toBe(
		'{"10":10,"2":2,"__proto__":null,"array":[2,1],"zero":0,"😀":1,"":2}'
	);
});

it.each([
	new Uint8Array([0xef, 0xbb, 0xbf, 123, 125]),
	new Uint8Array([0x22, 0xc0, 0xaf, 0x22]),
	new Uint8Array([0x22, 0xed, 0xa0, 0x80, 0x22])
])('rejects BOM and malformed UTF-8', (bytes) => {
	expect(() => parsePackageJson(bytes)).toThrow();
});

const jsonText = (text: string) => new TextEncoder().encode(text);

// An array of N nulls has N separators/openers outside strings.
const nullArray = (length: number) => jsonText('[' + 'null,'.repeat(length - 1) + 'null]');

it('accepts the doubled raw node budget and rejects one more before parsing', () => {
	expect(() => checkContentComplexity(nullArray(2 * CONTENT_NODE_LIMIT))).not.toThrow();
	expect(() => checkContentComplexity(nullArray(2 * CONTENT_NODE_LIMIT + 1))).toThrow(
		expect.objectContaining({ code: 'content' })
	);
});

it('does not count separators or openers inside strings, including escaped quotes', () => {
	const insideValue = JSON.stringify('",[{'.repeat(CONTENT_NODE_LIMIT));
	expect(() => checkContentComplexity(jsonText(insideValue))).not.toThrow();
	// A backslash-escaped quote keeps the following separators inside the string.
	const escaped = '"\\",[{"';
	expect(() => checkContentComplexity(jsonText(escaped))).not.toThrow();
});

it('pins the shared node and character budgets to versioning-validation behavior', () => {
	expect(CONTENT_NODE_LIMIT).toBe(100000);
	expect(CONTENT_CHARACTER_LIMIT).toBe(16 * 1024 * 1024);
	expect(() =>
		validateGameReleaseContent(Array.from({ length: CONTENT_NODE_LIMIT - 1 }, () => null))
	).not.toThrow();
	expect(() =>
		validateGameReleaseContent(Array.from({ length: CONTENT_NODE_LIMIT }, () => null))
	).toThrow();
	expect(() => validateGameReleaseContent('x'.repeat(CONTENT_CHARACTER_LIMIT))).not.toThrow();
	expect(() => validateGameReleaseContent('x'.repeat(CONTENT_CHARACTER_LIMIT + 1))).toThrow();
});
