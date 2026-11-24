import { expect, it } from 'vitest';

import { matchesMigrationRange, parseMigrationRange } from './range.js';

it.each([
	[undefined, '1.0.0', true],
	['<2.0.0', '2.0.0', false],
	['>=1.0.0 <2.0.0', '1.9.0', true],
	['<2.0.0', '2.0.0-beta.1', true],
	['=1.0.0+a', '1.0.0+b', true],
	['>1.0.0', '1.0.1', true],
	['<=1.0.0', '1.0.0', true],
	['>=1.0.0', '1.0.0-beta.1', false]
] as const)('matches %s against %s', (range, version, expected) => {
	expect(matchesMigrationRange(range, version)).toBe(expected);
});
it.each([
	'',
	'^1.0.0',
	'~1.0.0',
	'1.0.0',
	'>=1.0',
	'<2.x',
	'>=1.0.0 || <2.0.0',
	'< 2.0.0',
	' <2.0.0',
	'<2.0.0\n',
	Array(9).fill('>=1.0.0').join(' ')
])('rejects unsupported range %s', (range) => {
	expect(() => parseMigrationRange(range)).toThrow();
});
