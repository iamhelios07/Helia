<script lang="ts">
	import { SvelteMap } from 'svelte/reactivity';

	import Icon from '#lib/components/Icon.svelte';
	import { parseGameAIContent, type LoreEntry } from '#lib/games/ai/prompts.js';

	let {
		source,
		disabled = false,
		onchange
	}: {
		source: string;
		disabled?: boolean;
		onchange: (value: string) => void;
	} = $props();

	let selectedId = $state<string | null>(null);
	let expandedFolders = $state.raw<string[]>([]);
	let renamingFolder = $state<string | null>(null);
	let renamingValue = $state('');

	let content = $derived.by(() => {
		try {
			return parseGameAIContent(JSON.parse(source));
		} catch {
			return null;
		}
	});
	let entries = $derived(content?.lorebook ?? null);
	let folders = $derived.by(() => {
		const groups = new SvelteMap<string, LoreEntry[]>();
		for (const entry of entries ?? []) {
			const key = entry.folder ?? '';
			const list = groups.get(key) ?? [];
			list.push(entry);
			groups.set(key, list);
		}
		// Declared folders stay visible even when empty.
		for (const name of content?.folders ?? []) {
			if (!groups.has(name)) {
				groups.set(name, []);
			}
		}
		return [...groups.entries()]
			.sort(([a], [b]) => a.localeCompare(b, 'ko-KR'))
			.map(([folder, items]) => ({ folder, items: items.map(stableEntry) }));
	});
	let selected = $derived(entries?.find((entry) => entryKey(entry) === selectedId) ?? null);

	function entryKey(entry: LoreEntry): string {
		return entry.id ?? `${entry.name ?? ''}:${entry.keys.join(',')}:${entry.content.slice(0, 32)}`;
	}
	function stableEntry(entry: LoreEntry): LoreEntry {
		return { ...entry };
	}
	function commit(next: LoreEntry[], declaredFolders?: string[]) {
		if (content === null || disabled) {
			return;
		}
		// A folder survives with zero entries only if it was declared before this change.
		const filled = new Set(next.map((entry) => entry.folder ?? ''));
		const emptyFolders = (declaredFolders ?? content.folders ?? []).filter(
			(name) => !filled.has(name)
		);
		onchange(
			JSON.stringify(
				{
					version: 1,
					lorebook: next,
					...(emptyFolders.length ? { folders: emptyFolders } : {})
				},
				null,
				2
			)
		);
	}
	function createFolder(name: string) {
		if (content === null || disabled) {
			return;
		}
		const declared = new Set(content.folders ?? []);
		if (declared.has(name)) {
			return;
		}
		commit(entries ?? [], [...declared, name]);
		expandedFolders = [...expandedFolders, name];
	}
	function addEntry(folder: string) {
		if (entries === null || disabled) {
			return;
		}
		const entry: LoreEntry = {
			id: crypto.randomUUID(),
			name: '새 로어',
			...(folder ? { folder } : {}),
			keys: [],
			content: '',
			order: 0,
			always: false,
			enabled: true
		};
		commit([...entries, entry]);
		selectedId = entry.id ?? '';
		if (folder && !expandedFolders.includes(folder)) {
			expandedFolders = [...expandedFolders, folder];
		}
	}
	function removeEntry(target: LoreEntry) {
		if (entries === null || disabled) {
			return;
		}
		commit(entries.filter((entry) => entryKey(entry) !== entryKey(target)));
		if (selectedId === entryKey(target)) {
			selectedId = null;
		}
	}
	function updateSelected(patch: Partial<LoreEntry>) {
		if (entries === null || selected === null || disabled) {
			return;
		}
		commit(
			entries.map((entry) =>
				entryKey(entry) === entryKey(selected) ? { ...entry, ...patch } : entry
			)
		);
	}
	let draggingKey = $state<string | null>(null);

	function handleDrop(target: LoreEntry) {
		if (!draggingKey || entries === null || disabled) {
			return;
		}
		const from = entries.findIndex((entry) => entryKey(entry) === draggingKey);
		const to = entries.findIndex((entry) => entryKey(entry) === entryKey(target));
		if (from < 0 || to < 0 || from === to) {
			return;
		}
		const next = [...entries];
		const [moved] = next.splice(from, 1);
		// Crossing a folder boundary moves the entry into the target's folder.
		const targetFolder = target.folder ?? '';
		const adjusted = { ...moved, folder: targetFolder || undefined };
		// The target index shifted after the dragged entry was removed.
		const insertAt = next.findIndex((entry) => entryKey(entry) === entryKey(target)) + 1;
		next.splice(insertAt, 0, adjusted);
		// Recompute orders to match the new visual positions.
		commit(next.map((entry, index) => ({ ...entry, order: next.length - index })));
		draggingKey = null;
	}

	function toggleFolder(folder: string) {
		expandedFolders = expandedFolders.includes(folder)
			? expandedFolders.filter((name) => name !== folder)
			: [...expandedFolders, folder];
	}
	function startRename(folder: string) {
		renamingFolder = folder;
		renamingValue = folder;
	}
	function commitRename() {
		const next = renamingValue.trim();
		const previous = renamingFolder;
		renamingFolder = null;
		if (!previous || !next || next === previous || entries === null || disabled) {
			return;
		}
		if (folders.some((group) => group.folder === next)) {
			return;
		}
		commit(
			entries.map((entry) => (entry.folder === previous ? { ...entry, folder: next } : entry))
		);
	}
	function deleteFolder(folder: string) {
		if (content === null || entries === null || disabled) {
			return;
		}
		// Entries move to the top level and the folder is removed from the declarations,
		// so an empty folder actually disappears instead of surviving as declared.
		const remaining = (content.folders ?? []).filter((name) => name !== folder);
		commit(
			entries.map((entry) => (entry.folder === folder ? { ...entry, folder: undefined } : entry)),
			remaining
		);
		expandedFolders = expandedFolders.filter((name) => name !== folder);
	}
	const keyText = (entry: LoreEntry) => entry.keys.join(', ');
	function parseKeys(value: string): string[] {
		return value
			.split(',')
			.map((key) => key.trim())
			.filter(Boolean);
	}
