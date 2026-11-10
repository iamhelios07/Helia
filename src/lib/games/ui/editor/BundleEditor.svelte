<script lang="ts">
	import { onDestroy } from 'svelte';

	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';

	import {
		readAuthoringBundle,
		writeAuthoringBundle,
		type CodeDiagnostic,
		type SourceModule
	} from '../../code-authoring.js';
	import { MonacoProject } from './monaco-project.js';
	import SourceEditor from './SourceEditor.svelte';
	let {
		source,
		kind,
		stateTypes,
		disabled = false,
		onchange
	}: {
		source: string;
		kind: 'scripts' | 'ui';
		stateTypes: string;
		disabled?: boolean;
		onchange: (source: string) => void;
	} = $props();
	let selected = $state('');
	let moduleName = $state('');
	let error = $state('');
	let deleteTarget = $state<string | null>(null);
	let showTypes = $state(false);
	let parsed = $derived.by(() => {
		try {
			return { bundle: readAuthoringBundle(source, kind), error: '' };
		} catch (cause) {
			return {
				bundle: null,
				error: cause instanceof Error ? cause.message : '문서 형식이 올바르지 않아요.'
			};
		}
	});
	let bundle = $derived(parsed.bundle);
	let modules = $derived(bundle?.modules ?? {});
	let activeId = $derived(
		Object.hasOwn(modules, selected) ? selected : (Object.keys(modules)[0] ?? '')
	);
	let active = $derived(modules[activeId]);
	function sourcePath(id: string, language: string) {
		if (/\.(?:js|ts|jsx|tsx)$/.test(id)) {
			return id.replace(/\.jsx$/, '.tsx').replace(/\.js$/, '.ts');
		}
		return `${id}.${language === 'tsx' ? 'tsx' : 'ts'}`;
	}
	let projectFiles = $derived(
		Object.fromEntries(
			Object.entries(modules).map(([id, file]) => [sourcePath(id, file.language), file])
		)
	);
	const project = new MonacoProject();
	let diagnostics = $state<CodeDiagnostic[]>([]);
	function updateDiagnostics(items: CodeDiagnostic[]) {
		diagnostics = items.map((item) => ({
			...item,
			module:
				Object.entries(modules).find(
					([id, file]) => sourcePath(id, file.language) === item.module
				)?.[0] ?? item.module
		}));
	}
	$effect(() => {
		project.update(projectFiles, stateTypes, {}, updateDiagnostics);
	});
	onDestroy(() => project.dispose());
	let languages = $derived(kind === 'scripts' ? ['typescript'] : ['tsx', 'typescript']);
	function emit(next: Record<string, SourceModule>, entry?: string) {
		if (!bundle || disabled) {
			return;
		}
		const text = writeAuthoringBundle(bundle, kind, next, entry);
		try {
			readAuthoringBundle(text, kind);
			onchange(text);
			error = '';
		} catch (cause) {
			error = cause instanceof Error ? cause.message : '모듈을 수정하지 못했어요.';
		}
	}
	function edit(value: Partial<SourceModule>) {
		if (active) {
			emit({ ...modules, [activeId]: { ...active, ...value } });
		}
	}
	function createUI() {
		if (disabled) {
			return;
		}
		onchange(
			JSON.stringify(
				{
					version: 1,
					entry: 'main.tsx',
					modules: {
						'main.tsx': {
							language: 'tsx',
							source:
								"import { registerPanel, useGameState } from '@helia/ui';\n\nfunction Status() {\n  const state = useGameState();\n  return <pre>{JSON.stringify(state, null, 2)}</pre>;\n}\n\nexport default function initialize() {\n  return registerPanel({ id: 'status', title: '상태', component: Status });\n}\n"
						}
					}
				},
				null,
				2
			)
		);
	}
	function validateName(name: string) {
		if (
			!name.trim() ||
			['__proto__', 'constructor', 'prototype'].includes(name) ||
			(kind === 'ui' &&
				(!/^[\w][\w./-]{0,127}$/.test(name) ||
					['preact', 'preact/hooks'].includes(name) ||
					name.split('/').some((part) => !part || part === '.' || part === '..')))
		) {
			throw Error('사용할 수 없는 이름이에요.');
		}
		if (Object.hasOwn(modules, name)) {
			throw Error('같은 이름이 이미 있어요.');
		}
	}
	function addModule() {
		const name = moduleName.trim();
		try {
			validateName(name);
			emit({
				...modules,
				[name]: {
					language: kind === 'scripts' ? 'typescript' : 'tsx',
					source: kind === 'scripts' ? '// 게임 로직을 작성하세요.\n' : 'export {};\n'
				}
			});
			selected = name;
			moduleName = '';
		} catch (cause) {
			error = cause instanceof Error ? cause.message : '추가하지 못했어요.';
		}
	}
	function renameModule() {
		const name = moduleName.trim();
		if (name === activeId || !active) {
			return;
		}
		try {
			validateName(name);
			const next = Object.fromEntries(
				Object.entries(modules).map(([id, value]) => [id === activeId ? name : id, value])
			);
			emit(next, bundle?.value.entry === activeId ? name : undefined);
			selected = name;
			moduleName = '';
		} catch (cause) {
			error = cause instanceof Error ? cause.message : '이름을 변경하지 못했어요.';
		}
	}
	function removeModule() {
		if (!deleteTarget || disabled) {
			return;
		}
		const next = Object.fromEntries(Object.entries(modules).filter(([id]) => id !== deleteTarget));
		if (kind === 'ui' && Object.keys(next).length === 0) {
			onchange('null');
		} else {
			emit(next, bundle?.value.entry === deleteTarget ? Object.keys(next)[0] : undefined);
		}
		deleteTarget = null;
	}
