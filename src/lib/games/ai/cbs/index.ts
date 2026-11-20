import { condition } from './condition.js';
import { functionName, hasFunction, runFunction } from './functions.js';
import {
	bounded,
	CBS_LIMITS,
	cbsError,
	element,
	stringify,
	type CBSContext,
	type CBSNode
} from './model.js';
import { parseCBS } from './parser.js';

export type { CBSContext } from './model.js';

function trimBlankLines(value: string): string {
	const lines = value.split('\n');
	let start = 0;
	let end = lines.length;
	while (start < end && /^[ \t\r]*$/.test(lines[start])) {
		start++;
	}
	while (end > start && /^[ \t\r]*$/.test(lines[end - 1])) {
		end--;
	}
	return lines.slice(start, end).join('\n');
}

/** One read-only context per prompt assembly. Lookup values and slots are never reparsed. */
export class CBSRenderer {
	private steps = 0;
	private references = new Set<string>();
	constructor(private context: CBSContext) {}
	render(source: string, slot?: string): string {
		return this.nodes(parseCBS(source), slot);
	}
	reference(name: 'persona' | 'description' | 'authornote'): string {
		if (this.references.has(name)) {
			throw cbsError(`${name}의 순환 참조를 확인해주세요.`);
		}
		this.references.add(name);
		try {
			const value = name === 'persona' ? this.context.persona?.description : this.context[name];
			return this.render(value ?? '');
		} finally {
			this.references.delete(name);
		}
	}
	private nodes(nodes: CBSNode[], slot?: string): string {
		const parts: string[] = [];
		let length = 0;
		for (const node of nodes) {
			if (++this.steps > CBS_LIMITS.steps) {
				throw cbsError('평가 횟수 한도를 초과했어요.');
			}
			const value = this.node(node, slot);
			length += value.length;
			if (length > CBS_LIMITS.output) {
				throw cbsError('출력 크기 한도를 초과했어요.');
			}
			parts.push(value);
		}
		return parts.join('');
	}
	private node(node: CBSNode, slot?: string): string {
		if (node.type === 'text' || node.type === 'literal') {
			return node.value;
		}
		if (node.type === 'when') {
			return this.when(node, slot);
		}
		const name = functionName(node.name);
		if (!this.known(name)) {
			return node.source;
		}
		const args = node.args.map((arg) => this.nodes(arg, slot));
		return bounded(this.call(name, args, node.source, slot));
	}
	private when(node: Extract<CBSNode, { type: 'when' }>, slot?: string): string {
		const args = node.args.map((arg) => this.nodes(arg, slot));
		const mode = args[0];
		const hasMode = mode === 'keep' || mode === 'legacy';
		const value = this.nodes(
			condition(hasMode ? args.slice(1) : args, this.toggle) ? node.yes : node.no,
			slot
		);
		if (mode === 'keep') {
			return value;
		}
		if (mode === 'legacy') {
			return value
				.split('\n')
				.map((line) => line.trimStart())
				.join('\n')
				.trim();
		}
		return trimBlankLines(value);
	}
	private known(name: string): boolean {
		return (
			[
				'state',
				'toggle',
				'getglobalvar',
				'game',
				'user',
				'persona',
				'userpersona',
				'description',
				'authornote',
				'slot'
			].includes(name) || hasFunction(name)
		);
	}
	private call(name: string, args: string[], source: string, slot?: string): string {
		if (name === 'toggle' || name === 'getglobalvar') {
			return this.readToggle(name, args);
		}
		if (name === 'state') {
			return stringify(
				args.reduce<unknown>((value, key) => element(value, key), this.context.state)
			);
		}
		if (name === 'slot') {
			return !args.length && slot !== undefined ? slot : source;
		}
		if (hasFunction(name)) {
			return runFunction(name, args);
		}
		if (args.length) {
			throw cbsError(`${name}에는 인자를 지정할 수 없어요.`);
		}
		if (name === 'game') {
			return this.context.game ?? '';
		}
		if (name === 'user') {
			return this.context.persona?.name ?? '플레이어';
		}
		if (name === 'persona' || name === 'userpersona') {
			return this.reference('persona');
		}
		return this.reference(name as 'description' | 'authornote');
	}
	private readToggle(name: string, args: string[]): string {
		if (args.length !== 1 || (name === 'getglobalvar' && !args[0].startsWith('toggle_'))) {
			throw cbsError('프리셋 토글 식별자를 지정해주세요. getglobalvar는 toggle_ 조회만 지원해요.');
		}
		return this.toggle(name === 'toggle' ? args[0] : args[0].slice(7));
	}

	private toggle = (key: string): string => {
		return Object.hasOwn(this.context.toggles ?? {}, key) ? this.context.toggles![key] : '0';
	};
}
export function renderCBS(source: string, context: CBSContext): string {
	return new CBSRenderer(context).render(source);
}
