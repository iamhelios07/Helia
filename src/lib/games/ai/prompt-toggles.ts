/** Risu preset toggle syntax, independent from authoritative game state. */
export type PromptToggle =
	| { type: 'checkbox' | 'text' | 'textarea'; key: string; label: string }
	| { type: 'select'; key: string; label: string; options: string[] }
	| { type: 'caption' | 'divider'; label: string }
	| { type: 'group'; label: string; children: PromptToggle[] };
export type ToggleControl = Extract<PromptToggle, { key: string }>;
const MAX_SOURCE = 64 * 1024;
const MAX_VALUE = 32 * 1024;

function labelText(value: string): string {
	if (value.length > 240 || /\p{Cc}/u.test(value)) {
		throw new Error('토글 이름과 선택지는 240자 이내로 입력해주세요.');
	}
	return value;
}

function parseControl(key: string, label: string, kind: string, options: string): ToggleControl {
	if (
		key.length > 120 ||
		/\p{Cc}/u.test(key) ||
		['__proto__', 'prototype', 'constructor'].includes(key)
	) {
		throw new Error('토글 식별자를 확인해주세요.');
	}
	const control = { key, label: labelText(label) };
	if (kind !== 'select') {
		return { ...control, type: kind === 'text' || kind === 'textarea' ? kind : 'checkbox' };
	}
	const choices = options.split(',').map(labelText);
	if (!options || choices.length > 128) {
		throw new Error('선택형 토글에는 1~128개 선택지가 필요해요.');
	}
	return { ...control, type: 'select', options: choices };
}

function parseLine(line: string): PromptToggle | 'end' | undefined {
	const [key, label = '', kind = '', options = ''] = line.replace(/\r$/, '').split('=');
	if (kind === 'groupEnd') {
		return 'end';
	}
	if (kind === 'group') {
		return { type: 'group', label: labelText(label), children: [] };
	}
	if (kind === 'divider' || (kind === 'caption' && label)) {
		return { type: kind, label: labelText(label) };
	}
	return key && label ? parseControl(key, label, kind, options) : undefined;
}

function appendToggle(stack: PromptToggle[][], item: ReturnType<typeof parseLine>) {
	if (!item) {
		return;
	}
	if (item === 'end') {
		if (stack.length > 1) {
			stack.pop();
		}
		return;
	}
	stack[stack.length - 1].push(item);
	if (item.type === 'group') {
		if (stack.length > 8) {
			throw new Error('토글 그룹은 8단계까지 중첩할 수 있어요.');
		}
		stack.push(item.children);
	}
}

export function parsePromptToggles(source: string): PromptToggle[] {
	if (typeof source !== 'string' || source.length > MAX_SOURCE) {
		throw new Error('토글 정의는 64KiB 이하여야 해요.');
	}
	const result: PromptToggle[] = [];
	const stack = [result];
	const lines = source.split('\n');
	if (lines.length > 512) {
		throw new Error('토글 정의는 512줄 이하여야 해요.');
	}
	for (const line of lines) {
		appendToggle(stack, parseLine(line));
	}
	const keys = toggleControls(result).map((item) => item.key);
	if (new Set(keys).size !== keys.length) {
		throw new Error('중복된 토글 식별자가 있어요.');
	}
	return result;
}

export function toggleControls(items: PromptToggle[]): ToggleControl[] {
	return items.flatMap((item) => {
		if (item.type === 'group') {
			return toggleControls(item.children);
		}
		return 'key' in item ? [item] : [];
	});
}

function defaultValue(control: ToggleControl): string {
	return control.type === 'checkbox' || control.type === 'select' ? '0' : '';
}

export function validateToggleValue(control: ToggleControl, value: unknown): string {
	if (typeof value !== 'string' || value.length > MAX_VALUE) {
		throw new Error('토글 값은 32KiB 이하의 문자열이어야 해요.');
	}
	if (control.type === 'checkbox' && value !== '0' && value !== '1') {
		throw new Error('토글 값은 0 또는 1이어야 해요.');
	}
	if (control.type === 'select' && !control.options.some((_, index) => String(index) === value)) {
		throw new Error('토글 선택지를 확인해주세요.');
	}
	return value;
}

export function parseToggleValues(items: PromptToggle[], value: unknown): Record<string, string> {
	if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
		throw new Error('토글 값 형식을 확인해주세요.');
	}
	const row = (value ?? {}) as Record<string, unknown>;
	return Object.fromEntries(
		toggleControls(items).map((control) => [
			control.key,
			validateToggleValue(
				control,
				Object.hasOwn(row, control.key) ? row[control.key] : defaultValue(control)
			)
		])
	);
}

/** Definition edits retain compatible selections and reset controls whose type/options changed. */
export function reconcileToggleValues(
	source: string,
	values: Record<string, string>
): Record<string, string> {
	const items = parsePromptToggles(source);
	return Object.fromEntries(
		toggleControls(items).map((control) => {
			try {
				return [control.key, validateToggleValue(control, values[control.key])];
			} catch {
				return [control.key, defaultValue(control)];
			}
		})
	);
}
