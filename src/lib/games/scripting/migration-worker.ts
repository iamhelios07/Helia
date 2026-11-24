import { MigrationFailure } from '../migration/failure.js';
import { evaluateMigration } from './migration-engine.js';
import { migrationText, type MigrationWorkerRequest } from './migration-protocol.js';

const scope = globalThis as unknown as {
	postMessage(value: string): void;
	onmessage: (event: MessageEvent<unknown>) => Promise<void>;
};
scope.onmessage = async (event: MessageEvent<unknown>) => {
	try {
		if (typeof event.data !== 'string') {
			throw new MigrationFailure('unavailable');
		}
		const request = JSON.parse(migrationText(event.data)) as MigrationWorkerRequest;
		if (!request.runs) {
			scope.postMessage(
				migrationText(
					JSON.stringify({ ok: true, result: await evaluateMigration(request.compiled) })
				)
			);
			return;
		}
		for (const [index, input] of request.runs.entries()) {
			const result = await evaluateMigration(request.compiled, input);
			scope.postMessage(migrationText(JSON.stringify({ ok: true, result: { ...result, index } })));
		}
	} catch (error) {
		const failure = error instanceof MigrationFailure ? error : new MigrationFailure('exception');
		scope.postMessage(
			JSON.stringify({
				ok: false,
				kind: failure.kind,
				scriptId: failure.scriptId,
				migration: failure.migration
			})
		);
	}
};
