import { calculate } from './math.js';
import { bounded, CBS_LIMITS, cbsError, element, numeric, stringify, truth } from './model.js';

type Definition = { count: number | [number, number]; run: (args: string[]) => string };
function json(source: string): unknown {
	try {
		return JSON.parse(source);
	} catch {
		throw cbsError('올바른 JSON 배열이나 객체가 필요해요.');
	}
}
function array(source: string): unknown[] {
	const value = json(source);
	if (!Array.isArray(value) || value.length > CBS_LIMITS.collection) {
		throw cbsError('배열 형식이나 항목 수를 확인해주세요.');
	}
	return value;
}
function split(args: string[]): string {
	const parts = args[0].split(args[1], CBS_LIMITS.collection + 1);
	if (parts.length > CBS_LIMITS.collection) {
		throw cbsError('배열 항목 수 한도를 초과했어요.');
	}
	return JSON.stringify(parts);
}
function join(args: string[]): string {
	const parts = array(args[0]).map(stringify);
	const length =
		parts.reduce((size, part) => size + part.length, 0) +
		Math.max(0, parts.length - 1) * args[1].length;
	if (length > CBS_LIMITS.output) {
		throw cbsError('출력 크기 한도를 초과했어요.');
	}
	return parts.join(args[1]);
}
function replace([source, search, replacement]: string[]): string {
	let count = 0;
	if (!search) {
		count = source.length + 1;
	} else {
		let position = source.indexOf(search);
		while (position !== -1) {
			count++;
			position = source.indexOf(search, position + search.length);
		}
	}
	if (source.length + count * (replacement.length - search.length) > CBS_LIMITS.output) {
		throw cbsError('출력 크기 한도를 초과했어요.');
	}
	return source.replaceAll(search, () => replacement);
}
function arrayElement(args: string[]): string {
	const index = numeric(args[1]);
	if (!Number.isInteger(index)) {
		throw cbsError('배열 인덱스는 정수여야 해요.');
	}
	return stringify(array(args[0]).at(index));
}
function calc(args: string[]): string {
	if (args.length === 1) {
		return calculate(args[0]);
	}
	if (args[0] !== 'legacy') {
		throw cbsError('calc의 두 인자 형식은 legacy 계산에만 사용할 수 있어요.');
	}
	return calculate(args[1], true);
}
const functions: Record<string, Definition> = {
	equal: { count: 2, run: ([a, b]) => String(Number(a === b)) },
	notequal: { count: 2, run: ([a, b]) => String(Number(a !== b)) },
	greater: { count: 2, run: ([a, b]) => String(Number(numeric(a) > numeric(b))) },
	less: { count: 2, run: ([a, b]) => String(Number(numeric(a) < numeric(b))) },
	greaterequal: { count: 2, run: ([a, b]) => String(Number(numeric(a) >= numeric(b))) },
	lessequal: { count: 2, run: ([a, b]) => String(Number(numeric(a) <= numeric(b))) },
	and: { count: [2, 256], run: (args) => String(Number(args.every(truth))) },
	or: { count: [2, 256], run: (args) => String(Number(args.some(truth))) },
	not: { count: 1, run: ([a]) => String(Number(!truth(a))) },
	calc: { count: [1, 2], run: calc },
	round: { count: 1, run: ([a]) => String(Math.round(numeric(a))) },
	floor: { count: 1, run: ([a]) => String(Math.floor(numeric(a))) },
	ceil: { count: 1, run: ([a]) => String(Math.ceil(numeric(a))) },
	abs: { count: 1, run: ([a]) => String(Math.abs(numeric(a))) },
	trim: { count: 1, run: ([a]) => a.trim() },
	replace: { count: 3, run: replace },
	contains: { count: 2, run: ([a, b]) => String(Number(a.includes(b))) },
	startswith: { count: 2, run: ([a, b]) => String(Number(a.startsWith(b))) },
	endswith: { count: 2, run: ([a, b]) => String(Number(a.endsWith(b))) },
	length: { count: 1, run: ([a]) => String(a.length) },
	lower: { count: 1, run: ([a]) => a.toLowerCase() },
	upper: { count: 1, run: ([a]) => a.toUpperCase() },
	makearray: { count: [0, 256], run: (args) => JSON.stringify(args) },
	split: { count: 2, run: split },
	join: { count: 2, run: join },
	arraylength: { count: 1, run: ([a]) => String(array(a).length) },
	arrayelement: { count: 2, run: arrayElement },
	dictelement: { count: 2, run: ([a, b]) => stringify(element(json(a), b)) },
	br: { count: 0, run: () => '\n' },
	cbr: { count: 0, run: () => '\\n' },
	blank: { count: 0, run: () => '' },
	bo: { count: 0, run: () => '{{' },
	bc: { count: 0, run: () => '}}' }
};
const aliases: Record<string, string> = {
	array: 'makearray',
	a: 'makearray',
	objectelement: 'dictelement',
	'?': 'calc'
};
export function functionName(name: string): string {
	const normalized = name.trim().toLowerCase().replace(/[_-]/g, '');
	return Object.hasOwn(aliases, normalized) ? aliases[normalized] : normalized;
}
export function hasFunction(name: string): boolean {
	return Object.hasOwn(functions, name);
}
export function runFunction(name: string, args: string[]): string {
	const definition = functions[name];
	const [minimum, maximum] =
		typeof definition.count === 'number' ? [definition.count, definition.count] : definition.count;
	if (args.length < minimum || args.length > maximum) {
		throw cbsError(`${name}의 인자 수를 확인해주세요.`);
	}
	return bounded(definition.run(args));
}
