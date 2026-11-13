import type { LoreEntry } from '#lib/games/ai/prompts.js';

export type DropZone =
	| { kind: 'before'; key: string }
	| { kind: 'after'; key: string }
	| { kind: 'inside'; folder: string }
	| { kind: 'end' };

export function entryKey(entry: LoreEntry): string {
	return entry.id ?? `${entry.name ?? ''}:${entry.keys.join(',')}:${entry.content.slice(0, 32)}`;
}

/** Picks the drop zone from the pointer position: above the midpoint inserts before. */
export function zoneForEntry(event: DragEvent, entry: LoreEntry): DropZone {
	const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
	const before = event.clientY < rect.top + rect.height / 2;
	return { kind: before ? 'before' : 'after', key: entryKey(entry) };
}

export function zoneForFolder(folder: string): DropZone {
	return { kind: 'inside', folder };
}

export const ZONE_END: DropZone = { kind: 'end' };

export function zoneKey(zone: DropZone): string {
	if (zone.kind === 'before' || zone.kind === 'after') {
		return `${zone.kind}:${zone.key}`;
	}
	if (zone.kind === 'inside') {
		return `inside:${zone.folder}`;
	}
	return 'end';
}

/** Applies a drop: repositions the dragged entry, adopting the anchor's folder on moves. */
export function applyDrop(lorebook: LoreEntry[], draggingKey: string, zone: DropZone): LoreEntry[] {
	const from = lorebook.findIndex((entry) => entryKey(entry) === draggingKey);
	if (from < 0) {
		return lorebook;
	}
	const next = [...lorebook];
	const [moved] = next.splice(from, 1);
	let adjusted: LoreEntry = moved;
	let anchorKey = '';
	if (zone.kind === 'inside') {
		adjusted = { ...moved, folder: zone.folder };
	} else if (zone.kind === 'end') {
		adjusted = { ...moved, folder: undefined };
	} else {
		anchorKey = zone.key;
		const anchor = lorebook.find((entry) => entryKey(entry) === anchorKey);
		if (anchor) {
			adjusted = { ...moved, folder: anchor.folder ?? undefined };
		}
	}
	const anchorIndex =
		zone.kind === 'end' ? next.length : next.findIndex((entry) => entryKey(entry) === anchorKey);
	const insertAt =
		zone.kind === 'after' || zone.kind === 'end' ? anchorIndex + 1 : Math.max(anchorIndex, 0);
	next.splice(insertAt, 0, adjusted);
	// Order weights follow the new visual positions so prompt assembly matches.
	return next.map((entry, index) => ({ ...entry, order: next.length - index }));
}
