import '../../../../app.css';
import { expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import StateEditor from './StateEditor.svelte';

const schemaSource = JSON.stringify({
	type: 'object',
	properties: {
		party: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					hp: { type: 'integer' },
					nickname: { type: ['string', 'null'] }
				},
				required: ['hp'],
				additionalProperties: false
			}
		}
	},
	required: ['party'],
	additionalProperties: false
});
const stateSource = JSON.stringify({ party: [{ hp: 10, nickname: null }, { hp: 5 }] });
const source = JSON.stringify({
	schema: JSON.parse(schemaSource),
	initialState: JSON.parse(stateSource)
});

it('updates both canonical sources for schema changes and reflects source changes back into the GUI', async () => {
	const onchange = vi.fn();
	const screen = render(StateEditor, { source, onchange });
	expect(page.getByRole('combobox', { name: '상태 타입', exact: true }).query()).toBeNull();
	await expect
		.element(page.getByRole('combobox', { name: '상태.party 타입', exact: true }))
		.toBeEnabled();
	await page.getByRole('button', { name: '상태.party 펼치기', exact: true }).click();
	await page.getByRole('button', { name: '상태.party[] 펼치기', exact: true }).click();
	await page.getByRole('button', { name: '상태.party[0] 펼치기', exact: true }).click();
	await page
		.getByRole('textbox', { name: '상태.party[].hp 필드 이름', exact: true })
		.fill('health');
	await userEvent.tab();
	await expect.poll(() => onchange.mock.calls.length).toBe(1);
	let next = JSON.parse(onchange.mock.lastCall![0]);
	expect(next.initialState.party).toEqual([{ health: 10, nickname: null }, { health: 5 }]);
	await screen.rerender({ source: JSON.stringify(next) });
	await expect
		.element(page.getByRole('spinbutton', { name: '상태.party[0].health 초기값', exact: true }))
		.toHaveValue(10);
	next.initialState.party[0].health = 42;
	await screen.rerender({ source: JSON.stringify(next) });
	await expect
		.element(page.getByRole('spinbutton', { name: '상태.party[0].health 초기값', exact: true }))
		.toHaveValue(42);
	await page.getByRole('button', { name: '상태.party[].health 필드 삭제', exact: true }).click();
	await expect.element(page.getByRole('dialog', { name: '상태 변경 확인' })).toBeVisible();
	await page.getByRole('button', { name: '취소', exact: true }).click();
	expect(onchange).toHaveBeenCalledTimes(1);
	await page.getByRole('button', { name: '상태.party[].health 필드 삭제', exact: true }).click();
	await page.getByRole('button', { name: '변경', exact: true }).click();
	next = JSON.parse(onchange.mock.lastCall![0]);
	expect(next.initialState.party).toEqual([{ nickname: null }, {}]);
	expect(JSON.stringify(next.schema)).not.toContain('health');
});

it('edits optional/null values and nested arrays without adding absent values on render', async () => {
	const onchange = vi.fn();
	const screen = render(StateEditor, { source, onchange });
	expect(onchange).not.toHaveBeenCalled();
	await page.getByRole('button', { name: '상태.party 펼치기', exact: true }).click();
	await page.getByRole('button', { name: '상태.party[0] 펼치기', exact: true }).click();
	await page.getByRole('button', { name: '상태.party[1] 펼치기', exact: true }).click();
	await expect
		.element(
			page.getByRole('checkbox', { name: '상태.party[0].nickname null 초기값', exact: true })
		)
		.toBeChecked();
	await expect
		.element(
			page.getByRole('checkbox', { name: '상태.party[1].nickname 초기값 포함', exact: true })
		)
		.not.toBeChecked();
	await page
		.getByRole('checkbox', { name: '상태.party[0].nickname 초기값 포함', exact: true })
		.click();
	await page.getByRole('button', { name: '취소', exact: true }).click();
	await expect
		.element(
			page.getByRole('checkbox', { name: '상태.party[0].nickname 초기값 포함', exact: true })
		)
		.toBeChecked();
	expect(onchange).not.toHaveBeenCalled();
	await page
		.getByRole('checkbox', { name: '상태.party[1].nickname 초기값 포함', exact: true })
		.click();
	let next = JSON.parse(onchange.mock.lastCall![0]);
	expect(next.initialState.party[1].nickname).toBe('');
	await screen.rerender({ source: JSON.stringify(next) });
	await page.getByRole('button', { name: '상태.party 항목 추가', exact: true }).click();
	next = JSON.parse(onchange.mock.lastCall![0]);
	expect(next.initialState.party[2]).toEqual({ hp: 0 });
	await screen.rerender({ source: JSON.stringify(next) });
	await page.getByRole('button', { name: '상태.party[1] 항목 삭제', exact: true }).click();
	await page.getByRole('button', { name: '변경', exact: true }).click();
	expect(JSON.parse(onchange.mock.lastCall![0]).initialState.party).toEqual([
		{ hp: 10, nickname: null },
		{ hp: 0 }
	]);
});