</script>

<div class="lorebook-editor" aria-label="로어북 편집기">
	{#if entries === null}
		<p role="alert">
			로어북 JSON을 읽을 수 없어요. JSON으로 편집을 전환해 형식을 고친 뒤 다시 시도해주세요.
		</p>
	{:else}
		<div class="entry-tree">
			<div class="tree-heading">
				<span>로어 항목</span>
				<span class="heading-actions">
					<button
						type="button"
						class="icon-action"
						{disabled}
						aria-label="새 폴더 만들기"
						onclick={() => {
							const name = '새 폴더';
							let candidate = name;
							let suffix = 1;
							while (folders.some((group) => group.folder === candidate)) {
								candidate = name + ' ' + ++suffix;
							}
							createFolder(candidate);
							expandedFolders = [...expandedFolders, candidate];
						}}><Icon name="folder" size={13} /></button
					>
					<button
						type="button"
						class="icon-action"
						{disabled}
						aria-label="최상위 로어 추가"
						onclick={() => addEntry('')}><Icon name="plus" size={13} /></button
					>
				</span>
			</div>
			{#each folders as group (group.folder)}
				{#if group.folder}
					{#if renamingFolder === group.folder}
						<input
							class="folder-rename"
							value={renamingValue}
							{disabled}
							aria-label="폴더 이름 변경"
							oninput={(event) => (renamingValue = event.currentTarget.value)}
							onkeydown={(event) => {
								if (event.key === 'Enter') {
									commitRename();
								} else if (event.key === 'Escape') {
									renamingFolder = null;
								}
							}}
							onblur={commitRename}
						/>
					{:else}
						<div class="folder-row">
							<button
								type="button"
								class="folder-open"
								aria-label={`${group.folder} 폴더 펼치기`}
								aria-expanded={expandedFolders.includes(group.folder)}
								onclick={() => toggleFolder(group.folder)}
							>
								<Icon name="folder" size={13} /><span>{group.folder}</span><span
									class="folder-count">{group.items.length}</span
								>
							</button>
							<span class="folder-tools">
								<button
									type="button"
									class="icon-action"
									{disabled}
									aria-label={`${group.folder} 이름 변경`}
									onclick={() => startRename(group.folder)}><Icon name="pencil" size={12} /></button
								>
								<button
									type="button"
									class="icon-action"
									{disabled}
									aria-label={`${group.folder} 삭제 (로어는 최상위로 이동)`}
									onclick={() => deleteFolder(group.folder)}><Icon name="close" size={12} /></button
								>
							</span>
						</div>
					{/if}
				{/if}
				{#if !group.folder || expandedFolders.includes(group.folder)}
					{#each group.items as entry (entryKey(entry))}
						<div
							role="listitem"
							class={['entry-row', { selected: entryKey(entry) === selectedId }]}
							class:indented={!!group.folder}
							class:dragging={draggingKey === entryKey(entry)}
							draggable={!disabled}
							ondragstart={() => (draggingKey = entryKey(entry))}
							ondragend={() => (draggingKey = null)}
							ondragover={(event) => event.preventDefault()}
							ondrop={(event) => {
								event.preventDefault();
								handleDrop(entry);
							}}
						>
							<button
								type="button"
								class="entry-name"
								{disabled}
								onclick={() => (selectedId = entryKey(entry))}
								>{entry.name ?? entry.keys[0] ?? '이름 없음'}</button
							>
							<span class="entry-tools">
								<button
									type="button"
									class="icon-action"
									{disabled}
									aria-label={`${entry.name ?? '로어'} 삭제`}
									onclick={() => removeEntry(entry)}><Icon name="close" size={12} /></button
								>
							</span>
						</div>
					{/each}
				{/if}
				{#if group.folder}
					<button type="button" class="add-into" {disabled} onclick={() => addEntry(group.folder)}
						>{group.folder}에 로어 추가</button
					>
				{/if}
			{/each}
		</div>
		<div class="entry-form" aria-label="선택한 로어 편집">
			{#if selected}
				<label class="field"
					><span>로어 이름</span><input
						value={selected.name ?? ''}
						{disabled}
						oninput={(event) => updateSelected({ name: event.currentTarget.value })}
					/></label
				>
				<label class="field"
					><span>폴더</span><input
						value={selected.folder ?? ''}
						placeholder="(없음)"
						{disabled}
						oninput={(event) =>
							updateSelected({ folder: event.currentTarget.value.trim() || undefined })}
					/></label
				>
				<label class="field"
					><span>배치 순서</span><input
						type="number"
						value={selected.order ?? 0}
						{disabled}
						oninput={(event) => updateSelected({ order: Number(event.currentTarget.value) || 0 })}
					/></label
				>
				<label class="field"
					><span>키 (쉼표로 구분)</span><input
						value={keyText(selected)}
						placeholder="Hogwarts, 호그와트"
						{disabled}
						oninput={(event) => updateSelected({ keys: parseKeys(event.currentTarget.value) })}
					/></label
				>
				<label class="field"
					><span>프롬프트</span><textarea
						rows="8"
						value={selected.content}
						{disabled}
						oninput={(event) => updateSelected({ content: event.currentTarget.value })}></textarea>
				</label>
				<label class="check"
					><input
						type="checkbox"
						checked={selected.always === true}
						{disabled}
						onchange={(event) => updateSelected({ always: event.currentTarget.checked })}
					/>언제나 활성화</label
				>
				<label class="check"
					><input
						type="checkbox"
						checked={selected.enabled !== false}
						{disabled}
						onchange={(event) => updateSelected({ enabled: event.currentTarget.checked })}
					/>사용</label
				>
				<label class="check"
					><input
						type="checkbox"
						checked={selected.caseSensitive === true}
						{disabled}
						onchange={(event) =>
							updateSelected({
								caseSensitive: event.currentTarget.checked
							})}
					/>대소문자 구분</label
				>
			{:else}
				<p class="empty-hint">왼쪽에서 로어를 선택하거나 새로 추가하세요.</p>
			{/if}
		</div>
	{/if}
</div>

<style>
	.lorebook-editor {
		display: flex;
		height: 100%;
		min-height: 0;
		overflow: hidden;
	}
	.entry-tree {
		display: flex;
		flex-direction: column;
		width: 240px;
		flex-shrink: 0;
		overflow-y: auto;
		padding: 8px;
		border-right: 1px solid var(--border);
	}
	.tree-heading,
	.folder-row,
	.entry-row {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.tree-heading {
		justify-content: space-between;
		padding: 2px 4px 8px;
		color: var(--text-muted);
		font-size: 11px;
	}
	.folder-row {
		display: flex;
		align-items: center;
		border-radius: 5px;
	}
	.folder-row:hover {
		background: var(--surface-hover);
	}
	.folder-open {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 5px 6px;
		border: 0;
		background: transparent;
		color: var(--text-strong);
		font: inherit;
		font-size: 12px;
		text-align: left;
	}
	.folder-tools {
		display: none;
		gap: 2px;
	}
	.folder-row:hover .folder-tools {
		display: flex;
	}
	.folder-rename {
		width: 100%;
		padding: 4px 6px;
		border: 1px solid var(--accent, var(--text-muted));
		border-radius: 5px;
		background: var(--background);
		color: var(--text);
		font: inherit;
		font-size: 12px;
	}
	.folder-count {
		margin-left: auto;
		color: var(--text-muted);
		font-size: 10px;
	}
	.entry-row {
		border-radius: 5px;
	}
	.entry-row.selected {
		background: var(--surface-active);
	}
	.entry-row.indented {
		margin-left: 16px;
	}
	.entry-row.dragging {
		opacity: 0.4;
	}
	.entry-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		padding: 5px 6px;
		border: 0;
		background: transparent;
		color: var(--text);
		font: inherit;
		font-size: 12px;
		text-align: left;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.entry-tools {
		display: none;
		gap: 2px;
	}
	.entry-row:hover .entry-tools,
	.entry-row.selected .entry-tools {
		display: flex;
	}
	.icon-action {
		display: inline-grid;
		place-items: center;
		width: 22px;
		height: 22px;
		padding: 0;
		border: 0;
		border-radius: 4px;
		background: transparent;
		color: var(--text-muted);
	}
	.icon-action:hover {
		color: var(--text-strong);
		background: var(--surface-hover);
	}
	.add-into {
		margin: 2px 0 4px 16px;
		padding: 4px 6px;
		border: 0;
		background: transparent;
		color: var(--text-muted);
		font: inherit;
		font-size: 11px;
		text-align: left;
	}
	.add-into:hover {
		color: var(--text-strong);
	}
	.entry-form {
		flex: 1;
		min-width: 0;
		overflow-y: auto;
		padding: 14px 18px;
	}
	.field {
		display: block;
		margin-bottom: 14px;
	}
	.field span {
		display: block;
		margin-bottom: 6px;
		color: var(--text-muted);
		font-size: 11px;
	}
	.field input,
	.field textarea {
		width: 100%;
		padding: 8px 10px;
		border: 1px solid var(--border-strong);
		border-radius: 5px;
		background: color-mix(in srgb, var(--background) 90%, #000);
		color: var(--text);
		font: inherit;
		font-size: 12px;
	}
	.field textarea {
		resize: vertical;
		line-height: 1.7;
	}
	.check {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 8px;
		color: var(--text);
		font-size: 12px;
	}
	.empty-hint {
		color: var(--text-muted);
		font-size: 12px;
	}
</style>
