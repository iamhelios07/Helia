import type { MigrationDefinition } from './rules.js';

import { MigrationFailure } from '../migration/failure.js';
import { SANDBOX_LIMITS } from './protocol.js';

export interface CompiledMigrationScript {
	id: string;
	source: string;
}
export interface MigrationInvocation {
	name: string;
	scriptId: string;
	previous: string;
	previousSchema: string;
	migrated: string;
	from: string;
}
export interface MigrationWorkerRequest {
	compiled: CompiledMigrationScript[];
	runs?: MigrationInvocation[];
}
export type MigrationWorkerResult =
	| { kind: 'catalog'; migrations: MigrationDefinition[] }
	| { kind: 'state'; index: number; value: unknown };
export function migrationText(text: string): string {
	if (
		text.length > SANDBOX_LIMITS.wireBytes ||
		new TextEncoder().encode(text).length > SANDBOX_LIMITS.wireBytes
	) {
		throw new MigrationFailure('limit');
	}
	return text;
}
export function checkCompiled(compiled: CompiledMigrationScript[]): void {
	if (!Array.isArray(compiled) || compiled.length > SANDBOX_LIMITS.scriptCount) {
		throw new MigrationFailure('limit');
	}
	let size = 0;
	for (const script of compiled) {
		if (
			typeof script.id !== 'string' ||
			!script.id ||
			script.id.length > 128 ||
			typeof script.source !== 'string'
		) {
			throw new MigrationFailure('registration');
		}
		size += new TextEncoder().encode(script.source).length;
	}
	if (size > SANDBOX_LIMITS.sourceBytes) {
		throw new MigrationFailure('limit');
	}
}
