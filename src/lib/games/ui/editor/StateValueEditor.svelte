<script lang="ts">
	import StateValueEditor from './StateValueEditor.svelte';
	import { allowsNull, arrayItem, initialValueFor, objectShape } from '../../state/authoring.js';
	import { schemaType, validateValue, type ValueSchema } from '../../state/schema.js';
	import { isStateObject, sameValue, type StateValue } from '../../state/value.js';
	let {
		schema,
		value,
		label = '상태',
		optional = false,
		compact = false,
		disabled = false,
		onchange,
		onconfirm
	}: {
		schema: ValueSchema;
		value: StateValue | undefined;
		label?: string;
		optional?: boolean;
		compact?: boolean;
		disabled?: boolean;
		onchange: (value: StateValue | undefined) => void;
		onconfirm: (message: string, action: () => void) => void;
	} = $props();
	let type = $derived(schemaType(schema));
	let object = $derived(objectShape(schema));
	let itemSchema = $derived(arrayItem(schema));
	let invalid = $derived.by(() => {
		if (value === undefined) return false;
		try {
			validateValue(schema, value, 'initial');
			return false;
		} catch {
			return true;
		}
	});
	function child(name: string, next: StateValue | undefined) {
		if (value === undefined || !isStateObject(value)) return;
		const updated = { ...value };
		if (next === undefined) delete updated[name];
		else updated[name] = next;
		onchange(updated);
	}
</script>

