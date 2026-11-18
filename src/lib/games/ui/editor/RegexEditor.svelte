<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import ItemActions from '#lib/components/ItemActions.svelte';

	import {
		createRegexRule,
		readRegexRules,
		regexProblem,
		REGEX_STAGES,
		REGEX_STAGE_ROLES,
		type RegexRole,
		type RegexRule
	} from '../../regex.js';
	import RegexPreview from './RegexPreview.svelte';
	let {
		source,
		disabled = false,
		onchange
	}: { source: string; disabled?: boolean; onchange: (value: string) => void } = $props();
	let selectedId = $state<string | null>(null);
	let rules = $derived.by(() => {
		try {
			return readRegexRules(JSON.parse(source));
		} catch {
			return null;
		}
	});
	let selected = $derived(rules?.find((r) => r.id === selectedId) ?? rules?.[0] ?? null);
	let index = $derived(rules?.findIndex((r) => r.id === selected?.id) ?? -1);
	let problem = $derived(selected ? regexProblem(selected) : '');
	function commit(next: RegexRule[]) {
		if (!disabled) {
			onchange(JSON.stringify(next, null, 2));
		}
	}
	function update(patch: Partial<RegexRule>) {
		if (selected && rules) {
			commit(rules.map((r) => (r.id === selected?.id ? { ...r, ...patch } : r)));
		}
	}
	function add() {
		const rule = createRegexRule();
		commit([...(rules ?? []), rule]);
		selectedId = rule.id;
	}
	function remove() {
		if (rules && selected) {
			commit(rules.filter((r) => r.id !== selected?.id));
			selectedId = rules[index - 1]?.id ?? null;
		}
	}
	function move(offset: number) {
		if (!rules || index + offset < 0 || index + offset >= rules.length) {
			return;
		}
		const next = [...rules];
		selectedId = selected?.id ?? null;
		[next[index], next[index + offset]] = [next[index + offset], next[index]];
		commit(next);
	}
	function toggleRole(role: RegexRole, checked: boolean) {
		if (!selected) {
			return;
		}
		update({
			roles: checked ? [...selected.roles, role] : selected.roles.filter((r) => r !== role)
		});
	}
	function changeStage(stage: RegexRule['stage']) {
		const role = REGEX_STAGE_ROLES[stage];
		update({ stage, roles: role ? [role] : (selected?.roles ?? ['assistant']) });
	}
</script>

