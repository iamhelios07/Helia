import { expect, it } from 'vitest';

import fixtures from '#lib/storage/fixtures/edit-lock.json';

import {
	allowsEditOperation,
	parseEditLock,
	INVALID_EDIT_LOCK,
	type EditOperation
} from './edit-lock.js';

it.each(fixtures.values)('validates shared lock value: $name', ({ value, valid }) => {
	if (valid) {
		expect(parseEditLock(value)).toBe(value);
	} else {
		expect(() => parseEditLock(value)).toThrow(INVALID_EDIT_LOCK);
	}
});

it.each(fixtures.operations)(
	'preserves upgrade permission: $operation',
	({ operation, allowedWhenLocked }) => {
		expect(allowsEditOperation(true, operation as EditOperation)).toBe(allowedWhenLocked);
		expect(allowsEditOperation(false, operation as EditOperation)).toBe(true);
		expect(allowsEditOperation(undefined, operation as EditOperation)).toBe(true);
	}
);
