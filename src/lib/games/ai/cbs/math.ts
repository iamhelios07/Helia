import { cbsError } from './model.js';

const precedence: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, '^': 4 };
const legacyPrecedence: Record<string, number> = {
	'+': 2,
	'-': 2,
	'*': 3,
	'/': 3,
	'%': 3,
	'^': 4,
	'<': 1,
	'>': 1,
	'|': 1,
	'&': 1,
	'≤': 1,
	'≥': 1,
	'=': 1,
	'≠': 1
};
const legacyOperators: Record<string, string> = {
	'&&': '&',
	'||': '|',
	'<=': '≤',
	'>=': '≥',
	'==': '=',
	'!=': '≠',
	null: '0'
};
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
		case '=':
			return Number(left === right);
		case '≠':
			return Number(left !== right);
		case '<':
			return Number(left < right);
		case '>':
			return Number(left > right);
		case '≤':
			return Number(left <= right);
		case '≥':
			return Number(left >= right);
		case '|':
			return left || right;
		case '&':
			return left && right;
		default:
			throw cbsError('지원하지 않는 계산 연산자예요.');
	}
}
/** Bounded numeric expressions; legacy mode preserves Risu operator precedence. No evaluation of JS. */
export function calculate(source: string, legacy = false): string {
	if (source.length > 4096) {
		throw cbsError('계산식이 너무 길어요.');
	}
	const expressionSource = legacy
		? source.replace(
				/&&|\|\||<=|>=|==|!=|null/gi,
				(operator) => legacyOperators[operator.toLowerCase()]
			)
		: source;
	const priorities = legacy ? legacyPrecedence : precedence;
	const tokens = expressionSource.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|[^\s]/gi) ?? [];
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
			const priority = Object.hasOwn(priorities, operator) ? priorities[operator] : -1;
			if (priority < minimum) {
				break;
			}
			position++;
			result = binary(
				operator,
				result,
				expression(priority + Number(legacy || operator !== '^'), depth + 1)
			);
		}
		return result;
	}
	function atom(depth: number): number {
		const token = tokens[position++];
		if (legacy && token === '!') {
			return Number(!expression(5, depth));
		}
		if (token === '+' || token === '-') {
			return (token === '-' ? -1 : 1) * expression(legacy ? 5 : 3, depth);
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
