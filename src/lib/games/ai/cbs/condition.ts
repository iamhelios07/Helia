import { runFunction } from './functions.js';
import { cbsError, truth } from './model.js';

const operators: Record<string, { priority: number; name: string }> = {
	or: { priority: 1, name: 'or' },
	and: { priority: 2, name: 'and' },
	is: { priority: 3, name: 'equal' },
	isnot: { priority: 3, name: 'notequal' },
	'>': { priority: 3, name: 'greater' },
	'<': { priority: 3, name: 'less' },
	'>=': { priority: 3, name: 'greaterequal' },
	'<=': { priority: 3, name: 'lessequal' }
};
export function condition(args: string[]): boolean {
	let position = 0;
	function expression(minimum = 0, depth = 0): string {
		if (depth > 32 || position >= args.length) {
			throw cbsError('조건식을 확인해주세요.');
		}
		let left = args[position++];
		if (left === 'not') {
			left = runFunction('not', [expression(3, depth + 1)]);
		}
		while (position < args.length) {
			const token = args[position];
			const operator = Object.hasOwn(operators, token) ? operators[token] : undefined;
			if (!operator || operator.priority < minimum) {
				break;
			}
			position++;
			left = runFunction(operator.name, [left, expression(operator.priority + 1, depth + 1)]);
		}
		return left;
	}
	const result = expression();
	if (position !== args.length) {
		throw cbsError('지원하지 않는 조건 연산자예요.');
	}
	return truth(result);
}
