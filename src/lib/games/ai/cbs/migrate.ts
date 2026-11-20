import { CBS_LIMITS, bounded } from './model.js';
import { parseCBS } from './parser.js';
import { advanceLiteral, type LiteralCursor } from './syntax.js';

export class CBSMigrationError extends Error {}
export interface CBSMigration {
	text: string;
	changes: number;
}
type Block = { name: string; old: boolean };

/** Import-only rewrite. Runtime parsing never accepts deprecated block aliases. */
export function migrateCBS(source: string, risuCalculations = false): CBSMigration {
	if (source.length > CBS_LIMITS.source) {
		throw new CBSMigrationError('CBS 입력 크기 한도를 초과했어요.');
	}
	if (!/{{\s*(?:[#/](?:if(?:_pure)?|pure(?:_?display)?)\b|\?(?=\s|::)|calc::)/.test(source)) {
		return { text: source, changes: 0 };
	}
	return new Migration(source, risuCalculations).run();
}

class Migration {
	private position = 0;
	private count = 0;
	private steps = 0;
	private blocks: Block[] = [];
	constructor(
		private source: string,
		private risuCalculations: boolean
	) {}
	private fail(message: string): never {
		throw new CBSMigrationError(`CBS 위치 ${this.position + 1}: ${message}`);
	}
	private check(depth: number) {
		if (depth > CBS_LIMITS.depth || ++this.steps > CBS_LIMITS.nodes) {
			this.fail('문법 중첩 또는 식 개수 한도를 초과했어요.');
		}
	}
	run(): CBSMigration {
		const parts: string[] = [];
		while (this.position < this.source.length) {
			const start = this.source.indexOf('{{', this.position);
			if (start === -1) {
				parts.push(this.source.slice(this.position));
				break;
			}
			parts.push(this.source.slice(this.position, start));
			this.position = start;
			parts.push(this.tag(0));
		}
		if (this.blocks.some((block) => block.old)) {
			this.fail('구형 조건 블록의 종료 태그가 필요해요.');
		}
		const text = bounded(parts.join(''));
		if (this.count) {
			try {
				parseCBS(text);
			} catch {
				this.fail('변환한 문법을 해석할 수 없어요. 블록의 짝과 지원하지 않는 문법을 확인해주세요.');
			}
		}
		return { text, changes: this.count };
	}
	private header(depth: number, legacy: boolean): string {
		this.check(depth);
		this.position += 2;
		let start = this.position;
		const headerStart = start;
		let oldCondition: boolean | undefined;
		const parts: string[] = [];
		const cursor: LiteralCursor = { nesting: 0, quoted: false, escaped: false };
		while (this.position < this.source.length) {
			if (this.source.startsWith('{{', this.position)) {
				oldCondition ??= /^\s*#if(?:_pure)?(?:\s|::)/.test(
					this.source.slice(headerStart, this.position)
				);
				parts.push(
					this.source.slice(start, this.position),
					this.tag(depth + 1, legacy || oldCondition)
				);
				start = this.position;
			} else if (!cursor.nesting && this.source.startsWith('}}', this.position)) {
				parts.push(this.source.slice(start, this.position));
				this.position += 2;
				return bounded(parts.join(''));
			} else {
				advanceLiteral(cursor, this.source[this.position++]);
			}
		}
		return this.fail('{{ }}의 짝이 맞지 않아요.');
	}
	private tag(depth: number, legacy = false): string {
		const start = this.position;
		const inner = this.header(depth, legacy);
		const head = inner.trim();
		if (/^#(?:escape(?:::keep)?|pure(?:_?display)?)$/.test(head)) {
			return this.literal(head, start);
		}
		const old = /^#(if_pure|if)(?:\s+|::)([\s\S]+)$/.exec(head);
		if (old) {
			const condition = this.oldCondition(old[2].trim());
			this.open({ name: old[1], old: true });
			this.count++;
			return `{{#when::${old[1] === 'if' ? 'legacy' : 'keep'}::${condition}}}`;
		}
		if (/^#if(?:_pure)?$/.test(head)) {
			this.fail('구형 조건문에 조건식이 필요해요.');
		}
		if (head === ':else' && this.blocks.at(-1)?.old) {
			this.fail('구형 if/if_pure의 :else는 의미를 보존해 자동 변환할 수 없어요.');
		}
		const close = /^\/(\w*)$/.exec(head);
		if (close) {
			return this.close(close[1], inner);
		}
		const block = /^#(\w+)(?=$|\s|::)/.exec(head);
		if (block) {
			this.open({ name: block[1], old: false });
		}
		return this.calculation(inner, legacy || this.blocks.some((block) => block.old));
	}
	private oldCondition(value: string): string {
		const [node] = parseCBS(`{{#when::keep::${value}}}{{/when}}`);
		if (node.type !== 'when' || node.args.length !== 2) {
			this.fail('구형 조건식에 최상위 :: 구분자를 사용할 수 없어요.');
		}
		return value;
	}
	private open(block: Block) {
		if (this.blocks.length >= CBS_LIMITS.depth) {
			this.fail('조건 블록 중첩 한도를 초과했어요.');
		}
		this.blocks.push(block);
	}
	private close(name: string, inner: string): string {
		const block = this.blocks.at(-1);
		if (!block) {
			if (name === 'if' || name === 'if_pure') {
				this.fail('종료 태그에 대응하는 구형 조건문이 없어요.');
			}
			return `{{${inner}}}`;
		}
		const oldClose = block.old && (name === 'if' || name === 'if_pure');
		if (name && name !== block.name && !oldClose) {
			this.fail('조건 블록의 시작과 종료 태그가 맞지 않아요.');
		}
		this.blocks.pop();
		return block.old ? '{{/when}}' : `{{${inner}}}`;
	}
	private calculation(inner: string, legacy: boolean): string {
		const match = /^(?:\?\s+|\?::|calc::)([\s\S]+)$/.exec(inner);
		if (!match || match[1].startsWith('legacy::')) {
			return `{{${inner}}}`;
		}
		if (this.risuCalculations || legacy || /[=<>!&|≤≥≠]/.test(match[1])) {
			this.count++;
			return `{{calc::legacy::${match[1]}}}`;
		}
		return `{{${inner}}}`;
	}
	private literal(head: string, start: number): string {
		const bodyStart = this.position;
		const name = head.split('::')[0].slice(1);
		const pattern = /{{\s*(#[\w]+(?:::keep)?|\/[\w]*)\s*}}/g;
		pattern.lastIndex = this.position;
		let depth = 1;
		for (let match = pattern.exec(this.source); match; match = pattern.exec(this.source)) {
			if (match[1].split('::')[0] === `#${name}`) {
				depth++;
			}
			if (match[1] === '/' || match[1] === `/${name}`) {
				depth--;
			}
			if (depth > CBS_LIMITS.depth) {
				this.fail('리터럴 블록 중첩 한도를 초과했어요.');
			}
			if (depth !== 0) {
				continue;
			}
			this.position = pattern.lastIndex;
			return this.literalResult(name, start, this.source.slice(bodyStart, match.index));
		}
		return this.fail('리터럴 블록의 종료 태그가 필요해요.');
	}
	private literalResult(name: string, start: number, body: string): string {
		if (name === 'escape') {
			return this.source.slice(start, this.position);
		}
		this.count++;
		if (/{{(?:#escape(?:::keep)?|\/escape|\/)}}/.test(body)) {
			return body
				.trim()
				.replace(/{{|}}/g, (delimiter) => (delimiter === '{{' ? '{{bo}}' : '{{bc}}'));
		}
		return `{{#escape}}${body}{{/escape}}`;
	}
}
