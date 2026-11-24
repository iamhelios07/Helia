import type { Game } from '../model.js';
import type { MigrationInvocation } from '../scripting/migration-protocol.js';
import type { MigrationSource } from '../state/baseline.js';
import type { ObjectSchema } from '../state/schema.js';
import type { GameState } from '../state/value.js';
import type { MigrationPlan } from './plan.js';

import { runMigrationWorker } from '../scripting/migration-runner.js';
import { SANDBOX_LIMITS } from '../scripting/protocol.js';
import { migrateState } from '../state/migration.js';
import { canonical } from '../state/model.js';
import { validateState } from '../state/schema.js';
import { MigrationBudget, MIGRATION_OBJECT_FACTOR, type Reservation } from './budget.js';
import { MigrationFailure } from './failure.js';
import {
	migrationStates,
	type MigrationLocation,
	type MigrationState,
	type StateResolver
} from './inputs.js';

export type MigrationScope = 'all' | 'baseline';
export interface MigrationContext {
	game: Game;
	schemaOf: (snapshotId: string) => ObjectSchema;
}
interface MemoEntry {
	location: MigrationLocation;
	text: string;
	result: string | null;
	reservations: Reservation[];
	locationReservation: Reservation;
	counted: boolean;
}
export interface MigrationMemo {
	readonly plan: MigrationPlan;
	readonly budget: MigrationBudget;
	readonly scope: MigrationScope;
	/** Internal storage; snapshot identity and exact canonical text form the key. */
	readonly entries: Map<string, Map<string, MemoEntry>>;
}
export function createMigrationMemo(
	plan: MigrationPlan,
	budget: MigrationBudget,
	options: { scope: MigrationScope }
): MigrationMemo {
	return Object.freeze({ plan, budget, scope: options.scope, entries: new Map() });
}
function releaseEntry(memo: MigrationMemo, entry: MemoEntry) {
	entry.locationReservation.dispose();
	for (const reservation of entry.reservations) {
		reservation.dispose();
	}
	if (entry.counted) {
		memo.budget.removeEntry();
	}
}
export function disposeMigrationMemo(memo: MigrationMemo): void {
	for (const bucket of memo.entries.values()) {
		for (const entry of bucket.values()) {
			releaseEntry(memo, entry);
		}
	}
	memo.entries.clear();
}
function eligible(memo: MigrationMemo, input: MigrationLocation) {
	return memo.scope === 'all' || input.origin === 'baseline';
}
function entryFor(memo: MigrationMemo, location: MigrationLocation, text: string): MemoEntry {
	const reservations: Reservation[] = [];
	try {
		reservations.push(memo.budget.reserve((text.length + location.sourceSnapshotId.length) * 2));
		const locationReservation = memo.budget.reserve(canonical(location).length * 2);
		return { location, text, result: null, reservations, locationReservation, counted: false };
	} catch (error) {
		reservations.forEach((reservation) => reservation.dispose());
		throw error;
	}
}
function remember(required: MigrationMemo['entries'], memo: MigrationMemo, input: MigrationState) {
	const text = canonical(input.state);
	const held = memo.budget.reserve(text.length * 2 * MIGRATION_OBJECT_FACTOR);
	try {
		if (!eligible(memo, input)) {
			return;
		}
		let bucket = required.get(input.sourceSnapshotId);
		if (!bucket) {
			bucket = new Map();
			required.set(input.sourceSnapshotId, bucket);
		}
		if (bucket.has(text)) {
			return;
		}
		const location: MigrationLocation = {
			sessionId: input.sessionId,
			role: input.role,
			sourceSnapshotId: input.sourceSnapshotId,
			origin: input.origin,
			...(input.transactionId === undefined ? {} : { transactionId: input.transactionId })
		};
		const existing = memo.entries.get(input.sourceSnapshotId)?.get(text);
		if (existing) {
			const reservation = memo.budget.reserve(canonical(location).length * 2);
			existing.locationReservation.dispose();
			existing.locationReservation = reservation;
			existing.location = location;
		}
		bucket.set(text, existing ?? entryFor(memo, location, text));
	} finally {
		held.dispose();
	}
}

