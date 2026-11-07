export interface EditorLayout {
	explorerWidth: number;
	previewWidth: number;
	bottomHeight: number;
}

export const EDITOR_LAYOUT_LIMITS = {
	explorer: { min: 160, max: 480 },
	preview: { min: 220, max: 640 },
	bottom: { min: 80, max: 640 }
} as const;
const prefix = 'helia:editor-layout:';

function parseLayout(value: unknown): EditorLayout | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const row = value as Record<string, unknown>;
	const explorerWidth = row.explorerWidth;
	const previewWidth = row.previewWidth;
	const bottomHeight = row.bottomHeight ?? 178;
	if (
		typeof explorerWidth !== 'number' ||
		!Number.isFinite(explorerWidth) ||
		typeof previewWidth !== 'number' ||
		!Number.isFinite(previewWidth) ||
		typeof bottomHeight !== 'number' ||
		!Number.isFinite(bottomHeight) ||
		explorerWidth < EDITOR_LAYOUT_LIMITS.explorer.min ||
		explorerWidth > EDITOR_LAYOUT_LIMITS.explorer.max ||
		previewWidth < EDITOR_LAYOUT_LIMITS.preview.min ||
		previewWidth > EDITOR_LAYOUT_LIMITS.preview.max ||
		bottomHeight < EDITOR_LAYOUT_LIMITS.bottom.min ||
		bottomHeight > EDITOR_LAYOUT_LIMITS.bottom.max
	)
		return null;
	return {
		explorerWidth: Math.round(explorerWidth),
		previewWidth: Math.round(previewWidth),
		bottomHeight: Math.round(bottomHeight)
	};
}

/** Layout is optional presentation state; unreadable preferences never block authoring. */
export function loadEditorLayout(gameId: string): EditorLayout | null {
	try {
		const value: unknown = JSON.parse(localStorage.getItem(prefix + gameId) ?? 'null');
		if (
			!value ||
			typeof value !== 'object' ||
			Array.isArray(value) ||
			(value as Record<string, unknown>).version !== 1
		)
			return null;
		return parseLayout(value);
	} catch {
		return null;
	}
}

export function storeEditorLayout(gameId: string, value: EditorLayout): void {
	const layout = parseLayout(value);
	if (!layout) throw new Error('편집기 패널 크기를 확인해주세요.');
	localStorage.setItem(prefix + gameId, JSON.stringify({ version: 1, ...layout }));
}