<div class="regex-editor" aria-label="정규식 편집기">
	<header>
		<h2>정규식</h2>
		<p>채팅 텍스트를 검색하고 치환해요. 규칙은 위에서 아래 순서로 실행돼요.</p>
	</header>
	{#if rules === null}
		<p role="alert">정규식 목록을 읽을 수 없어요. JSON으로 편집에서 형식을 수정해주세요.</p>
	{:else}
		<div class="workspace">
			<aside aria-label="정규식 규칙 목록">
				<button type="button" class="add" disabled={disabled || rules.length >= 100} onclick={add}
					><Icon name="plus" size={14} />규칙 추가</button
				>
				{#each rules as rule (rule.id)}
					<button
						type="button"
						class={['rule', { selected: rule.id === selected?.id }]}
						aria-pressed={rule.id === selected?.id}
						onclick={() => (selectedId = rule.id)}
					>
						<span>{rule.name || '이름 없는 규칙'}</span><small
							>{REGEX_STAGES.find((s) => s.id === rule.stage)?.label}{rule.enabled
								? ''
								: ' · 꺼짐'}</small
						>
					</button>
				{/each}
				{#if !rules.length}<p class="empty">규칙을 추가해 시작하세요.</p>{/if}
			</aside>
			{#if selected}
				<div class="detail">
					<fieldset {disabled}>
						<div class="tools">
							<label class="check"
								><input
									type="checkbox"
									checked={selected.enabled}
									onchange={(e) => update({ enabled: e.currentTarget.checked })}
								/>사용</label
							>
							<button
								type="button"
								aria-label="규칙 위로 이동"
								disabled={disabled || index === 0}
								onclick={() => move(-1)}>↑</button
							>
							<button
								type="button"
								aria-label="규칙 아래로 이동"
								disabled={disabled || index === rules.length - 1}
								onclick={() => move(1)}>↓</button
							>
							<ItemActions
								name={selected.name || '이름 없는 규칙'}
								{disabled}
								onrenamevalue={(name) => update({ name })}
								ondelete={remove}
								deleteMessage={`‘${selected.name || '이름 없는 규칙'}’ 규칙을 삭제할까요?`}
							/>
						</div>
						<label
							>규칙 이름<input
								value={selected.name}
								oninput={(e) => update({ name: e.currentTarget.value })}
							/></label
						>
						<label
							>적용 단계<select
								value={selected.stage}
								onchange={(e) => changeStage(e.currentTarget.value as RegexRule['stage'])}
								>{#each REGEX_STAGES as stage (stage.id)}<option value={stage.id}
										>{stage.label}</option
									>{/each}</select
							></label
						>
						<p class="help">{REGEX_STAGES.find((s) => s.id === selected?.stage)?.help}</p>
						<div class="roles">
							<span>대상 메시지</span
							>{#each [{ id: 'user', label: '사용자' }, { id: 'assistant', label: 'AI' }] as role (role.id)}<label
									class="check"
									><input
										type="checkbox"
										checked={selected.roles.includes(role.id as RegexRole)}
										disabled={disabled ||
											!!REGEX_STAGE_ROLES[selected.stage] ||
											(selected.roles.length === 1 &&
												selected.roles.includes(role.id as RegexRole))}
										onchange={(e) => toggleRole(role.id as RegexRole, e.currentTarget.checked)}
									/>{role.label}</label
								>{/each}
						</div>
						<label
							>검색식 (IN)<textarea
								rows="3"
								spellcheck="false"
								value={selected.pattern}
								oninput={(e) => update({ pattern: e.currentTarget.value })}
								placeholder="\\[손님: (.*?)\\]"></textarea></label
						>
						<label
							>치환문 (OUT)<textarea
								rows="4"
								spellcheck="false"
								value={selected.replacement}
								oninput={(e) => update({ replacement: e.currentTarget.value })}></textarea></label
						>
						<label
							>플래그<input
								spellcheck="false"
								value={selected.flags}
								oninput={(e) => update({ flags: e.currentTarget.value })}
								placeholder="g"
							/></label
						>
						<p class="help">
							검색식은 / 없이 입력해요. g: 전체 치환 · i: 대소문자 무시 · m: 여러 줄. 치환문에 $1,
							$2, $&amp;를 사용할 수 있어요.
						</p>
						{#if problem}<p role="alert">{problem}</p>{/if}
					</fieldset>
					<RegexPreview {rules} stage={selected.stage} />
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.regex-editor {
		padding: 24px;
		color: var(--text);
	}
	header {
		margin-bottom: 20px;
	}
	h2 {
		margin: 0 0 8px;
		font-size: 18px;
	}
	header p,
	.help,
	.empty {
		color: var(--text-muted);
		font-size: 12px;
		line-height: 1.6;
	}
	.workspace {
		display: grid;
		grid-template-columns: minmax(150px, 200px) minmax(0, 1fr);
		gap: 20px;
	}
	aside {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		padding: 8px 10px;
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--text);
		background: var(--surface);
		cursor: pointer;
		font: inherit;
		font-size: 12px;
	}
	button:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.rule {
		align-items: stretch;
		flex-direction: column;
		text-align: left;
		overflow-wrap: anywhere;
	}
	.rule small {
		color: var(--text-muted);
		font-size: 11px;
	}
	.rule.selected {
		border-color: var(--accent);
		background: var(--surface-hover);
	}
	.detail {
		min-width: 0;
	}
	fieldset {
		display: grid;
		gap: 12px;
		margin: 0;
		padding: 0;
		border: 0;
		min-width: 0;
	}
	label {
		display: grid;
		gap: 6px;
		font-size: 13px;
	}
	input:not([type='checkbox']),
	textarea,
	select {
		box-sizing: border-box;
		width: 100%;
		padding: 9px;
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--text);
		background: var(--surface);
		font: inherit;
	}
	textarea {
		resize: vertical;
		font-family: monospace;
	}
	.tools,
	.roles,
	.check {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.roles {
		flex-wrap: wrap;
		font-size: 13px;
	}
	.tools .check {
		margin-right: auto;
	}
	.help {
		margin: 0;
	}
	[role='alert'] {
		margin: 0;
		color: var(--danger, #e47878);
		font-size: 12px;
		overflow-wrap: anywhere;
	}
	@media (max-width: 700px) {
		.regex-editor {
			padding: 16px;
		}
		.workspace {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