async function collect(memo: MigrationMemo, source: MigrationSource) {
	const required: MigrationMemo['entries'] = new Map();
	const iterator = migrationStates(source)[Symbol.iterator]();
	let count = 0;
	let lastYield = performance.now();
	try {
		while (true) {
			memo.budget.checkpoint();
			let step: IteratorResult<MigrationState> | null = iterator.next();
			if (step.done) {
				break;
			}
			remember(required, memo, step.value);
			step = null;
			if (++count % 256 === 0 || performance.now() - lastYield >= 50) {
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
				memo.budget.checkpoint();
				lastYield = performance.now();
			}
		}
		return required;
	} catch (error) {
		releaseUncounted(memo, required);
		throw error;
	} finally {
		iterator.return?.();
	}
}
function prepareInvocation(
	memo: MigrationMemo,
	entry: MemoEntry,
	defaults: MigrationDefaults
): MigrationInvocation {
	const definition = memo.plan.migration!;
	const previousSchema = defaults.schemaText(entry.location.sourceSnapshotId);
	let migrated: GameState | null;
	try {
		migrated = defaults.migrate(entry.location.sourceSnapshotId, entry.text);
	} catch {
		migrated = null;
	}
	return {
		name: definition.name,
		scriptId: definition.scriptId,
		from: memo.plan.binding.fromVersion,
		previous: entry.text,
		previousSchema,
		migrated: canonical(migrated)
	};
}
/** Cache only canonical text; every migration receives fresh parsed objects. */
class MigrationDefaults {
	private readonly schema: string;
	private readonly initial: string;
	private readonly previousSchemas = new Map<string, string>();
	constructor(private context: MigrationContext) {
		this.schema = canonical(context.game.schema);
		this.initial = canonical(context.game.initialState);
	}
	schemaText(snapshotId: string): string {
		let text = this.previousSchemas.get(snapshotId);
		if (text === undefined) {
			text = canonical(this.context.schemaOf(snapshotId));
			this.previousSchemas.set(snapshotId, text);
		}
		return text;
	}
	migrate(snapshotId: string, text: string): GameState {
		return migrateState(
			JSON.parse(text),
			JSON.parse(this.schemaText(snapshotId)),
			JSON.parse(this.schema),
			JSON.parse(this.initial)
		);
	}
}
function storeResult(
	memo: MigrationMemo,
	entry: MemoEntry,
	context: MigrationContext,
	value: unknown
) {
	let text: string;
	try {
		text = canonical(validateState(context.game.schema, value, 'load'));
	} catch (error) {
		throw new MigrationFailure('schema', {
			location: entry.location,
			migration: memo.plan.migration!.name,
			scriptId: memo.plan.migration!.scriptId,
			validation: { schema: context.game.schema, error }
		});
	}
	entry.reservations.push(memo.budget.reserve(text.length * 2));
	entry.result = text;
}
interface Batch {
	runs: MigrationInvocation[];
	entries: MemoEntry[];
}
interface SizedInvocation {
	invocation: MigrationInvocation;
	bytes: number;
}
function utf8Bytes(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).length;
}
function atEntry(error: unknown, memo: MigrationMemo, entry: MemoEntry): MigrationFailure {
	if (error instanceof MigrationFailure && error.location) {
		return error;
	}
	return new MigrationFailure(error instanceof MigrationFailure ? error.kind : 'exception', {
		location: entry.location,
		migration: memo.plan.migration!.name,
		scriptId: memo.plan.migration!.scriptId
	});
}
class MigrationExecution {
	private cursor = 0;
	private done = 0;
	private firstFailure?: MigrationFailure;
	private readonly abort = new AbortController();
	private readonly signal: AbortSignal;
	private readonly defaults: MigrationDefaults;
	private readonly envelopeBytes: number;
	private nextInvocation?: SizedInvocation;
	constructor(
		private memo: MigrationMemo,
		private pending: MemoEntry[],
		private context: MigrationContext,
		private progress?: (p: { done: number; total: number }) => void
	) {
		this.signal = AbortSignal.any([memo.budget.signal, this.abort.signal]);
		this.defaults = new MigrationDefaults(context);
		this.envelopeBytes = utf8Bytes({ compiled: memo.plan.compiled, runs: [] });
	}
	async run() {
		this.progress?.({ done: 0, total: this.pending.length });
		await Promise.allSettled(
			Array.from({ length: Math.min(4, this.pending.length) }, () => this.lane())
		);
		if (this.firstFailure) {
			throw this.firstFailure;
		}
		this.memo.budget.checkpoint();
	}
	private async lane() {
		while (this.cursor < this.pending.length && !this.signal.aborted) {
			const entry = this.pending[this.cursor];
			try {
				const batch = this.nextBatch();
				await this.runBatch(batch);
			} catch (error) {
				this.firstFailure ??= atEntry(error, this.memo, entry);
				this.abort.abort();
				return;
			}
		}
	}
	private nextBatch(): Batch {
		const batch: Batch = { runs: [], entries: [] };
		let bytes = this.envelopeBytes;
		while (
			this.cursor < this.pending.length &&
			batch.runs.length < SANDBOX_LIMITS.migrationBatchSize
		) {
			this.memo.budget.checkpoint();
			const invocation =
				this.nextInvocation?.invocation ??
				prepareInvocation(this.memo, this.pending[this.cursor], this.defaults);
			const candidate = this.nextInvocation ?? { invocation, bytes: utf8Bytes(invocation) };
			const nextBytes = bytes + candidate.bytes + (batch.runs.length ? 1 : 0);
			if (nextBytes > SANDBOX_LIMITS.wireBytes) {
				if (!batch.runs.length) {
					throw new MigrationFailure('limit');
				}
				this.nextInvocation = candidate;
				break;
			}
			bytes = nextBytes;
			batch.runs.push(candidate.invocation);
			batch.entries.push(this.pending[this.cursor++]);
			this.nextInvocation = undefined;
		}
		return batch;
	}
	private async runBatch(batch: Batch) {
		let index = 0;
		try {
			await runMigrationWorker(
				{ compiled: this.memo.plan.compiled, runs: batch.runs },
				this.memo.budget,
				(result) => {
					if (result.kind !== 'state' || result.index !== index) {
						throw new MigrationFailure('missing');
					}
					storeResult(this.memo, batch.entries[index], this.context, result.value);
					index++;
					this.progress?.({ done: ++this.done, total: this.pending.length });
				},
				this.signal
			);
		} catch (error) {
			throw atEntry(error, this.memo, batch.entries[Math.min(index, batch.entries.length - 1)]);
		}
	}
}
function* entriesIn(entries: MigrationMemo['entries']) {
	for (const [id, bucket] of entries) {
		for (const [text, entry] of bucket) {
			yield { id, text, entry };
		}
	}
}
function releaseUncounted(memo: MigrationMemo, entries: MigrationMemo['entries']) {
	for (const { entry } of entriesIn(entries)) {
		if (!entry.counted) {
			releaseEntry(memo, entry);
		}
	}
}
function adoptRequired(memo: MigrationMemo, required: MigrationMemo['entries']) {
	for (const { id, text, entry } of entriesIn(memo.entries)) {
		if (!required.get(id)?.has(text)) {
			releaseEntry(memo, entry);
		}
	}
	memo.entries.clear();
	for (const [id, bucket] of required) {
		memo.entries.set(id, bucket);
	}
	const pending: MemoEntry[] = [];
	for (const { entry } of entriesIn(memo.entries)) {
		if (!entry.counted) {
			memo.budget.addEntry();
			entry.counted = true;
		}
		if (entry.result === null) {
			pending.push(entry);
		}
	}
	return pending;
}

