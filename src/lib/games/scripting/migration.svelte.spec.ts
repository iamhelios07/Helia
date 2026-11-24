import { expect, it } from 'vitest';

import scriptingDocs from '../../../../docs/scripting.md?raw';
import { compileCodeProject, type CodeProject } from '../code-project.js';
import { MigrationBudget } from '../migration/budget.js';
import { migrationStates } from '../migration/inputs.js';
import { planMigration } from '../migration/plan.js';
import {
	createMigrationMemo,
	disposeMigrationMemo,
	migrationResolver,
	precomputeMigrations
} from '../migration/precompute.js';
import { binding, migrationGame, migrationSource } from '../migration/test-fixtures.js';
import { parseGameSnapshot } from '../state/model.js';
import { tryWorkerSlot } from './worker-slots.js';

it('runs planning and batches through real migration Workers and reports unique-input progress', async () => {
	const game = migrationGame();
	const work = new MigrationBudget();
	const source = migrationSource([12, 12], new Map(), ['b', 'a']);
	const context = {
		game,
		schemaOf: (id: string) => parseGameSnapshot(source.unit.get('snapshots', id)).schema
	};
	const progress: { done: number; total: number }[] = [];
	const memo = createMigrationMemo(await planMigration(game, binding, { budget: work }), work, {
		scope: 'all'
	});
	try {
		await precomputeMigrations(memo, source, context, {
			onProgress: (value) => progress.push(value)
		});
		expect([...migrationStates(source)].map(migrationResolver(memo, context))).toEqual(
			Array(8)
				.fill({ coins: 12 })
				.map((state, index) => (index % 4 === 0 ? { coins: 10 } : state))
		);
		expect(progress.at(-1)).toEqual({ done: 2, total: 2 });
	} finally {
		disposeMigrationMemo(memo);
		work.dispose();
	}
	expect(work.usage).toEqual({ bytes: 0, entries: 0 });
});
it('waits for shared Action slots, cancels queued work and enforces deadlines while waiting', async () => {
	const slots = Array.from({ length: 4 }, () => tryWorkerSlot()!);
	const abort = new AbortController();
	const canceled = new MigrationBudget(undefined, abort.signal);
	const expired = new MigrationBudget({ entries: 10, bytes: 1_000_000, deadlineMs: 30 });
	try {
		const task = planMigration(migrationGame(), binding, { budget: canceled });
		abort.abort();
		await expect(task).rejects.toMatchObject({ kind: 'canceled' });
		await expect(
			planMigration(migrationGame(), binding, { budget: expired })
		).rejects.toMatchObject({ kind: 'timeout' });
	} finally {
		slots.forEach((release) => release());
		canceled.dispose();
		expired.dispose();
	}
	expect(canceled.usage.bytes).toBe(0);
});

it('terminates active migration Workers on cancellation without leaving a partial memo', async () => {
	const game = migrationGame('while(true){}');
	const abort = new AbortController();
	const work = new MigrationBudget(undefined, abort.signal);
	const source = migrationSource();
	const context = {
		game,
		schemaOf: () => parseGameSnapshot(source.unit.get('snapshots', 'old')).schema
	};
	const memo = createMigrationMemo(await planMigration(game, binding, { budget: work }), work, {
		scope: 'all'
	});
	try {
		const running = precomputeMigrations(memo, source, context);
		setTimeout(() => abort.abort(), 30);
		await expect(running).rejects.toMatchObject({ kind: 'canceled' });
		expect(memo.entries.size).toBe(0);
		expect(work.usage).toEqual({ entries: 0, bytes: 0 });
	} finally {
		disposeMigrationMemo(memo);
		work.dispose();
	}
});
it('registers only reachable logic modules, including the documented migration declaration', async () => {
	const declaration = scriptingDocs
		.split('## Save migrations')[1]
		.split('```ts')[1]
		.split('```')[0];
	const project: CodeProject = {
		version: 1,
		entry: 'main.ts',
		files: {
			'main.ts': { language: 'typescript', source: 'import "./migration"; import "./panel";' },
			'migration.ts': { language: 'typescript', source: declaration },
			'panel.tsx': { language: 'tsx', source: `'use ui'; export const panel = 1;` },
			'unused.ts': {
				language: 'typescript',
				source: declaration.replace('gold-to-coins', 'unused')
			}
		}
	};
	const game = migrationGame();
	const work = new MigrationBudget();
	try {
		const projectScripts = (await compileCodeProject(project, game.schema)).scripts;
		for (const scripts of [
			{ legacy: { language: 'typescript', source: declaration } },
			projectScripts
		]) {
			game.scripts = scripts;
			const plan = await planMigration(game, binding, { budget: work });
			expect(plan.migration?.name).toBe('gold-to-coins');
			const source = migrationSource([]);
			const context = {
				game,
				schemaOf: () => parseGameSnapshot(source.unit.get('snapshots', 'old')).schema
			};
			const memo = createMigrationMemo(plan, work, { scope: 'all' });
			try {
				await precomputeMigrations(memo, source, context);
				expect([...migrationStates(source)].map(migrationResolver(memo, context))).toEqual([
					{ coins: 10 },
					{ coins: 10 }
				]);
			} finally {
				disposeMigrationMemo(memo);
			}
		}
		project.files['main.ts'].source = 'import "./panel";';
		project.files['panel.tsx'].source = `'use ui'; ${declaration}`;
		game.scripts = (await compileCodeProject(project, game.schema)).scripts;
		expect((await planMigration(game, binding, { budget: work })).migration).toBeNull();
	} finally {
		work.dispose();
	}
}, 20_000);
