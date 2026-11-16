import { describe, expect, it } from 'vitest';

import { hasMessageHTML, messageHTMLSource } from './message-html.js';

describe('chat HTML detection', () => {
	it('preserves plain text, angle brackets and fenced HTML examples', () => {
		for (const text of [
			'철 < 은',
			'Array<T>',
			'```html\n<div>예제</div>\n```',
			'```html\n<div>입력 중'
		]) {
			expect(hasMessageHTML(text)).toBe(false);
		}
	});
	it('recognizes markup and partially streamed elements', () => {
		for (const text of [
			'<html><body>주문서</body></html>',
			'<font color="orange">대장간</font>',
			'<div>주문서</div>',
			'손님: <strong>검</strong>',
			'<style>.card{color:red}</style>',
			'<div class="'
		]) {
			expect(hasMessageHTML(text)).toBe(true);
		}
	});
	it('escapes code blocks inside a rich message', () => {
		expect(messageHTMLSource('<b>예시</b>\n```html\n<img src=x onerror=alert(1)> &\n```')).toBe(
			'<b>예시</b>\n<pre><code>```html\n&lt;img src=x onerror=alert(1)&gt; &amp;\n```</code></pre>'
		);
	});
});
