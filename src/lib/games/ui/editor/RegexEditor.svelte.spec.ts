import '../../../../app.css';
import { expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

import { chooseItemAction } from '#lib/components/item-actions-test.js';

import { createRegexRule, type RegexRule } from '../../regex.js';
import RegexEditor from './RegexEditor.svelte';

it('edits rules, tests capture replacements and renders HTML using the message frame', async () => {
	let source = $state('[]');
	render(RegexEditor, {
		get source() {
			return source;
		},
		onchange: (value) => (source = value)
	});
	await page.getByRole('button', { name: '규칙 추가' }).click();
	await page.getByRole('textbox', { name: '규칙 이름' }).fill('손님 이름');
	await page.getByRole('textbox', { name: '검색식 (IN)' }).fill('\\[손님: (.*?)\\]');
	await page.getByRole('textbox', { name: '치환문 (OUT)' }).fill('<strong>$1</strong>');
	await page.getByRole('button', { name: '테스트 실행' }).click();
	await expect
		.element(page.getByRole('textbox', { name: '변환 결과' }))
		.toHaveValue('<strong>엘렌</strong>');
	await expect.element(page.getByTitle('메시지 HTML')).toBeVisible();
	await expect
		.poll(() => JSON.parse(source)[0])
		.toMatchObject({ name: '손님 이름', stage: 'display', roles: ['assistant'], flags: 'g' });
	await page.getByRole('textbox', { name: '검색식 (IN)' }).fill('[');
	await expect.poll(() => JSON.parse(source)[0].pattern).toBe('[');
	await expect.element(page.getByRole('alert')).toHaveTextContent('Invalid regular expression');
	await expect.element(page.getByRole('textbox', { name: '변환 결과' })).not.toBeInTheDocument();
});

it('orders, disables, retargets and removes rules', async () => {
	const first = { ...createRegexRule(), name: '첫 규칙', pattern: 'a', replacement: 'b' };
	const second = { ...createRegexRule(), name: '둘째 규칙', pattern: 'b', replacement: 'c' };
	let source = $state(JSON.stringify([first, second]));
	render(RegexEditor, {
		get source() {
			return source;
		},
		onchange: (value) => (source = value)
	});
	await page.getByRole('button', { name: '규칙 아래로 이동' }).click();
	await expect
		.poll(() => JSON.parse(source).map((r: RegexRule) => r.name))
		.toEqual(['둘째 규칙', '첫 규칙']);
	await page.getByRole('checkbox', { name: '사용', exact: true }).click();
	await expect.poll(() => JSON.parse(source)[1].enabled).toBe(false);
	await page.getByRole('combobox', { name: '적용 단계' }).selectOptions('request');
	await page.getByRole('checkbox', { name: '사용자', exact: true }).click();
	await expect
		.poll(() => JSON.parse(source)[1])
		.toMatchObject({ stage: 'request', roles: ['assistant', 'user'] });
	await chooseItemAction('첫 규칙', 'delete');
	await page.getByRole('button', { name: '삭제', exact: true }).click();
	await expect.poll(() => JSON.parse(source).map((r: RegexRule) => r.id)).toEqual([second.id]);
});

it('preserves malformed JSON and prevents edits when the editor is locked', async () => {
	const changes: string[] = [];
	const screen = render(RegexEditor, { source: '{unfinished', onchange: (s) => changes.push(s) });
	await expect.element(page.getByRole('alert')).toHaveTextContent('JSON으로 편집');
	expect(changes).toEqual([]);
	await screen.rerender({
		source: JSON.stringify([{ ...createRegexRule(), pattern: 'a' }]),
		disabled: true
	});
	await expect.element(page.getByRole('textbox', { name: '검색식 (IN)' })).toBeDisabled();
	await expect.element(page.getByRole('button', { name: '규칙 추가' })).toBeDisabled();
});
