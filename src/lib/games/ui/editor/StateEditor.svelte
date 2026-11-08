<script lang="ts">
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
	import Icon from '#lib/components/Icon.svelte';

	import {
		editAuthoringSchema,
		readAuthoringSource,
		type SchemaEdit,
		type SchemaTrail
	} from '../../state/authoring.js';
	import { isStateObject, type StateValue } from '../../state/value.js';
	import StateFieldRow from './StateFieldRow.svelte';
	let {
		source,
		disabled = false,
		onchange
	}: {
		source: string;
		disabled?: boolean;
		onchange: (source: string) => void;
	} = $props();
	let selected = $state<string | null>(null);
	let parsed = $derived(readAuthoringSource(source));
	let error = $state('');
	let confirmation = $state('');
	let confirming = $state(false);
	let pending: (() => void) | null = null;
	function confirm(message: string, action: () => void) {
		if (disabled) {
			return;
		}
		confirmation = message;
		pending = action;
		confirming = true;
	}
	function edit(trail: SchemaTrail, change: SchemaEdit) {
		if (disabled || !parsed.document) {
			return false;
		}
		try {
			const next = editAuthoringSchema(parsed.document, trail, change);
			onchange(JSON.stringify(next, null, 2));
			error = '';
			return true;
		} catch (failure) {
			error = failure instanceof Error ? failure.message : String(failure);
			return false;
		}
	}
	function editState(value: StateValue | undefined) {
		if (disabled || !parsed.document || value === undefined || !isStateObject(value)) {
			return;
		}
		onchange(JSON.stringify({ ...parsed.document, initialState: value }, null, 2));
		error = '';
	}
</script>

<div class="state-editor" aria-label="시각적 상태 편집기">
	<div class="state-heading">
		<h2>상태 필드</h2>
		<span>필드 정의와 시작값</span><button
			type="button"
			aria-label="상태 문서 설정"
			aria-pressed={selected === '[]'}
			onclick={() => (selected = selected === '[]' ? null : '[]')}
			><Icon name="settings" size={14} />문서 설정</button
		>
	</div>
	{#if error}<p role="alert">{error}</p>{/if}
	{#if parsed.document}
		{#if parsed.validationError}<p role="alert">초기 상태 검사: {parsed.validationError}</p>{/if}
		<section class="field-table" aria-label="상태 필드 목록">
			<div class="columns" aria-hidden="true">
				<span>필드 이름</span><span>타입</span><span>초기값</span><span>필수</span><span></span>
			</div>
			<StateFieldRow
				schema={parsed.document.schema}
				value={parsed.document.initialState}
				root
				{selected}
				onselect={(label) => (selected = label)}
				{disabled}
				onedit={edit}
				onchange={editState}
				onconfirm={confirm}
			/>
		</section>
	{:else}
		<p role="alert">
			JSON을 시각적 편집기로 읽을 수 없어요. 원본은 보존되어 있습니다. JSON 보기에서 수정해주세요. {parsed.error}
		</p>
	{/if}
</div>
{#if confirming}<ConfirmDialog
		title="상태 변경 확인"
		message={confirmation}
		confirmLabel="변경"
		{disabled}
		oncancel={() => {
			confirming = false;
			pending = null;
		}}
		onconfirm={() => {
			const action = pending;
			confirming = false;
			pending = null;
			if (!disabled) {
				action?.();
			}
		}}
	/>{/if}

<style>
	.state-editor {
		height: 100%;
		min-width: 0;
		overflow: auto;
		padding: 0 0 16px;
		--state-columns: minmax(130px, 1fr) 85px minmax(130px, 1fr) 32px 52px;
	}
	.state-heading {
		display: flex;
		gap: 10px;
		align-items: center;
		padding: 12px 14px;
		min-width: 581px;
	}
	h2 {
		font-size: 13px;
		font-weight: 600;
		margin: 0;
	}
	.state-heading > span {
		color: var(--text-muted);
		font-size: 11px;
	}
	.state-heading button {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 5px;
		color: var(--text-muted);
		background: transparent;
		border: 0;
		padding: 4px;
		font: inherit;
		font-size: 11px;
		cursor: pointer;
	}
	.field-table {
		min-width: 581px;
	}
	.columns {
		display: grid;
		grid-template-columns: var(--state-columns);
		align-items: center;
		gap: 8px;
		padding: 8px 10px;
		background: var(--surface);
		border-top: 1px solid var(--border);
		border-bottom: 1px solid var(--border);
		color: var(--text-muted);
		font-size: 10px;
	}
	.columns span:nth-child(4) {
		text-align: center;
	}
	p[role='alert'] {
		margin: 10px 14px;
	}
</style>
