<script lang="ts">
	import { transformRegexText } from '../../regex-runtime.js';
	import {
		REGEX_STAGES,
		REGEX_STAGE_ROLES,
		type RegexRole,
		type RegexRule,
		type RegexStage
	} from '../../regex.js';
	import MessageContent from '../MessageContent.svelte';
	let { rules, stage }: { rules: RegexRule[]; stage: RegexStage } = $props();
	let input = $state('[손님: 엘렌]');
	let role = $state<RegexRole>('assistant');
	let target = $derived(REGEX_STAGE_ROLES[stage] ?? role);
	let result = $state<{ key: string; text: string; error: string } | null>(null);
	let busy = $state(false);
	let key = $derived(JSON.stringify({ rules, stage, role: target, input }));
	let current = $derived(result?.key === key ? result : null);
	async function test() {
		const requestKey = key;
		busy = true;
		try {
			const text = await transformRegexText(input, rules, { stage, role: target });
			result = { key: requestKey, text, error: '' };
		} catch (error) {
			result = {
				key: requestKey,
				text: '',
				error: error instanceof Error ? error.message : '규칙을 확인해주세요.'
			};
		} finally {
			busy = false;
		}
	}
</script>

<section aria-label="정규식 테스트">
	<h3>테스트</h3>
	<p>
		{REGEX_STAGES.find((s) => s.id === stage)?.label} 규칙을 목록 순서대로 실행해요. 게임과 채팅에는 저장되지
		않아요.
	</p>
	<label
		>테스트 대상<select
			value={target}
			disabled={!!REGEX_STAGE_ROLES[stage]}
			onchange={(e) => (role = e.currentTarget.value as RegexRole)}
			><option value="user">사용자</option><option value="assistant">AI</option></select
		></label
	>
	<label>테스트 입력<textarea rows="4" bind:value={input}></textarea></label>
	<button type="button" disabled={busy} onclick={test}>{busy ? '테스트 중…' : '테스트 실행'}</button
	>
	{#if current}
		{#if current.error}<p role="alert">{current.error}</p>
		{:else}
			<label>변환 결과<textarea rows="4" readonly value={current.text}></textarea></label>
			{#if stage === 'display'}<div class="preview" aria-label="렌더링 미리보기">
					<MessageContent content={current.text} />
				</div>{/if}
		{/if}
	{/if}
</section>

<style>
	section {
		display: grid;
		gap: 12px;
		margin-top: 24px;
		padding-top: 20px;
		border-top: 1px solid var(--border);
	}
	h3,
	p {
		margin: 0;
	}
	p {
		color: var(--text-muted);
		font-size: 12px;
		line-height: 1.6;
	}
	label {
		display: grid;
		gap: 6px;
		font-size: 13px;
	}
	textarea,
	select {
		box-sizing: border-box;
		width: 100%;
		padding: 9px;
		color: var(--text);
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 6px;
		font: inherit;
	}
	textarea {
		resize: vertical;
		font-family: monospace;
	}
	button {
		justify-self: start;
		padding: 8px 12px;
		color: var(--text);
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 6px;
		cursor: pointer;
	}
	.preview {
		min-width: 0;
		padding: 12px;
		border: 1px solid var(--border);
		border-radius: 6px;
	}
	[role='alert'] {
		color: var(--danger, #e47878);
	}
</style>