export async function precomputeMigrations(
	memo: MigrationMemo,
	source: MigrationSource,
	context: MigrationContext,
	options: { onProgress?: (p: { done: number; total: number }) => void } = {}
): Promise<void> {
	if (!memo.plan.migration) {
		return;
	}
	// Enumeration failure keeps prior memo entries; execution failure below clears the adopted memo.
	const required = await collect(memo, source);
	try {
		const pending = adoptRequired(memo, required);
		await new MigrationExecution(memo, pending, context, options.onProgress).run();
	} catch (error) {
		disposeMigrationMemo(memo);
		throw error;
	}
}

export function defaultResolver(context: MigrationContext): StateResolver {
	const defaults = new MigrationDefaults(context);
	return (input) => {
		try {
			return defaults.migrate(input.sourceSnapshotId, canonical(input.state));
		} catch (error) {
			throw new MigrationFailure('default', {
				location: input,
				validation: { schema: context.game.schema, error }
			});
		}
	};
}
export function migrationResolver(memo: MigrationMemo, context: MigrationContext): StateResolver {
	const fallback = defaultResolver(context);
	return (input) => {
		memo.budget.checkpoint();
		if (!memo.plan.migration || !eligible(memo, input)) {
			const state = fallback(input);
			memo.budget.checkpoint();
			return state;
		}
		const entry = memo.entries.get(input.sourceSnapshotId)?.get(canonical(input.state));
		if (!entry?.result) {
			throw new MigrationFailure('missing', { location: input });
		}
		return validateState(context.game.schema, JSON.parse(entry.result), 'load');
	};
}

export type { StateResolver } from './inputs.js';
