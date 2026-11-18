interface TreeDragOptions<T> {
	disabled: boolean;
	canDrop?: (key: string, target: T) => boolean;
	ondrop: (key: string, target: T) => void | Promise<void>;
}

/** Shared native drag lifecycle for creator trees; only drags started in this tree are accepted. */
export class TreeDrag<T> {
	key = $state<string | null>(null);
	target = $state.raw<T | null>(null);
	busy = $state(false);
	error = $state('');
	constructor(private readonly read: () => TreeDragOptions<T>) {}
	start(event: DragEvent, key: string) {
		if (this.read().disabled || this.busy) {
			event.preventDefault();
			return false;
		}
		event.stopPropagation();
		this.key = key;
		this.target = null;
		this.error = '';
		if (event.dataTransfer) {
			event.dataTransfer.effectAllowed = 'move';
			event.dataTransfer.setData('text/plain', key);
		}
		return true;
	}
	over(event: DragEvent, target: T): boolean {
		if (this.key === null || this.read().disabled || this.busy) {
			return false;
		}
		event.stopPropagation();
		if (this.read().canDrop?.(this.key, target) === false) {
			this.target = null;
			if (event.dataTransfer) {
				event.dataTransfer.dropEffect = 'none';
			}
			return false;
		}
		event.preventDefault();
		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = 'move';
		}
		this.target = target;
		return true;
	}
	leave = (event: DragEvent) => {
		const element = event.currentTarget;
		if (
			element instanceof Node &&
			event.relatedTarget instanceof Node &&
			element.contains(event.relatedTarget)
		) {
			return;
		}
		this.target = null;
	};
	end = () => {
		this.key = null;
		this.target = null;
	};
	drop = async (event: DragEvent) => {
		if (this.key === null) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		const key = this.key,
			target = this.target,
			options = this.read();
		this.end();
		if (
			target === null ||
			options.disabled ||
			this.busy ||
			options.canDrop?.(key, target) === false
		) {
			return;
		}
		this.busy = true;
		try {
			await options.ondrop(key, target);
		} catch (error) {
			this.error = error instanceof Error ? error.message : '항목을 이동하지 못했어요.';
		} finally {
			this.busy = false;
		}
	};
}
