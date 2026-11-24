import { DefaultMigrationError } from '../state/migration.js';
import { StateValidationError, type ObjectSchema, type ValueSchema } from '../state/schema.js';

export const MIGRATION_FAILURE_KINDS = [
	'exception',
	'timeout',
	'memory',
	'nonJson',
	'schema',
	'default',
	'registration',
	'ambiguous',
	'limit',
	'missing',
	'canceled',
	'unavailable'
] as const;
export type MigrationFailureKind = (typeof MIGRATION_FAILURE_KINDS)[number];
export interface FailureLocation {
	sessionId: string;
	role: 'initial' | 'checkpoint' | 'current';
	transactionId?: string;
}
interface FailureDetails {
	location?: FailureLocation | null;
	migration?: string | null;
	scriptId?: string | null;
	validation?: { schema: ObjectSchema; error: unknown };
}
const CODES = new Set([
	'invalid-json',
	'expected-object',
	'expected-array',
	'expected-string',
	'expected-number',
	'expected-integer',
	'expected-boolean',
	'expected-null',
	'additional-property',
	'required',
	'enum',
	'missing-initial',
	'invalid-type',
	'invalid-value',
	'type',
	'invalid'
]);
function defaultMessage(
	error: StateValidationError,
	path: readonly (string | number)[],
	code: string
): string {
	if (error instanceof DefaultMigrationError) {
		return error.prefix + path.join('.');
	}
	return `${error.phase}: ${JSON.stringify(path)} — ${code}`;
}
/** Only trusted schema keys survive; state-derived additional-property names never escape. */
export function safeSchemaPath(schema: ObjectSchema, path: readonly (string | number)[]) {
	const result: (string | number)[] = [];
	let node: ValueSchema = schema;
	for (const part of path.slice(0, 32)) {
		if ('properties' in node && typeof part === 'string' && Object.hasOwn(node.properties, part)) {
			result.push(part.slice(0, 128));
			node = node.properties[part];
		} else if (
			'items' in node &&
			typeof part === 'number' &&
			Number.isSafeInteger(part) &&
			part >= 0
		) {
			result.push(part);
			node = node.items;
		} else {
			return [...result, '<unknown>'];
		}
	}
	return path.length > 32 ? [...result, '…'] : result;
}
export class MigrationFailure extends Error {
	readonly location: FailureLocation | null;
	readonly migration: string | null;
	readonly scriptId: string | null;
	readonly schemaPath: readonly (string | number)[] | null;
	readonly schemaCode: string | null;
	constructor(
		readonly kind: MigrationFailureKind,
		details: FailureDetails = {}
	) {
		super(`migration: ${kind}`);
		this.name = 'MigrationFailure';
		const location = details.location;
		this.location = location
			? {
					sessionId: location.sessionId,
					role: location.role,
					...(location.transactionId === undefined ? {} : { transactionId: location.transactionId })
				}
			: null;
		this.migration = details.migration ?? null;
		this.scriptId = details.scriptId ?? null;
		const validation = details.validation;
		const error = validation?.error;
		this.schemaPath =
			validation && error instanceof StateValidationError
				? safeSchemaPath(validation.schema, error.path)
				: null;
		this.schemaCode = null;
		if (error instanceof StateValidationError) {
			this.schemaCode = CODES.has(error.code) ? error.code : 'invalid';
		}
		if (kind === 'default' && error instanceof StateValidationError) {
			this.message = defaultMessage(error, this.schemaPath ?? [], this.schemaCode ?? 'invalid');
		}
	}
}
