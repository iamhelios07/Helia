<script lang="ts">
	import { allowsNull, type SchemaEdit, type SchemaTrail } from '../../state/authoring.js';
	import { schemaType, type ValueSchema } from '../../state/schema.js';
	import { parseStateValue } from '../../state/value.js';
	let {
		schema,
		trail,
		label,
		disabled = false,
		onedit,
		onconfirm
	}: {
		schema: ValueSchema;
		trail: SchemaTrail;
		label: string;
		disabled?: boolean;
		onedit: (trail: SchemaTrail, edit: SchemaEdit) => boolean;
		onconfirm: (message: string, action: () => void) => void;
	} = $props();
	const uid = $props.id();
	let enumInput = $state<string | null>(null);
	let enumError = $state('');
	function edit(change: SchemaEdit) {
		return onedit(trail, change);
	}
	function applyEnum() {
		try {
			const text = (enumInput ?? (schema.enum ? JSON.stringify(schema.enum, null, 2) : '')).trim();
			const values = text ? parseStateValue(JSON.parse(text)) : undefined;
			if (values !== undefined && !Array.isArray(values))
				throw new Error('허용값을 JSON 배열로 입력해주세요.');
			if (edit({ kind: 'enum', values })) {
				enumInput = null;
				enumError = '';
			}
		} catch (error) {
			enumError = error instanceof Error ? error.message : String(error);
		}
	}
</script>

<fieldset {disabled}>
	<legend class="sr-only">{label} 부가 설정</legend>
	<div class="annotations">
		<label for="{uid}-title">표시 이름</label><input
			id="{uid}-title"
			aria-label="{label} 표시 이름"
			value={schema.title ?? ''}
			placeholder="화면에 표시할 이름"
			oninput={(event) =>
				edit({ kind: 'metadata', key: 'title', value: event.currentTarget.value })}
		/>
		<label for="{uid}-description">설명</label><textarea
			id="{uid}-description"
			aria-label="{label} 필드 설명"
			rows="2"
			value={schema.description ?? ''}
			placeholder="이 필드의 용도"
			oninput={(event) =>
				edit({ kind: 'metadata', key: 'description', value: event.currentTarget.value })}
		></textarea>
	</div>
	{#if trail.length && schemaType(schema) !== 'null'}
		<label class="check"
			><input
				type="checkbox"
				aria-label="{label} null 허용"
				checked={allowsNull(schema)}
				onchange={(event) => {
					const enabled = event.currentTarget.checked;
					event.currentTarget.checked = allowsNull(schema);
					if (!enabled)
						onconfirm(
							`${label}의 null 허용을 해제하면 null 초기값을 시작값으로 바꿉니다. 계속할까요?`,
							() => edit({ kind: 'nullable', enabled })
						);
					else edit({ kind: 'nullable', enabled });
				}}
			/>null 허용 <span>null 값을 허용합니다.</span></label
		>
	{/if}
	<details>
		<summary>허용값 제한{schema.enum ? ` (${schema.enum.length}개)` : ''}</summary>
		<p>허용할 값을 JSON 배열로 입력하세요. 빈칸으로 적용하면 제한을 없앱니다.</p>
		<textarea
			aria-label="{label} 허용값"
			rows="3"
			value={enumInput ?? (schema.enum ? JSON.stringify(schema.enum, null, 2) : '')}
			oninput={(event) => {
				enumInput = event.currentTarget.value;
			}}></textarea>
		<button type="button" onclick={applyEnum}>허용값 적용</button>
		{#if enumError}<p role="alert">{enumError}</p>{/if}
	</details>
</fieldset>

<style>
	fieldset {
		min-width: 0;
		border: 0;
		padding: 0;
		margin: 0;
	}
	.annotations {
		display: grid;
		grid-template-columns: 70px minmax(0, 1fr);
		gap: 8px 12px;
		align-items: center;
	}
	input:not([type='checkbox']),
	textarea {
		width: 100%;
		min-width: 0;
		border: 1px solid var(--border);
		background: var(--background);
		color: var(--text);
		border-radius: 4px;
		padding: 7px;
		font: inherit;
	}
	.check {
		display: flex;
		align-items: center;
		gap: 6px;
		margin: 12px 0;
	}
	.check span,
	p {
		color: var(--text-muted);
	}
	details {
		margin-top: 12px;
	}
	summary {
		cursor: pointer;
	}
	p {
		line-height: 1.6;
	}
	button {
		background: var(--background);
		color: var(--text);
		border: 1px solid var(--border);
		padding: 6px 10px;
		border-radius: 4px;
		font: inherit;
		cursor: pointer;
		margin-top: 6px;
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
</style>
