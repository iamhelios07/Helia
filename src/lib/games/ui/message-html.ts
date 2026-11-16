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

/** Mixed HTML can contain literal code fences without executing their examples. */
export function messageHTMLSource(content: string): string {
	return content.replace(fencedCode, (code) => `<pre><code>${escapeHTML(code)}</code></pre>`);
}
