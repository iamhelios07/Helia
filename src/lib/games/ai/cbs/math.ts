import { cbsError } from './model.js';

const precedence: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, '^': 4 };
function binary(operator: string, left: number, right: number): number {
	switch (operator) {
		case '+':
			return left + right;
		case '-':
			return left - right;
		case '*':
			return left * right;
		case '/':
			return left / right;
		case '%':
			return left % right;
		case '^':
			return left ** right;
		default:
			throw cbsError('지원하지 않는 계산 연산자예요.');
	}
}
/** Arithmetic only. No JavaScript execution, identifiers or host access. */
export function calculate(source: string): string {
	if (source.length > 4096) {
		throw cbsError('계산식이 너무 길어요.');
	}
	const tokens = source.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|[^\s]/gi) ?? [];
	if (tokens.length > 512) {
		throw cbsError('계산식이 너무 복잡해요.');
	}
	let position = 0;
	function expression(minimum = 0, depth = 0): number {
		if (depth > 32) {
			throw cbsError('계산식 중첩 한도를 초과했어요.');
		}
		let result = atom(depth + 1);
		while (position < tokens.length) {
			const operator = tokens[position];
			const priority = Object.hasOwn(precedence, operator) ? precedence[operator] : -1;
			if (priority < minimum) {
				break;
			}
			position++;
			result = binary(operator, result, expression(priority + Number(operator !== '^'), depth + 1));
		}
		return result;
	}
	function atom(depth: number): number {
		const token = tokens[position++];
		if (token === '+' || token === '-') {
			return (token === '-' ? -1 : 1) * expression(3, depth);
		}
		if (token === '(') {
			const value = expression(0, depth);
			if (tokens[position++] !== ')') {
				throw cbsError('계산식 괄호를 확인해주세요.');
			}
			return value;
		}
		if (token === undefined || !/^\d|^\.\d/.test(token)) {
			throw cbsError('계산식을 확인해주세요.');
		}
		return Number(token);
	}
	const result = expression();
	if (position !== tokens.length || !Number.isFinite(result)) {
		throw cbsError('계산식이나 결과를 확인해주세요. 0으로 나눌 수 없어요.');
	}
	return String(result);
}