it('leaves invalid source intact and returns to visual editing after source correction', async () => {
	const onchange = vi.fn();
	const screen = render(StateEditor, { source: '{unfinished', onchange });
	await expect.element(page.getByRole('alert')).toHaveTextContent('원본은 보존');
	expect(onchange).not.toHaveBeenCalled();
	await screen.rerender({ source });
	await page.getByRole('button', { name: '상태.party 펼치기', exact: true }).click();
	await page.getByRole('button', { name: '상태.party[0] 펼치기', exact: true }).click();
	await expect
		.element(page.getByRole('spinbutton', { name: '상태.party[0].hp 초기값', exact: true }))
		.toHaveValue(10);
	expect(onchange).not.toHaveBeenCalled();
});

it('aligns the main field controls in one row and reveals only the selected field details', async () => {
	const onchange = vi.fn();
	render(StateEditor, {
		source: JSON.stringify({
			schema: {
				type: 'object',
				properties: { hp: { type: 'integer' }, name: { type: 'string' } },
				required: ['hp', 'name'],
				additionalProperties: false
			},
			initialState: { hp: 100, name: '용사' }
		}),
		onchange
	});
	const controls = [
		page.getByRole('textbox', { name: '상태.hp 필드 이름', exact: true }),
		page.getByRole('combobox', { name: '상태.hp 타입', exact: true }),
		page.getByRole('spinbutton', { name: '상태.hp 초기값', exact: true }),
		page.getByRole('checkbox', { name: '상태.hp 필수', exact: true })
	];
	const row = controls[0].element().closest('.field-row');
	for (const control of controls) expect(control.element().closest('.field-row')).toBe(row);
	const centers = controls.map((control) => {
		const rect = control.element().getBoundingClientRect();
		return rect.top + rect.height / 2;
	});
	expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(2);
	expect(page.getByRole('textbox', { name: '상태.hp 표시 이름', exact: true }).query()).toBeNull();
	await page.getByRole('button', { name: '상태.hp 상세 설정', exact: true }).click();
	await expect
		.element(page.getByRole('textbox', { name: '상태.hp 표시 이름', exact: true }))
		.toBeVisible();
	await page.getByRole('button', { name: '상태.name 상세 설정', exact: true }).click();
	expect(page.getByRole('textbox', { name: '상태.hp 표시 이름', exact: true }).query()).toBeNull();
	await page.getByRole('textbox', { name: '상태.name 표시 이름', exact: true }).fill('이름');
	const next = JSON.parse(onchange.mock.lastCall![0]);
	expect(next.schema.properties.name.title).toBe('이름');
	expect(next.initialState).toEqual({ hp: 100, name: '용사' });
});

it('preserves collapsed values and only enables child values after including an optional object', async () => {
	const onchange = vi.fn();
	const screen = render(StateEditor, {
		source: JSON.stringify({
			schema: {
				type: 'object',
				properties: {
					config: {
						type: 'object',
						properties: { note: { type: 'string' } },
						additionalProperties: false
					}
				},
				additionalProperties: false
			},
			initialState: {}
		}),
		onchange
	});
	await page.getByRole('button', { name: '상태.config 펼치기', exact: true }).click();
	await expect
		.element(page.getByRole('checkbox', { name: '상태.config.note 초기값 포함', exact: true }))
		.toBeDisabled();
	expect(onchange).not.toHaveBeenCalled();
	await page.getByRole('checkbox', { name: '상태.config 초기값 포함', exact: true }).click();
	let next = JSON.parse(onchange.mock.lastCall![0]);
	expect(next.initialState).toEqual({ config: {} });
	await screen.rerender({ source: JSON.stringify(next) });
	await page.getByRole('checkbox', { name: '상태.config.note 초기값 포함', exact: true }).click();
	next = JSON.parse(onchange.mock.lastCall![0]);
	await screen.rerender({ source: JSON.stringify(next) });
	await page
		.getByRole('textbox', { name: '상태.config.note 초기값', exact: true })
		.fill('보존할 값');
	await screen.rerender({ source: onchange.mock.lastCall![0] });
	const count = onchange.mock.calls.length;
	await page.getByRole('button', { name: '상태.config 접기', exact: true }).click();
	expect(
		page.getByRole('textbox', { name: '상태.config.note 초기값', exact: true }).query()
	).toBeNull();
	await page.getByRole('button', { name: '상태.config 펼치기', exact: true }).click();
	await expect
		.element(page.getByRole('textbox', { name: '상태.config.note 초기값', exact: true }))
		.toHaveValue('보존할 값');
	expect(onchange).toHaveBeenCalledTimes(count);
});
