<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import StateFieldRow from './StateFieldRow.svelte';
	import StateFieldDetails from './StateFieldDetails.svelte';
	import StateValueEditor from './StateValueEditor.svelte';
	import {
		arrayItem,
		initialValueFor,
		objectShape,
		type AuthoringType,
		type SchemaEdit,
		type SchemaTrail
	} from '../../state/authoring.js';
	import { schemaType, type ValueSchema } from '../../state/schema.js';
	import { isStateObject, type StateValue } from '../../state/value.js';
	let {
		schema,
		value,
		trail = [],
		label = '상태',
		name = '',
		required,
		root = false,
		template = false,
		depth = 0,
		disabled = false,
		valueDisabled = false,
		valueOnly = false,
		onremove,
		selected,
		onselect,
		onedit,
		onchange,
		onconfirm
	}: {
		schema: ValueSchema;
		value: StateValue | undefined;
		trail?: SchemaTrail;
		label?: string;
		name?: string;
		required?: boolean;
		root?: boolean;
		template?: boolean;
		depth?: number;
		disabled?: boolean;
		valueDisabled?: boolean;
		valueOnly?: boolean;
		onremove?: () => void;
		selected: string | null;
		onselect: (label: string | null) => void;
		onedit: (trail: SchemaTrail, edit: SchemaEdit) => boolean;
		onchange: (value: StateValue | undefined) => void;
		onconfirm: (message: string, action: () => void) => void;
	} = $props();
	let expanded = $state(false);
	let newName = $state('');
	let object = $derived(objectShape(schema));
	let item = $derived(arrayItem(schema));
	let selectionKey = $derived(JSON.stringify(trail));
	const types: { value: AuthoringType; label: string }[] = [
		{ value: 'string', label: '문자열' },
		{ value: 'number', label: '숫자' },
		{ value: 'integer', label: '정수' },
		{ value: 'boolean', label: '참 / 거짓' },
		{ value: 'object', label: '객체' },
		{ value: 'array', label: '배열' },
		{ value: 'null', label: 'null' }
	];
	function changeChild(key: string, next: StateValue | undefined) {
		if (disabled || value === undefined || !isStateObject(value)) return;
		const updated = { ...value };
		if (next === undefined) delete updated[key];
		else updated[key] = next;
		onchange(updated);
	}
	function addField() {
		if (disabled) return;
		if (onedit(trail, { kind: 'add', name: newName })) newName = '';
	}
</script>

