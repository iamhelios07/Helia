<script lang="ts">
	import { SvelteMap } from 'svelte/reactivity';

	import Icon from '#lib/components/Icon.svelte';
	import { parseGameAIContent, type LoreEntry } from '#lib/games/ai/prompts.js';

	import {
		applyDrop,
		createLoreEntry,
		entryKey,
		knownFolders,
		serializeLorebook,
		zoneForEntry,
		zoneForFolder,
		ZONE_END,
		type DropZone
	} from './lorebook-dnd.js';

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

	function stableEntry(entry: LoreEntry): LoreEntry {
		return { ...entry };
	}
	function commit(next: LoreEntry[], declaredFolders?: string[]) {
		if (content === null || disabled) {
			return;
		}
		// Folders that exist before the change must keep existing after it, even when the
		// change empties them: a folder only disappears when it is deleted on purpose.
		const known = declaredFolders ?? knownFolders(content);
		const filled = next.map((entry) => entry.folder ?? '').filter(Boolean);
		const emptyFolders = known.filter((name) => !filled.includes(name));
		onchange(serializeLorebook(next, emptyFolders));
	}
	function createFolder(name: string) {
		if (content === null || disabled) {
			return;
		}
		const declared = knownFolders(content);
		if (declared.includes(name)) {
			return;
		}
		commit(entries ?? [], [...declared, name]);
		expandedFolders = [...expandedFolders, name];
	}
	function addEntry(folder: string) {
		if (entries === null || disabled) {
			return;
		}
		const entry = createLoreEntry(folder);
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
	let dropZone = $state<DropZone | null>(null);

	function dragOverEntry(event: DragEvent, entry: LoreEntry) {
		if (!draggingKey || disabled) {
			return;
		}
		event.preventDefault();
		dropZone = zoneForEntry(event, entry);
	}
	function dragOverFolder(event: DragEvent, folder: string) {
		if (!draggingKey || disabled) {
			return;
		}
		event.preventDefault();
		dropZone = zoneForFolder(folder);
	}
	function dragOverTreeEnd(event: DragEvent) {
		if (!draggingKey || disabled) {
			return;
		}
		event.preventDefault();
		dropZone = ZONE_END;
	}
	function clearDrop() {
		dropZone = null;
	}
	function resolveDrop() {
		const zone = dropZone;
		if (!draggingKey || content === null || !zone) {
			return;
		}
		commit(applyDrop(content.lorebook, draggingKey, zone));
		draggingKey = null;
		dropZone = null;
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
		if (
			!previous ||
			!next ||
			next === previous ||
			entries === null ||
			content === null ||
			disabled
		) {
			return;
		}
		if (folders.some((group) => group.folder === next)) {
			return;
		}
		const declared = knownFolders(content).filter((name) => name !== previous);
		commit(
			entries.map((entry) => (entry.folder === previous ? { ...entry, folder: next } : entry)),
			[...declared, next]
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
						<div
							role="group"
							class="folder-row"
							ondragover={(event) => dragOverFolder(event, group.folder)}
							ondragleave={clearDrop}
							ondrop={(event) => {
								event.preventDefault();
								resolveDrop();
							}}
						>
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
							class={[
								'entry-row',
								{ selected: entryKey(entry) === selectedId },
								{ dragging: draggingKey === entryKey(entry) },
								{
									'drop-before': dropZone?.kind === 'before' && dropZone.key === entryKey(entry),
									'drop-after': dropZone?.kind === 'after' && dropZone.key === entryKey(entry)
								}
							]}
							class:indented={!!group.folder}
							draggable={!disabled}
							ondragstart={() => (draggingKey = entryKey(entry))}
							ondragend={() => {
								draggingKey = null;
								dropZone = null;
							}}
							ondragover={(event) => dragOverEntry(event, entry)}
							ondrop={(event) => {
								event.preventDefault();
								resolveDrop();
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
					{#if !group.folder}
						<div
							role="group"
							class={['tree-end', { active: dropZone?.kind === 'end' }]}
							ondragover={(event) => dragOverTreeEnd(event)}
							ondragleave={clearDrop}
							ondrop={(event) => {
								event.preventDefault();
								resolveDrop();
							}}
						></div>
					{/if}
				{/if}
				{#if group.folder}
					<div
						role="group"
						class={[
							'folder-drop',
							{ active: dropZone?.kind === 'inside' && dropZone.folder === group.folder }
						]}
						ondragover={(event) => dragOverFolder(event, group.folder)}
						ondragleave={clearDrop}
						ondrop={(event) => {
							event.preventDefault();
							resolveDrop();
						}}
					></div>
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
	.entry-row.drop-before {
		box-shadow: inset 0 2px 0 var(--text-strong);
	}
	.entry-row.drop-after {
		box-shadow: inset 0 -2px 0 var(--text-strong);
	}
	.entry-row.dragging {
		opacity: 0.4;
	}
	.folder-drop {
		min-height: 8px;
	}
	.folder-drop.active {
		box-shadow: inset 0 2px 0 var(--text-strong);
	}
	.tree-end {
		min-height: 14px;
	}
	.tree-end.active {
		box-shadow: inset 0 2px 0 var(--text-strong);
	}

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
