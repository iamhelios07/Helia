import type { Game } from '../model.js';
import type { CompiledMigrationScript } from '../scripting/migration-protocol.js';
import type { MigrationDefinition } from '../scripting/rules.js';
import type { MigrationBudget } from './budget.js';

import { runtimeScripts } from '../runtime-content.js';
import { checkCompiled } from '../scripting/migration-protocol.js';
import { runMigrationWorker } from '../scripting/migration-runner.js';
import { compileScripts } from '../scripting/script-build.js';
import { parseSemVer } from '../semver.js';
import { MigrationFailure } from './failure.js';
import { matchesMigrationRange } from './range.js';

export interface MigrationBinding {
	contentHash: string;
	targetReleaseId: string;
	fromVersion: string;
}
export interface MigrationPlan {
	readonly binding: Readonly<MigrationBinding>;
	readonly migration: Readonly<MigrationDefinition> | null;
	readonly compiled: CompiledMigrationScript[];
}
export async function planMigration(
	game: Game,
	binding: MigrationBinding,
	{ budget }: { budget: MigrationBudget }
): Promise<MigrationPlan> {
	budget.checkpoint();
	parseSemVer(binding.fromVersion);
	let compiled: CompiledMigrationScript[] = [];
	let migrations: MigrationDefinition[] = [];
	try {
		if (Object.keys(game.scripts).length) {
			const scripts = await runtimeScripts(game.scripts, game.id, budget.signal);
			budget.checkpoint();
			compiled = await compileScripts({ scripts, schema: game.schema });
			budget.checkpoint();
			checkCompiled(compiled);
			if (compiled.length) {
				await runMigrationWorker({ compiled }, budget, (result) => {
					if (result.kind !== 'catalog') {
						throw new MigrationFailure('registration');
					}
					migrations = result.migrations;
				});
			}
		}
		const matching = migrations.filter((row) =>
			matchesMigrationRange(row.from, binding.fromVersion)
		);
		if (matching.length > 1) {
			throw new MigrationFailure('ambiguous');
		}
		return Object.freeze({
			binding: Object.freeze({ ...binding }),
			migration: matching[0] ? Object.freeze({ ...matching[0] }) : null,
			compiled
		});
	} catch (error) {
		budget.checkpoint();
		if (error instanceof MigrationFailure) {
			throw error;
		}
		throw new MigrationFailure('registration');
	}
}