{#if !root}
	<div
		class={['field-row', { selected: !valueOnly && selected === selectionKey }]}
		style:--depth={depth}
	>
		<div class="field-name">
			{#if object || item}<button
					type="button"
					class="icon-button expand"
					aria-label="{label} {expanded ? '접기' : '펼치기'}"
					aria-expanded={expanded}
					onclick={() => (expanded = !expanded)}
					><span class={{ expanded }}><Icon name="chevron" size={13} /></span></button
				>{:else}<span class="indent"></span>{/if}
			{#if required !== undefined && !valueOnly}<input
					aria-label="{label} 필드 이름"
					value={name}
					{disabled}
					onchange={(event) => {
						const next = event.currentTarget.value;
						event.currentTarget.value = name;
						if (next !== name && onedit(trail.slice(0, -1), { kind: 'rename', name, next })) {
							if (selected === selectionKey) onselect(null);
						}
					}}
				/>{:else}<span class="item-label">{name || '항목'}</span>{/if}
		</div>
		{#if valueOnly}<span class="type-label"
				>{types.find((type) => type.value === schemaType(schema))?.label}</span
			>{:else}
			<select
				aria-label="{label} 타입"
				value={schemaType(schema)}
				{disabled}
				onchange={(event) => {
					const type = event.currentTarget.value as AuthoringType;
					event.currentTarget.value = schemaType(schema);
					onconfirm(
						`${label}의 타입을 바꾸면 해당 초기값을 새 타입의 시작값으로 바꿉니다. 계속할까요?`,
						() => {
							onedit(trail, { kind: 'type', type });
						}
					);
				}}
			>
				{#each types as type (type.value)}<option value={type.value}>{type.label}</option>{/each}
			</select>
		{/if}
		<div class="initial-cell">
			{#if template}<span class="muted">항목별로 입력</span>{:else}<StateValueEditor
					{schema}
					{value}
					{label}
					optional={required === false}
					disabled={disabled || valueDisabled}
					compact
					{onchange}
					{onconfirm}
				/>{/if}
		</div>
		<div class="required-cell">
			{#if valueOnly}<span class="muted">{required ? '✓' : '—'}</span
				>{:else if required !== undefined}<input
					type="checkbox"
					aria-label="{label} 필수"
					checked={required}
					{disabled}
					onchange={(event) =>
						onedit(trail.slice(0, -1), {
							kind: 'required',
							name,
							enabled: event.currentTarget.checked
						})}
				/>{:else}<span class="muted">—</span>{/if}
		</div>
		<div class="row-actions">
			{#if !valueOnly}
				<button
					type="button"
					class="icon-button"
					aria-label="{label} 상세 설정"
					title="상세 설정"
					aria-pressed={selected === selectionKey}
					onclick={() => onselect(selected === selectionKey ? null : selectionKey)}
					><Icon name="settings" size={14} /></button
				>
				{#if required !== undefined}<button
						type="button"
						class="icon-button delete"
						aria-label="{label} 필드 삭제"
						title="필드 삭제"
						{disabled}
						onclick={() =>
							onconfirm(`${label} 필드와 해당 초기값을 삭제할까요?`, () => {
								if (
									onedit(trail.slice(0, -1), { kind: 'remove', name }) &&
									selected === selectionKey
								)
									onselect(null);
							})}><Icon name="trash" size={14} /></button
					>{/if}
			{:else if onremove}<button
					type="button"
					class="icon-button delete"
					aria-label="{label} 항목 삭제"
					title="항목 삭제"
					disabled={disabled || valueDisabled}
					onclick={() => onconfirm(`${label} 항목을 삭제할까요?`, () => onremove?.())}
					><Icon name="trash" size={14} /></button
				>{/if}
		</div>
	</div>
{/if}
{#if !valueOnly && selected === selectionKey}
	<section class="field-details" aria-label="{label} 상세 설정">
		<div class="details-heading">
			<strong>{root ? '문서 설정' : name || '배열 항목'}</strong><span>{label}</span><button
				type="button"
				class="icon-button"
				aria-label="상세 설정 닫기"
				onclick={() => onselect(null)}><Icon name="close" size={14} /></button
			>
		</div>
		<StateFieldDetails {schema} {trail} {label} {disabled} {onedit} {onconfirm} />
	</section>
{/if}
{#if root || expanded}
	{#if object}
		{#each Object.entries(object.properties) as [key, child] (key)}
			<StateFieldRow
				schema={child}
				value={value !== undefined && isStateObject(value) && Object.hasOwn(value, key)
					? value[key]
					: undefined}
				trail={[...trail, key]}
				label={`${label}.${key}`}
				name={key}
				required={object.required?.includes(key) ?? false}
				{template}
				{valueOnly}
				depth={root ? depth : depth + 1}
				{disabled}
				valueDisabled={valueDisabled ||
					(!template && (value === undefined || !isStateObject(value)))}
				{selected}
				{onselect}
				{onedit}
				onchange={(next) => changeChild(key, next)}
				{onconfirm}
			/>
		{/each}
		{#if !template && value !== undefined && isStateObject(value)}
			{#each Object.keys(value).filter((key) => !Object.hasOwn(object!.properties, key)) as key (key)}
				<div class="unknown-field">
					<span role="alert">정의되지 않은 필드: {key}</span><button
						type="button"
						{disabled}
						onclick={() =>
							onconfirm(`${label}.${key} 초기값을 삭제할까요?`, () => changeChild(key, undefined))}
						>초기값 삭제</button
					>
				</div>
			{/each}
		{/if}
		{#if root && !Object.keys(object.properties).length}<p class="empty-fields">
				첫 필드를 추가해 게임의 상태를 정의하세요.
			</p>{/if}
		{#if !valueOnly}<form
				class="add-field"
				style:--depth={root ? depth : depth + 1}
				onsubmit={(event) => {
					event.preventDefault();
					addField();
				}}
			>
				<Icon name="plus" size={14} /><input
					aria-label="{label} 새 필드 이름"
					placeholder="새 필드 이름"
					bind:value={newName}
					{disabled}
				/><button type="submit" {disabled}>필드 추가</button>
			</form>
		{/if}
	{:else if item}
		{#if !valueOnly}
			<div class="array-heading" style:--depth={depth + 1}>
				항목 구조 <span>모든 항목에 공통으로 적용</span>
			</div>
			<StateFieldRow
				schema={item}
				value={undefined}
				trail={[...trail, null]}
				label={`${label}[]`}
				template
				depth={depth + 1}
				{disabled}
				{selected}
				{onselect}
				{onedit}
				onchange={() => {}}
				{onconfirm}
			/>
		{/if}
		{#if !template && Array.isArray(value)}
			<div class="array-heading" style:--depth={depth + 1}>
				초기 항목 <span>{value.length}개</span>
			</div>
			{#each value as entry, index (index)}
				<StateFieldRow
					schema={item}
					value={entry}
					trail={[...trail, null]}
					label={`${label}[${index}]`}
					name={`[${index}]`}
					valueOnly
					depth={depth + 1}
					{disabled}
					{valueDisabled}
					{selected}
					{onselect}
					{onedit}
					onchange={(next) => {
						if (Array.isArray(value) && next !== undefined)
							onchange(value.map((old, i) => (i === index ? next : old)));
					}}
					onremove={() => {
						if (Array.isArray(value)) onchange(value.filter((_, i) => i !== index));
					}}
					{onconfirm}
				/>
			{/each}
			<div class="add-item">
				<button
					type="button"
					aria-label="{label} 항목 추가"
					disabled={disabled || valueDisabled}
					onclick={() => {
						if (Array.isArray(value)) onchange([...value, initialValueFor(item!)]);
					}}><Icon name="plus" size={13} />항목 추가</button
				>
			</div>
		{/if}
	{/if}
{/if}

<style>
	.field-row {
		display: grid;
		grid-template-columns: var(--state-columns);
		align-items: center;
		gap: 8px;
		min-height: 43px;
		padding: 5px 10px;
		border-bottom: 1px solid var(--border);
	}
	.field-row:hover {
		background: var(--surface);
	}
	.field-row.selected {
		background: var(--surface-active);
	}
	.field-name {
		display: flex;
		align-items: center;
		min-width: 0;
		padding-left: min(calc(var(--depth) * 15px), 90px);
		gap: 3px;
	}
	input:not([type='checkbox']),
	select {
		width: 100%;
		min-width: 0;
		border: 1px solid transparent;
		border-radius: 4px;
		background: transparent;
		color: var(--text);
		font: inherit;
		padding: 6px;
	}
	select {
		background: var(--background);
		border-color: var(--border);
		padding: 5px;
	}
	input:not([type='checkbox']):hover,
	input:not([type='checkbox']):focus {
		border-color: var(--border);
		background: var(--background);
	}
	input[type='checkbox'] {
		accent-color: var(--text-muted);
	}
	.initial-cell {
		min-width: 0;
	}
	.required-cell {
		text-align: center;
	}
	.row-actions {
		display: flex;
		gap: 2px;
	}
	button {
		color: var(--text);
		font: inherit;
		cursor: pointer;
	}
	.icon-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: transparent;
		border: 0;
		border-radius: 4px;
		padding: 5px;
		flex-shrink: 0;
	}
	.icon-button:hover,
	.icon-button[aria-pressed='true'] {
		background: var(--surface-active);
	}
	.delete {
		color: var(--text-muted);
	}
	button:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.expand span {
		display: flex;
		transform: rotate(-90deg);
	}
	.expand span.expanded {
		transform: none;
	}
	.indent {
		width: 23px;
		flex-shrink: 0;
	}
	.item-label,
	.muted {
		color: var(--text-muted);
	}
	.field-details {
		padding: 12px 16px;
		border-bottom: 1px solid var(--border);
		background: var(--surface);
	}
	.details-heading {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 12px;
	}
	.details-heading span {
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}
	.details-heading button {
		margin-left: auto;
	}
	.add-field {
		display: flex;
		align-items: center;
		gap: 5px;
		padding: 9px 10px 9px calc(13px + min(var(--depth) * 15px, 90px));
		border-bottom: 1px solid var(--border);
		color: var(--text-muted);
	}
	.add-field input {
		max-width: 240px;
		border-color: var(--border);
		background: var(--background);
	}
	.add-field button,
	.unknown-field button {
		border: 1px solid var(--border);
		background: var(--surface);
		padding: 5px 9px;
		border-radius: 4px;
		white-space: nowrap;
	}
	.empty-fields {
		color: var(--text-muted);
		padding: 24px 16px 12px;
		text-align: center;
	}
	.array-heading {
		padding: 10px 14px 6px calc(14px + min(var(--depth, 0) * 15px, 90px));
		color: var(--text);
		font-size: 11px;
	}
	.array-heading span {
		color: var(--text-muted);
		margin-left: 8px;
	}
	.type-label {
		color: var(--text-muted);
		padding: 0 6px;
	}
	.add-item {
		padding: 8px 14px;
		border-bottom: 1px solid var(--border);
	}
	.add-item button {
		display: flex;
		align-items: center;
		gap: 5px;
		background: transparent;
		border: 1px solid var(--border);
		padding: 5px 9px;
		border-radius: 4px;
	}
	.unknown-field {
		display: flex;
		gap: 10px;
		align-items: center;
		padding: 10px;
	}
</style>
