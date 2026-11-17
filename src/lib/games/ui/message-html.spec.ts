import { describe, expect, it } from 'vitest';

import { hasMessageHTML, messageHTMLSource, renderMessageContent } from './message-html.js';

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
		const html = messageHTMLSource('<b>예시</b>\n```html\n<img src=x onerror=alert(1)> &\n```');
		expect(html).toContain('<b>예시</b>');
		expect(html).toContain(
			'<pre><code class="language-html">&lt;img src=x onerror=alert(1)&gt; &amp;'
		);
		expect(html).not.toContain('<img');
		expect(html).not.toContain('```');
	});
});

describe('chat Markdown conversion', () => {
	it('renders headings, emphasis, lists, quotes, inline code and GFM tables', () => {
		const { html, rich } = renderMessageContent(
			'# 주문\n\n**철검**과 *방패*, ~~파손~~\n\n- 철\n- 나무\n\n> 튼튼하게\n\n`<div>`\n\n| 재료 | 수량 |\n| --- | --- |\n| 철 | 2 |'
		);
		expect(rich).toBe(true);
		for (const tag of [
			'<h1>',
			'<strong>',
			'<em>',
			'<del>',
			'<ul>',
			'<li>',
			'<blockquote>',
			'<code>&lt;div&gt;</code>',
			'<table>',
			'<td>2</td>'
		]) {
			expect(html).toContain(tag);
		}
	});
	it('mixes Markdown and raw HTML while preserving authored CSS and reference links', () => {
		const { html } = renderMessageContent(
			'**주문**\n\n<style>.card { color: gold; }</style>\n<div class="card">철검</div>\n\n*완성* [정보][ref]\n\n[ref]: https://example.com'
		);
		expect(html).toContain('<strong>주문</strong>');
		expect(html).toContain('<style>.card { color: gold; }</style>');
		expect(html).toContain('<div class="card">철검</div>');
		expect(html).toContain('<em>완성</em>');
		expect(html).toContain('<a href="https://example.com">정보</a>');
	});
	it('keeps ordinary angle brackets readable, including inside formatted text', () => {
		for (const text of ['철 < 은', 'Array<T>', '일반 대화\n다음 줄']) {
			expect(renderMessageContent(text).rich).toBe(false);
		}
		expect(messageHTMLSource('**Array<T>**')).toContain('<strong>Array&lt;T&gt;</strong>');
		expect(messageHTMLSource('**첫 줄**\n둘째 줄')).toContain('<br>둘째 줄');
		expect(renderMessageContent('&lt;div&gt; &#xAC80;').rich).toBe(true);
	});
	it('supports backtick, tilde and unfinished code fences without executing HTML examples', () => {
		for (const content of [
			'```html\n<script>alert(1)</script>\n```',
			'~~~html\n<script>alert(1)</script>\n~~~',
			'```html\n<script>alert(1)'
		]) {
			const rendered = renderMessageContent(content);
			expect(rendered.rich).toBe(true);
			expect(rendered.html).toContain('<pre><code');
			expect(rendered.html).toContain('&lt;script&gt;');
			expect(rendered.html).not.toContain('<script>');
		}
	});
	it('preserves indented legacy HTML cards while leaving ordinary indented code intact', () => {
		expect(
			messageHTMLSource('\n\t\t<style>.card{color:red}</style>\n\t\t<div class="card">검</div>\n')
		).toContain('<div class="card">검</div>');
		expect(messageHTMLSource('    const item = "iron";')).toContain('<pre><code>');
		expect(messageHTMLSource('<div>**HTML 본문**</div>')).toContain('<div>**HTML 본문**</div>');
	});
});
