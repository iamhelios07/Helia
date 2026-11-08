import type { StateChange, StateSlot } from './model.js';

import {
	parseGameState,
	parseStateValue,
	isStateObject,
	sameValue,
	validateStateKey,
	type GameState
} from './value.js';

function slot(state: GameState, key: string): StateSlot {
	return Object.hasOwn(state, key) ? { exists: true, value: state[key] } : { exists: false };
}
function sameSlot(first: StateSlot, second: StateSlot): boolean {
	return (
		first.exists === second.exists &&
		(!first.exists || (second.exists && sameValue(first.value, second.value)))
	);
}

/** Arrays are recorded as values; insertion/removal cannot invalidate later index paths. */
export function diffState(
	before: GameState,
	after: GameState,
	prefix: string[] = []
): StateChange[] {
	const result: StateChange[] = [];
	for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
		const old = slot(before, key);
		const next = slot(after, key);
		if (sameSlot(old, next)) {
			continue;
		}
		const path = [...prefix, key];
		if (old.exists && next.exists && isStateObject(old.value) && isStateObject(next.value)) {
			result.push(...diffState(old.value, next.value, path));
		} else {
			result.push({ path, before: old, after: next });
		}
	}
	return result;
}

export function applyChanges(state: GameState, changes: readonly StateChange[]): GameState {
	const next = parseGameState(state);
	for (const change of changes) {
		if (!change.path.length) {
			throw new Error('상태 변경 경로가 올바르지 않아요.');
		}
		change.path.forEach(validateStateKey);
		const parent = changeParent(next, change.path);
		const key = change.path.at(-1)!;
		if (!sameSlot(slot(parent, key), change.before)) {
			throw new Error('상태 변경 전 값이 기록과 일치하지 않아요.');
		}
		if (change.after.exists) {
			parent[key] = parseStateValue(change.after.value);
		} else {
			delete parent[key];
		}
	}
	return next;
}

function changeParent(next: GameState, path: string[]): GameState {
	let parent = next;
	for (const key of path.slice(0, -1)) {
		if (!Object.hasOwn(parent, key) || !isStateObject(parent[key])) {
			throw new Error('상태 변경 경로를 복원할 수 없어요.');
		}
		parent = parent[key] as GameState;
	}
	return parent;
}
