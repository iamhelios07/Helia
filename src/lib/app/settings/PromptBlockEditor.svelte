<script lang="ts">
	import { untrack } from 'svelte';

	import { PROMPT_TYPES, type PromptBlock } from '#lib/games/ai/prompts.js';

	import { PROMPT_TYPE_LABELS } from './prompt-labels.js';
	let { block = $bindable() }: { block: PromptBlock } = $props();
	const uid = $props.id();
	let chatAdvanced = $state(
		untrack(
			() =>
				(block.rangeStart !== undefined && block.rangeStart !== 0) ||
				typeof block.rangeEnd === 'number'
		)
	);
	let usesText = $derived(
		['plain', 'jailbreak', 'cot', 'chatML', 'persona', 'postEverything'].includes(block.type)
	);
	let usesSlot = $derived(
		['persona', 'postEverything', 'description', 'lorebook', 'memory', 'authornote'].includes(
			block.type
		)
	);
	function setType(type: PromptBlock['type']) {
		block.type = type;
		if (type !== 'cache' && block.role === 'all') {
			block.role = undefined;
		}
	}
</script>

<div class="block-fields">
	<label for={`${uid}-name`}
		>이름
		<input
			id={`${uid}-name`}
			bind:value={() => block.name ?? '', (value: string) => (block.name = value || undefined)}
			autocomplete="off"
		/>
	</label>
	<label for={`${uid}-type`}
		>타입
		<select id={`${uid}-type`} bind:value={() => block.type, setType}>
			{#each PROMPT_TYPES as type (type)}<option value={type}>{PROMPT_TYPE_LABELS[type]}</option
				>{/each}
		</select>
	</label>
	{#if ['plain', 'jailbreak', 'cot'].includes(block.type)}
		<label for={`${uid}-type2`}
			>특수 타입
			<select
				id={`${uid}-type2`}
				bind:value={
					() => block.type2 ?? 'normal', (value: PromptBlock['type2']) => (block.type2 = value)
				}
			>
				<option value="normal">특수 타입 없음</option><option value="main">메인 프롬프트</option
				><option value="globalNote">글로벌 노트</option>
			</select>
		</label>
	{/if}
	{#if usesText}
		<label for={`${uid}-text`}
			>프롬프트
			<textarea
				id={`${uid}-text`}
				bind:value={() => block.text ?? '', (value: string) => (block.text = value)}
				rows="6"
				spellcheck="false"></textarea>
		</label>
	{:else if block.type === 'chat'}
		<label class="check"><input type="checkbox" bind:checked={chatAdvanced} />고급</label>
		{#if chatAdvanced}
			<label for={`${uid}-start`}
				>범위 시작<input
					id={`${uid}-start`}
					type="number"
					min="-100000"
					max="100000"
					step="1"
					bind:value={block.rangeStart}
					placeholder="0"
				/></label
			>
			<label for={`${uid}-end`}
				>범위 끝<input
					id={`${uid}-end`}
					type="number"
					min="-100000"
					max="100000"
					step="1"
					disabled={block.rangeEnd === 'end' || block.rangeEnd === undefined}
					value={typeof block.rangeEnd === 'number' ? block.rangeEnd : ''}
					oninput={(event) =>
						(block.rangeEnd =
							event.currentTarget.value === '' ? undefined : event.currentTarget.valueAsNumber)}
				/></label
			>
			<label class="check"
				><input
					type="checkbox"
					checked={block.rangeEnd === 'end' || block.rangeEnd === undefined}
					onchange={(event) => (block.rangeEnd = event.currentTarget.checked ? 'end' : 0)}
				/>채팅 끝까지</label
			>
			<label class="check"
				><input
					type="checkbox"
					bind:checked={
						() => block.chatAsOriginalOnSystem ?? false,
						(value: boolean) => (block.chatAsOriginalOnSystem = value)
					}
				/>기존 역할로 보내기</label
			>
			<p class="help">
				시작은 포함하고 끝은 제외해요. 음수는 최근 대화부터 세며, -1은 마지막 대화예요.
			</p>
		{/if}
	{:else if block.type === 'cache'}
		<label for={`${uid}-depth`}
			>깊이<input
				id={`${uid}-depth`}
				type="number"
				min="0"
				max="100000"
				step="1"
				bind:value={block.depth}
				placeholder="1"
			/></label
		>
		<p class="help">앞에 있는 메시지를 선택한 역할에 따라 최근 순서로 지정한 개수만큼 캐시해요.</p>
	{/if}
	{#if usesSlot}
		<label class="check"
			><input
				type="checkbox"
				checked={block.innerFormat !== undefined}
				onchange={(event) =>
					(block.innerFormat = event.currentTarget.checked ? '{{slot}}' : undefined)}
			/>커스텀 내부 포맷</label
		>
		{#if block.innerFormat !== undefined}
			<label for={`${uid}-format`}
				>내부 포맷<textarea
					id={`${uid}-format`}
					bind:value={block.innerFormat}
					rows="3"
					placeholder={'{{slot}}'}
					spellcheck="false"></textarea></label
			>
			<p class="help">{'{{slot}}'} 자리에 해당 내용이 들어가요.</p>
		{/if}
		{#if block.type === 'authornote'}<label for={`${uid}-default`}
				>기본 프롬프트<textarea
					id={`${uid}-default`}
					bind:value={() => block.defaultText ?? '', (value: string) => (block.defaultText = value)}
					rows="3"></textarea></label
			>{/if}
	{/if}
	{#if block.type !== 'chat' && block.type !== 'chatML'}
		<label for={`${uid}-role`}
			>역할
			<select
				id={`${uid}-role`}
				bind:value={
					() => (block.role === 'assistant' ? 'bot' : (block.role ?? 'system')),
					(value: PromptBlock['role']) => (block.role = value)
				}
			>
				<option value="system">시스템 프롬프트</option><option value="user">유저</option><option
					value="bot">캐릭터</option
				>
				{#if block.type === 'cache'}<option value="all">모두</option>{/if}
			</select>
		</label>
	{/if}
</div>

<style>
	.block-fields {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 12px;
		padding: 18px;
	}
	label {
		display: grid;
		gap: 6px;
		color: var(--text);
		font-size: 12px;
		line-height: 1.6;
		min-width: 0;
	}
	input,
	select,
	textarea {
		box-sizing: border-box;
		width: 100%;
		min-width: 0;
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		padding: 10px 12px;
		background: var(--background);
		color: var(--text-strong);
		font: inherit;
		font-size: 12px;
	}
	textarea {
		resize: vertical;
		line-height: 1.65;
	}
	input:focus,
	select:focus,
	textarea:focus {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	input:disabled {
		opacity: 0.45;
	}
	.check {
		display: flex;
		align-items: center;
		gap: 9px;
	}
	.check input {
		width: 15px;
		height: 15px;
		flex-shrink: 0;
		margin: 0;
		accent-color: var(--accent);
	}
	.help {
		margin: 0;
		color: var(--text-muted);
		font-size: 11px;
		line-height: 1.7;
	}
	@media (max-width: 600px) {
		.block-fields {
			padding: 14px;
		}
	}
</style>
