/** Host-owned installation metadata, excluded from authored content and sandbox permissions. */
export type EditLock = boolean;
export type EditOperation = 'draft' | 'apply' | 'release' | 'upgrade';
export const GAME_EDIT_LOCKED = 'GAME_EDIT_LOCKED';
export const INVALID_EDIT_LOCK = 'INVALID_EDIT_LOCK';
export const UNLOCK_CONFIRMATION =
	'편집 잠금을 해제할까요? 이 게임의 초안 저장·적용·릴리스 생성을 허용합니다. 해제한 뒤에는 다시 잠글 수 없습니다.';

export function parseEditLock(value: unknown): EditLock {
	if (typeof value !== 'boolean') {
		throw Error(INVALID_EDIT_LOCK);
	}
	return value;
}

/** Upgrades preserve the existing value and are deliberately outside the editing deny list. */
export function allowsEditOperation(lock: EditLock | undefined, operation: EditOperation): boolean {
	return lock !== true || !(['draft', 'apply', 'release'] as EditOperation[]).includes(operation);
}

export function assertEditOperation(lock: EditLock | undefined, operation: EditOperation): void {
	if (!allowsEditOperation(lock, operation)) {
		throw Error(GAME_EDIT_LOCKED);
	}
}
