import { CBS_LIMITS, cbsError, type CBSNode } from './model.js';
import { advanceLiteral, type LiteralCursor } from './syntax.js';

type Header = { name: string; args: CBSNode[][]; source: string };
type Sequence = { nodes: CBSNode[]; ending?: 'else' | 'end' };
type Delimiter = 'nested' | 'argument' | 'end';
export function parseCBS(source: string): CBSNode[] {
	if (source.length > CBS_LIMITS.source) {
		throw cbsError('입력 크기 한도를 초과했어요.');
	}
	return new Parser(source).sequence().nodes;
}
class Parser {
	private position = 0;
	private nodes = 0;
	constructor(private source: string) {}
	private check(depth: number) {
		if (depth > CBS_LIMITS.depth || ++this.nodes > CBS_LIMITS.nodes) {
			throw cbsError('문법 중첩 또는 식 개수 한도를 초과했어요.');
		}
	}
	sequence(depth = 0, block = false): Sequence {
		const nodes: CBSNode[] = [];
		while (this.position < this.source.length) {
			const start = this.source.indexOf('{{', this.position);
			if (start === -1) {
				this.text(nodes, this.source.slice(this.position));
				this.position = this.source.length;
				break;
			}
			this.text(nodes, this.source.slice(this.position, start));
			this.position = start;
			const header = this.header(depth);
			const ending = this.ending(header);
			if (ending) {
				if (!block) {
					throw cbsError('대응하는 조건 블록이 없는 종료 문법이에요.');
				}
				return { nodes, ending };
			}
			nodes.push(this.node(header, depth));
		}
		if (block) {
			throw cbsError('조건 블록의 {{/when}}이 필요해요.');
		}
		return { nodes };
	}
	private text(nodes: CBSNode[], value: string) {
		if (value) {
			this.check(0);
			nodes.push({ type: 'text', value });
		}
	}
	private header(depth: number): Header {
		this.check(depth);
		const start = this.position;
		this.position += 2;
		const args: CBSNode[][] = [[]];
		let textStart = this.position;
		const cursor: LiteralCursor = { nesting: 0, quoted: false, escaped: false };
		while (this.position < this.source.length) {
			const action = this.delimiter(cursor.nesting);
			if (!action) {
				advanceLiteral(cursor, this.source[this.position++]);
				continue;
			}
			this.text(args.at(-1)!, this.source.slice(textStart, this.position));
			this.consume(action, args, depth);
			if (action === 'end') {
				return this.splitHead(args, this.source.slice(start, this.position));
			}
			textStart = this.position;
		}
		throw cbsError(`위치 ${start + 1}의 {{ }}를 닫아주세요.`);
	}
	private consume(action: Delimiter, args: CBSNode[][], depth: number) {
		if (action === 'nested') {
			args.at(-1)!.push(this.node(this.header(depth + 1), depth + 1));
			return;
		}
		this.position += 2;
		if (action === 'argument') {
			if (args.length > 256) {
				throw cbsError('인자 개수 한도를 초과했어요.');
			}
			args.push([]);
		}
	}
	private delimiter(nesting: number): Delimiter | undefined {
		if (this.source.startsWith('{{', this.position)) {
			return 'nested';
		}
		if (!nesting && this.source.startsWith('::', this.position)) {
			return 'argument';
		}
		if (!nesting && this.source.startsWith('}}', this.position)) {
			return 'end';
		}
	}
	private splitHead(parts: CBSNode[][], source: string): Header {
		const first = parts[0][0];
		const shorthand = first?.type === 'text' ? /^(#when|\?)\s+/.exec(first.value) : null;
		if (shorthand && first?.type === 'text') {
			return {
				name: shorthand[1],
				args: [
					[{ type: 'text', value: first.value.slice(shorthand[0].length) }, ...parts[0].slice(1)],
					...parts.slice(1)
				],
				source
			};
		}
		const name = parts[0].every((node) => node.type === 'text')
			? parts[0]
					.map((node) => (node.type === 'text' ? node.value : ''))
					.join('')
					.trim()
			: '';
		return { name, args: parts.slice(1), source };
	}
	private ending(header: Header): Sequence['ending'] {
		if (header.args.length) {
			return;
		}
		if (header.name === ':else') {
			return 'else';
		}
		if (header.name === '/when' || header.name === '/') {
			return 'end';
		}
	}
	private node(header: Header, depth: number): CBSNode {
		if (header.name === '#escape') {
			return this.literal(header);
		}
		if (header.name === '#when') {
			const yes = this.sequence(depth + 1, true);
			const no = yes.ending === 'else' ? this.sequence(depth + 1, true) : undefined;
			if (no?.ending === 'else') {
				throw cbsError('한 조건 블록에는 :else를 한 번만 쓸 수 있어요.');
			}
			return { type: 'when', args: header.args, yes: yes.nodes, no: no?.nodes ?? [] };
		}
		if (header.name.startsWith('#') || header.name === '/escape') {
			throw cbsError('지원하지 않는 블록 문법이에요.');
		}
		return { type: 'call', ...header };
	}
	private escapeKeep(args: CBSNode[][]): boolean {
		const keep =
			args.length === 1 &&
			args[0].length === 1 &&
			args[0][0].type === 'text' &&
			args[0][0].value === 'keep';
		if (args.length && !keep) {
			throw cbsError('#escape에는 keep만 지정할 수 있어요.');
		}
		return keep;
	}
	private literal(header: Header): CBSNode {
		const keep = this.escapeKeep(header.args);
		const start = this.position;
		const pattern = /{{(#escape(?:::keep)?|\/escape|\/)}}/g;
		pattern.lastIndex = start;
		let depth = 1;
		for (let match = pattern.exec(this.source); match; match = pattern.exec(this.source)) {
			depth += match[1].startsWith('#') ? 1 : -1;
			if (depth > CBS_LIMITS.depth) {
				throw cbsError('문법 중첩 한도를 초과했어요.');
			}
			if (depth === 0) {
				this.position = pattern.lastIndex;
				const value = this.source.slice(start, match.index);
				return { type: 'literal', value: keep ? value : value.trim() };
			}
		}
		throw cbsError('리터럴 블록의 {{/escape}}가 필요해요.');
	}
}