<fieldset class={['value-node', { compact }]} {disabled}>
	<legend>{schema.title ?? label} <span>{schema.title ? label : ''}</span></legend>
	{#if schema.description && !compact}<p>{schema.description}</p>{/if}
	{#if optional}
		<label class="check"
			><input
				type="checkbox"
				aria-label="{label} 초기값 포함"
				checked={value !== undefined}
				onchange={(event) => {
					const included = event.currentTarget.checked;
					event.currentTarget.checked = value !== undefined;
					if (included) onchange(initialValueFor(schema));
					else
						onconfirm(`${label} 초기값을 제거할까요? 필드 정의는 유지됩니다.`, () =>
							onchange(undefined)
						);
				}}
			/>{compact ? '포함' : '초기값 포함'}</label
		>
	{/if}
	{#if value === undefined}
		{#if !optional}<p role="alert">필수 초기값이 없어요.</p>
			<button type="button" onclick={() => onchange(initialValueFor(schema))}>시작값 넣기</button
			>{/if}
	{:else if schema.enum}
		<label
			>초기값<select
				aria-label="{label} 초기값"
				value={schema.enum.findIndex((option) => sameValue(option, value!))}
				onchange={(event) =>
					onchange(structuredClone(schema.enum![Number(event.currentTarget.value)]))}
			>
				{#if invalid}<option value="-1" disabled>허용값 밖의 값: {JSON.stringify(value)}</option
					>{/if}
				{#each schema.enum as option, index (JSON.stringify(option))}<option value={index}
						>{JSON.stringify(option)}</option
					>{/each}
			</select></label
		>
	{:else}
		{#if allowsNull(schema) && type !== 'null'}
			<label class="check"
				><input
					type="checkbox"
					aria-label="{label} null 초기값"
					checked={value === null}
					onchange={(event) => {
						const useNull = event.currentTarget.checked;
						event.currentTarget.checked = value === null;
						if (useNull) onconfirm(`${label} 초기값을 null로 바꿀까요?`, () => onchange(null));
						else onchange(initialValueFor(schema));
					}}
				/>null</label
			>
		{/if}
		{#if value === null && allowsNull(schema)}<span class="null-value">null</span>
		{:else if object && isStateObject(value)}
			{#if compact}<span class="value-summary">{Object.keys(value).length}개 필드</span>{:else}
				{#each Object.entries(object.properties) as [name, childSchema] (name)}
					<StateValueEditor
						schema={childSchema}
						value={Object.hasOwn(value, name) ? value[name] : undefined}
						label={`${label}.${name}`}
						optional={!object.required?.includes(name)}
						{disabled}
						onchange={(next) => child(name, next)}
						{onconfirm}
					/>
				{/each}
				{#each Object.keys(value).filter((name) => !Object.hasOwn(object!.properties, name)) as name (name)}
					<p role="alert">정의되지 않은 필드: {name}</p>
					<button
						type="button"
						aria-label="{label}.{name} 알 수 없는 초기값 삭제"
						onclick={() =>
							onconfirm(`${label}.${name} 초기값을 삭제할까요?`, () => child(name, undefined))}
						>초기값 삭제</button
					>
				{/each}
			{/if}
		{:else if itemSchema && Array.isArray(value)}
			{#if compact}<span class="value-summary">{value.length}개 항목</span>{:else}
				{#each value as item, index (index)}
					<div class="array-item">
						<StateValueEditor
							schema={itemSchema}
							value={item}
							label={`${label}[${index}]`}
							{disabled}
							onchange={(next) => {
								if (Array.isArray(value) && next !== undefined)
									onchange(value.map((old, i) => (i === index ? next : old)));
							}}
							{onconfirm}
						/>
						<button
							type="button"
							aria-label="{label}[{index}] 항목 삭제"
							onclick={() =>
								onconfirm(`${label}[${index}] 항목을 삭제할까요?`, () => {
									if (Array.isArray(value)) onchange(value.filter((_, i) => i !== index));
								})}>항목 삭제</button
						>
					</div>
				{/each}
				<button
					type="button"
					aria-label="{label} 항목 추가"
					onclick={() => {
						if (Array.isArray(value)) onchange([...value, initialValueFor(itemSchema!)]);
					}}>항목 추가</button
				>
			{/if}
		{:else if type === 'string' && typeof value === 'string'}
			<label
				>초기값<input
					aria-label="{label} 초기값"
					{value}
					oninput={(event) => onchange(event.currentTarget.value)}
				/></label
			>
		{:else if (type === 'number' || type === 'integer') && typeof value === 'number'}
			<label
				>초기값<input
					type="number"
					aria-label="{label} 초기값"
					step={type === 'integer' ? '1' : 'any'}
					{value}
					oninput={(event) => {
						const next = event.currentTarget.valueAsNumber;
						if (Number.isFinite(next) && (type !== 'integer' || Number.isInteger(next)))
							onchange(next);
					}}
					onblur={(event) => {
						const next = event.currentTarget.valueAsNumber;
						if (!Number.isFinite(next) || (type === 'integer' && !Number.isInteger(next)))
							event.currentTarget.value = String(value);
					}}
				/></label
			>
		{:else if type === 'boolean' && typeof value === 'boolean'}
			<label
				>초기값<select
					aria-label="{label} 초기값"
					value={String(value)}
					onchange={(event) => onchange(event.currentTarget.value === 'true')}
					><option value="true">참</option><option value="false">거짓</option></select
				></label
			>
		{:else}
			<p role="alert">타입과 일치하지 않는 초기값: {JSON.stringify(value)}</p>
			<button
				type="button"
				onclick={() =>
					onconfirm(`${label} 초기값을 시작값으로 바꿀까요?`, () =>
						onchange(initialValueFor(schema))
					)}>시작값으로 바꾸기</button
			>
		{/if}
	{/if}
	{#if invalid}<p class="warning">
			현재 초기값이 스키마와 일치하지 않아요. 값을 수정하거나 JSON에서 확인해주세요.
		</p>{/if}
</fieldset>

<style>
	.value-node.compact {
		border: 0;
		border-radius: 0;
		padding: 0;
		margin: 0;
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
	}
	.compact legend {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	.compact label:not(.check) {
		font-size: 0;
		gap: 0;
		min-width: 50px;
		flex: 1;
	}
	.compact input:not([type='checkbox']),
	.compact select {
		font-size: 12px;
		padding: 5px 6px;
	}
	.compact .check {
		font-size: 10px;
		gap: 2px;
		margin: 0;
		color: var(--text-muted);
	}
	.compact .check input {
		margin: 0;
	}
	.compact p,
	.compact .warning {
		font-size: 10px;
		margin: 2px 0;
	}
	.value-summary {
		font-size: 11px;
		color: var(--text-muted);
	}
	.value-node {
		min-width: 0;
		border: 1px solid var(--border);
		border-radius: 5px;
		margin: 10px 0;
		padding: 12px;
	}
	legend {
		overflow-wrap: anywhere;
	}
	legend span,
	p,
	.null-value {
		color: var(--text-muted);
	}
	p {
		line-height: 1.5;
	}
	label {
		display: grid;
		gap: 6px;
	}
	.check {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 8px;
	}
	input:not([type='checkbox']),
	select {
		width: 100%;
		min-width: 0;
		padding: 7px;
		background: var(--background);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: 4px;
		font: inherit;
	}
	button {
		border: 1px solid var(--border);
		background: var(--surface);
		color: var(--text);
		padding: 6px 9px;
		border-radius: 4px;
		font: inherit;
		cursor: pointer;
	}
	.array-item {
		border-left: 2px solid var(--border);
		padding-left: 10px;
		margin-bottom: 12px;
	}
	.warning {
		color: var(--text-muted);
	}
	button:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
