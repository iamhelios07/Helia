export type LiteralCursor = { nesting: number; quoted: boolean; escaped: boolean };

/** Track JSON containers so their braces and argument-like text remain literal. */
export function advanceLiteral(cursor: LiteralCursor, character: string) {
	if (cursor.quoted) {
		if (cursor.escaped) {
			cursor.escaped = false;
			return;
		}
		if (character === '\\') {
			cursor.escaped = true;
			return;
		}
		if (character === '"') {
			cursor.quoted = false;
		}
		return;
	}
	if (cursor.nesting && character === '"') {
		cursor.quoted = true;
		return;
	}
	if (character === '{' || character === '[') {
		cursor.nesting++;
	}
	if (cursor.nesting && (character === '}' || character === ']')) {
		cursor.nesting--;
	}
}
