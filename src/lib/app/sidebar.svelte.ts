import { createContext, onDestroy, onMount } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';

import type { LibraryGame } from '#lib/library/library-games.js';

export interface AppSidebarOptions {
	/** Undefined while this page loads; keep the last known saved-game shortcuts. */
	games: readonly LibraryGame[] | undefined;
	activeGameId: string | null;
	busy: boolean;
	onhome: () => void;
	onadd: () => void;
	onselect: (game: LibraryGame) => void;
}

/** One controller per root layout, never a module-level shared app instance. */
export class AppSidebarController {
	#pages = $state.raw<{ token: symbol; read: () => AppSidebarOptions }[]>([]);
	#hidden = new SvelteSet<symbol>();
	#fallbackGames = $state.raw<readonly LibraryGame[]>([]);

	get options(): AppSidebarOptions | null {
		return this.#pages.at(-1)?.read() ?? null;
	}

	get visible(): boolean {
		return this.#hidden.size === 0;
	}

	get games(): readonly LibraryGame[] {
		return this.options?.games ?? this.#fallbackGames;
	}

	configure(read: () => AppSidebarOptions): () => void {
		const token = Symbol('sidebar page');
		this.#pages = [...this.#pages, { token, read }];
		return () => {
			const page = this.#pages.find((page) => page.token === token);
			const games = page?.read().games;
			if (games) {
				this.#fallbackGames = games;
			}
			this.#pages = this.#pages.filter((page) => page.token !== token);
		};
	}

	hide(): () => void {
		const token = Symbol('sidebar visibility');
		this.#hidden.add(token);
		return () => {
			this.#hidden.delete(token);
		};
	}
}

export const [getAppSidebar, provideAppSidebar] = createContext<AppSidebarController>();

/** Keep reactive page data in its owner; the persistent layout reads this getter. */
export function configureAppSidebar(read: () => AppSidebarOptions): void {
	const sidebar = getAppSidebar();
	onMount(() => sidebar.configure(read));
}

/** Acquire a temporary hide and restore it explicitly or automatically on unmount. */
export function useAppSidebarVisibility(): { hide: () => () => void } {
	const sidebar = getAppSidebar();
	const releases = new SvelteSet<() => void>();
	onDestroy(() => {
		for (const release of releases) {
			release();
		}
	});
	return {
		hide() {
			const release = sidebar.hide();
			releases.add(release);
			return () => {
				release();
				releases.delete(release);
			};
		}
	};
}
