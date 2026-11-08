import type { Message } from '#lib/games/model.js';
import type { SessionHistory } from '#lib/games/state/model.js';

import { stateAt, type CommitTransaction } from '#lib/games/state/engine.js';

import {
	CreatorRuntimeError,
	parseResult,
	SANDBOX_LIMITS,
	type ActionRequest,
	type ActionRunner,
	type CreatorFailureCode,
	type RuleTrigger,
	type RunOptions,
	type UIEvent
} from './protocol.js';

export interface HookOutcome {
	name: string;
	status: 'committed' | 'failed' | 'skipped';
	transactionId?: string;
	code?: CreatorFailureCode;
	ruleId?: string | null;
	scriptId?: string | null;
	reason?: string | null;
}
export interface ExecutionReport {
	rootTransactionId: string;
	independent: HookOutcome[];
	deliveryFailures: number;
}
export type SessionExecution = SessionHistory & { execution: ExecutionReport };
type CommitInput = CommitTransaction & { message?: Pick<Message, 'role' | 'content'> };
export interface ExecutionPort {
	read(): Promise<SessionHistory>;
	commit(input: CommitInput, snapshotId: string): Promise<SessionHistory>;
	run: ActionRunner;
	publish(transactionId: string, events: UIEvent[]): number;
}

/** Only this coordinator can schedule independent work, and only after its trigger is committed. */
export async function executeSessionWork(
	history: SessionHistory,
	input: Omit<CommitInput, 'nextState'> & { operation?: ActionRequest['operation'] },
	port: ExecutionPort,
	options: RunOptions = {}
): Promise<SessionExecution> {
	const snapshot = history.snapshot;
	const before = stateAt(history, input.parentId);
	checkCanceled(options);
	const result = parseResult(
		await port.run(
			{
				scripts: snapshot.scripts,
				schema: snapshot.schema,
				state: before,
				action: input.action,
				...(input.operation ? { operation: input.operation } : {})
			},
			options
		),
		snapshot.schema
	);
	checkCanceled(options);
	let current = await port.commit(
		{
			...input,
			nextState: result.state,
			...(input.description === undefined && result.description
				? { description: result.description }
				: {})
		},
		snapshot.id
	);
	const rootTransactionId = current.progress.headId!;
	const report: ExecutionReport = {
		rootTransactionId,
		independent: [],
		deliveryFailures: port.publish(rootTransactionId, result.events ?? [])
	};

	const queue: Job[] = (result.independentHooks ?? []).map((name) => ({
		name,
		trigger: { before, after: result.state, action: input.action },
		ancestors: []
	}));
	const context: IndependentContext = { current, snapshot, port, options, report, queue };
	await drainIndependent(context);
	current = context.current;
	return { ...current, execution: report };
}
interface Job {
	name: string;
	trigger: RuleTrigger;
	ancestors: string[];
}
interface IndependentContext {
	current: SessionHistory;
	snapshot: SessionHistory['snapshot'];
	port: ExecutionPort;
	options: RunOptions;
	report: ExecutionReport;
	queue: Job[];
}
function checkCanceled(options: RunOptions) {
	if (options.signal?.aborted) {
		throw new CreatorRuntimeError('canceled');
	}
}
async function executeHook(context: IndependentContext, job: Job) {
	const { snapshot, port, options, report, queue } = context;
	checkCanceled(options);
	if (job.ancestors.includes(job.name)) {
		throw new CreatorRuntimeError('reentry', null, job.name);
	}
	const latest = await port.read();
	if (
		latest.progress.revision !== context.current.progress.revision ||
		latest.progress.headId !== context.current.progress.headId ||
		latest.snapshot.id !== snapshot.id
	) {
		throw new CreatorRuntimeError('conflict');
	}
	const action = { name: `hook:${job.name}`, args: {} };
	const next = parseResult(
		await port.run(
			{
				scripts: snapshot.scripts,
				schema: snapshot.schema,
				state: latest.progress.state,
				action,
				operation: { kind: 'hook', name: job.name, trigger: job.trigger }
			},
			options
		),
		snapshot.schema
	);
	checkCanceled(options);
	context.current = await port.commit(
		{
			expectedRevision: latest.progress.revision,
			parentId: latest.progress.headId,
			nextState: next.state,
			action,
			...(next.description ? { description: next.description } : {})
		},
		snapshot.id
	);
	report.deliveryFailures += port.publish(context.current.progress.headId!, next.events ?? []);
	report.independent.push({
		name: job.name,
		status: 'committed',
		transactionId: context.current.progress.headId!
	});
	for (const name of next.independentHooks ?? []) {
		queue.push({
			name,
			trigger: { before: latest.progress.state, after: next.state, action },
			ancestors: [...job.ancestors, job.name]
		});
	}
}
async function handleHookFailure(
	context: IndependentContext,
	job: Job,
	error: unknown
): Promise<boolean> {
	const { port, report, queue } = context;
	const failure = error instanceof CreatorRuntimeError ? error : new CreatorRuntimeError('storage');
	report.independent.push({
		name: job.name,
		status: 'failed',
		code: failure.code,
		ruleId: failure.ruleId,
		scriptId: failure.scriptId,
		reason: failure.reason
	});
	if (failure.code === 'canceled' || failure.code === 'conflict') {
		if (failure.code === 'conflict') {
			try {
				context.current = await port.read();
			} catch {
				/* The session may have been deleted; do not misreport an already committed root as failed. */
			}
		}
		for (const pending of queue) {
			report.independent.push({ name: pending.name, status: 'skipped', code: failure.code });
		}
		return true;
	}

	return false;
}
async function executeIndependent(context: IndependentContext, job: Job): Promise<boolean> {
	try {
		await executeHook(context, job);
		return false;
	} catch (error) {
		return handleHookFailure(context, job, error);
	}
}
async function drainIndependent(context: IndependentContext) {
	const { queue, report } = context;
	let count = 0;
	while (queue.length) {
		const job = queue.shift()!;
		if (++count > SANDBOX_LIMITS.independentCount) {
			for (const pending of [job, ...queue]) {
				report.independent.push({ name: pending.name, status: 'skipped', code: 'chain-limit' });
			}
			break;
		}
		if (await executeIndependent(context, job)) {
			break;
		}
	}
}
