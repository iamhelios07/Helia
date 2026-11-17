import { Marked, type Token } from 'marked';

const fencedCode = /```[^\n]*\n[\s\S]*?(?:\n```|$)/g;
const htmlTag =
	/<\/?(?:a|abbr|address|area|article|aside|audio|b|base|bdi|bdo|blockquote|body|br|button|canvas|caption|center|cite|code|col|colgroup|data|datalist|dd|del|details|dfn|dialog|div|dl|dt|em|fieldset|figcaption|figure|font|footer|form|h[1-6]|head|header|hgroup|hr|html|i|iframe|img|input|ins|kbd|label|legend|li|link|main|map|mark|math|menu|meta|meter|nav|noscript|object|ol|optgroup|option|output|p|picture|pre|progress|q|rp|rt|ruby|s|samp|script|search|section|select|slot|small|source|span|strong|style|sub|summary|sup|svg|table|tbody|td|template|textarea|tfoot|th|thead|time|title|tr|track|u|ul|var|video|wbr)\b/i;

/** Code examples and ordinary angle brackets keep their literal text rendering. */
export function hasMessageHTML(content: string): boolean {
	return htmlTag.test(content.replace(fencedCode, ''));
}

function escapeHTML(content: string): string {
	return content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const markdown = new Marked({
	async: false,
	gfm: true,
	breaks: true,
	renderer: {
		html({ text }) {
			// Keep ordinary angle-bracket notation such as Array<T> readable.
			return hasMessageHTML(text) || text.startsWith('<!--') ? text : escapeHTML(text);
		}
	}
});

/** Template-literal indentation must not turn existing HTML cards into code blocks. */
function cardSource(content: string): string {
	const lines = content.replace(/\r\n?/g, '\n').split('\n');
	const first = lines.find((line) => line.trim());
	if (!first?.trimStart().startsWith('<') || !hasMessageHTML(first)) {
		return content;
	}
	const indent = first.match(/^[\t ]+/)?.[0];
	if (!indent || !lines.every((line) => !line.trim() || line.startsWith(indent))) {
		return content;
	}
	return lines
		.map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line))
		.join('\n');
}

function hasFormatting(token: Token): boolean {
	if (token.type === 'space' || token.type === 'br') {
		return false;
	}
	if (token.type === 'html') {
		return hasMessageHTML(token.raw);
	}
	if (token.type !== 'text' && token.type !== 'paragraph') {
		return true;
	}
	return 'tokens' in token && !!token.tokens?.some(hasFormatting);
}

/** Conversion only: the resulting HTML still requires DOMPurify inside the isolated frame. */
export function renderMessageContent(content: string): { html: string; rich: boolean } {
	try {
		const tokens = markdown.lexer(cardSource(content));
		const html = tokens
			.map((token) => {
				if (token.type === 'space') {
					return '';
				}
				const rendered = markdown.parser([token]);
				// Markdown flows normally; raw HTML retains its existing whitespace and CSS behavior.
				return token.type === 'html'
					? rendered
					: `<div data-helia-markdown>${rendered.trimEnd()}</div>`;
			})
			.join('');
		return {
			html,
			rich: tokens.some(hasFormatting) || /&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);/i.test(content)
		};
	} catch {
		// Parser failures must leave model-generated source readable as escaped text.
		return { html: '', rich: false };
	}
}

export function messageHTMLSource(content: string): string {
	return renderMessageContent(content).html;
}