</script>

<div class="bundle-editor">
	{#if parsed.error}
		<p role="alert">{parsed.error} JSON 보기에서 문서를 수정하면 코드 편집으로 돌아올 수 있어요.</p>
	{:else if !bundle}
		<div class="empty">
			<p>게임 화면을 Preact로 구성할 수 있어요.</p>
			<button type="button" {disabled} onclick={createUI}>UI 만들기</button>
		</div>
	{:else}
		<div class="toolbar">
			<label
				>모듈<select
					aria-label={kind === 'scripts' ? '스크립트 선택' : 'UI 모듈 선택'}
					value={activeId}
					{disabled}
					onchange={(event) => (selected = event.currentTarget.value)}
					>{#each Object.keys(modules) as id (id)}<option value={id}>{id}</option>{/each}</select
				></label
			>
			{#if active}<label
					>언어<select
						aria-label="코드 언어"
						value={active.language}
						{disabled}
						onchange={(event) => edit({ language: event.currentTarget.value })}
						>{#each languages as language (language)}<option value={language}>{language}</option
							>{/each}</select
					></label
				>{/if}
			{#if kind === 'ui'}<label
					>진입 모듈<select
						aria-label="UI 진입 모듈"
						value={String(bundle.value.entry)}
						{disabled}
						onchange={(event) => emit(modules, event.currentTarget.value)}
						>{#each Object.keys(modules) as id (id)}<option value={id}>{id}</option>{/each}</select
					></label
				>{/if}
			<button type="button" aria-pressed={showTypes} onclick={() => (showTypes = !showTypes)}
				>GameState.d.ts 자동</button
			>
		</div>
		<div class="module-actions">
			<input aria-label="모듈 이름" placeholder="새 모듈 이름" bind:value={moduleName} {disabled} />
			<button type="button" disabled={disabled || !moduleName.trim()} onclick={addModule}
				>추가</button
			>
			<button
				type="button"
				disabled={disabled || !active || !moduleName.trim()}
				onclick={renameModule}>이름 변경</button
			>
			<button type="button" disabled={disabled || !active} onclick={() => (deleteTarget = activeId)}
				>모듈 삭제</button
			>
		</div>
		{#if error}<p role="alert">{error}</p>{/if}
		{#if showTypes}<div class="types">
				<SourceEditor
					{project}
					path=".helia/GameState.d.ts"
					value={stateTypes}
					label="GameState.d.ts 소스"
					language="TypeScript"
					readonly
				/>
			</div>{/if}
		{#if active}<div class="code">
				<SourceEditor
					{project}
					path={sourcePath(activeId, active.language)}
					value={active.source}
					label={`${activeId} 코드`}
					language={active.language}
					{disabled}
					onchange={(value) => edit({ source: value })}
				/>
			</div>{:else}<p>첫 스크립트를 추가하세요.</p>{/if}
		<details class="diagnostics" open>
			<summary>코드 검사 · 스키마 기반 타입</summary>
			{#if diagnostics.length}<ul>
					{#each diagnostics as item, index (`${item.module}:${item.line}:${item.column}:${index}`)}<li
						>
							<code>{item.module}:{item.line}:{item.column}</code>
							{item.message}
						</li>{/each}
				</ul>{:else}<p>코드 검사에서 발견한 문제가 없어요.</p>{/if}
		</details>
		<p class="hint">
			GameState 타입은 import 없이 사용할 수 있어요.
			{#if kind === 'ui'}UI 모듈에서는 <code>import type {'{ GameState }'} from '@helia/state'</code
				>로도 사용할 수 있어요. 모듈 이름 변경 시 다른 모듈의 import 경로도 수정하세요.{/if}
		</p>
	{/if}
</div>
{#if deleteTarget}<ConfirmDialog
		title="모듈 삭제"
		message={`‘${deleteTarget}’ 모듈을 초안에서 삭제할까요? 연결된 import도 확인해주세요.`}
		{disabled}
		onconfirm={removeModule}
		oncancel={() => (deleteTarget = null)}
	/>{/if}

<style>
	.bundle-editor {
		display: flex;
		flex-direction: column;
		min-height: 100%;
		padding: 14px;
		gap: 12px;
	}
	.toolbar,
	.module-actions {
		display: flex;
		align-items: end;
		flex-wrap: wrap;
		gap: 8px;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 5px;
		font-size: 11px;
		color: var(--text-muted);
		min-width: 0;
	}
	select,
	input,
	button {
		color: var(--text);
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: 4px;
		padding: 6px 8px;
		font: inherit;
		max-width: 100%;
	}
	input {
		width: 180px;
		min-width: 80px;
		flex: 1;
	}
	button {
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.code {
		height: 380px;
		min-height: 160px;
		border: 1px solid var(--border);
	}
	.types {
		height: 150px;
		border: 1px solid var(--border);
	}
	.diagnostics {
		border-top: 1px solid var(--border);
		padding-top: 10px;
		font-size: 11px;
	}
	.diagnostics ul {
		max-height: 180px;
		overflow: auto;
		padding-left: 20px;
	}
	.diagnostics li {
		padding: 4px 0;
		overflow-wrap: anywhere;
	}
	.hint,
	.diagnostics p {
		color: var(--text-muted);
		font-size: 11px;
		line-height: 1.6;
		margin: 0;
	}
	p[role='alert'] {
		color: var(--danger, #ef9b9b);
		line-height: 1.6;
	}
	.empty {
		padding: 24px 0;
	}
</style>
