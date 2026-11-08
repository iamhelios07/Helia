import { onDestroy } from 'svelte';

import type { ToolDefinition } from '../../ai/protocol.js';
import type { SessionTimeline } from '../../state/history.js';
import type { PlaygroundProps } from './playground-frame.js';

import { createEditorPlaythrough, type EditorPlaythrough } from '../../editor-playground.js';

/** Own the lifetimes and catalogs of the independently running preview and test sessions. */
export class PlaygroundSessions {
	preview = $state.raw<EditorPlaythrough | null>(null);
	test = $state.raw<EditorPlaythrough | null>(null);
	previewTimeline = $state.raw<SessionTimeline | null>(null);
	testTimeline = $state.raw<SessionTimeline | null>(null);
	previewTools = $state.raw<ToolDefinition[]>([]);
	testTools = $state.raw<ToolDefinition[]>([]);
	starting = $state({ preview: false, test: false });
	private readonly generations = { preview: 0, test: 0 };
	private disposed = false;
	constructor(
		private readonly read: () => PlaygroundProps,
		private readonly onstart: (context: EditorPlaythrough) => void,
		private readonly onfail: (failure: unknown) => void,
		private readonly onclear: () => void
	) {
		onDestroy(() => this.dispose());
	}
	private dispose() {
		this.disposed = true;
		this.generations.preview++;
		this.generations.test++;
		this.preview?.dispose();
		this.test?.dispose();
	}
	async start(kind: 'preview' | 'test', snapshot = this.read().game) {
		const generation = ++this.generations[kind];
		this.starting[kind] = true;
		if (this.read().mode === kind) {
			this.onclear();
		}
		try {
			const context = await createEditorPlaythrough(snapshot, {
				ondiagnostic: (entry) => {
					if (!this.disposed && this.generations[kind] === generation) {
						this.read().ondiagnostic?.({
							...entry,
							message: `${kind === 'preview' ? '미리보기' : '테스트'} · ${entry.message}`
						});
					}
				},
				onchange: (next) => {
					if (this.disposed || this.generations[kind] !== generation) {
						return;
					}
					if (kind === 'preview') {
						this.previewTimeline = next;
					} else {
						this.testTimeline = next;
					}
				}
			});
			if (this.disposed || this.generations[kind] !== generation) {
				context.dispose();
				return;
			}
			if (kind === 'preview') {
				this.preview?.dispose();
				this.preview = context;
			} else {
				this.test?.dispose();
				this.test = context;
			}
			if (this.read().mode === kind) {
				this.onstart(context);
			}
			this.read().ondiagnostic?.({
				message: `${kind === 'preview' ? '미리보기' : '테스트'} · 별도 실행 시작`,
				failed: false
			});
			await this.updateCatalog(context, kind, generation);
		} catch (failure) {
			if (!this.disposed && this.read().mode === kind && this.generations[kind] === generation) {
				this.onfail(failure);
			}
		} finally {
			if (!this.disposed && this.generations[kind] === generation) {
				this.starting[kind] = false;
			}
		}
	}
	async updateCatalog(context: EditorPlaythrough, kind: 'preview' | 'test', generation: number) {
		try {
			const catalog = await context.catalog();
			if (this.disposed || this.generations[kind] !== generation) {
				return;
			}
			if (kind === 'preview') {
				this.previewTools = catalog;
			} else {
				this.testTools = catalog;
			}
		} catch (failure) {
			if (this.read().mode === kind && this.generations[kind] === generation) {
				this.onfail(failure);
			}
		}
	}
}
