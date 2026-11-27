import { SvelteMap } from 'svelte/reactivity';

import {
	listNetworkGrants,
	NETWORK_GRANTS_CHANGED,
	NETWORK_GRANTS_KEY,
	revokeNetworkGrant,
	type NetworkGrant
} from '#lib/games/network/grants.js';
import { listGames } from '#lib/games/repository.js';

export interface NetworkGrantRow extends NetworkGrant {
	title: string;
	trashed: boolean;
}
interface GameLabel {
	title: string;
	trashed: boolean;
}
const UNKNOWN_GAME = '찾을 수 없는 게임';

/** Lists and cancels the player's remembered network consents. Revoking is immediate. */
export class NetworkGrantsController {
	rows = $state.raw<NetworkGrantRow[]>([]);
	ready = $state(false);
	loading = $state(false);
	error = $state('');
	status = $state('');
	private labels = new SvelteMap<string, GameLabel>();
	private disposed = false;
	private generation = 0;
	private subscribed = false;

	load = async () => {
		this.subscribe();
		const generation = ++this.generation;
		this.error = '';
		this.loading = true;
		this.ready = false;
		this.refresh();
		try {
			const games = await listGames(true);
			if (this.disposed || generation !== this.generation) {
				return;
			}
			this.labels = new SvelteMap(
				games.map((game) => [game.id, { title: game.title, trashed: game.trashedAt !== undefined }])
			);
			this.refresh();
		} catch {
			// Origins stay manageable without titles; the rows fall back to a generic game label.
		} finally {
			// A newer load owns the loading state; a disposal no longer renders anything.
			if (!this.disposed && generation === this.generation) {
				this.loading = false;
				this.ready = true;
			}
		}
	};
	refresh = () => {
		if (this.disposed) {
			return;
		}
		this.rows = listNetworkGrants()
			.map(({ gameId, origin }) => {
				const label = this.labels.get(gameId);
				return {
					gameId,
					origin,
					title: label?.title || UNKNOWN_GAME,
					trashed: label?.trashed ?? false
				};
			})
			.sort(
				(a, b) =>
					a.title.localeCompare(b.title, 'ko-KR') ||
					a.gameId.localeCompare(b.gameId) ||
					a.origin.localeCompare(b.origin)
			);
	};
	/** Returns whether the stored grants changed; a failed write re-reads the saved state. */
	revoke = (row: NetworkGrant): boolean => {
		this.status = '';
		if (!revokeNetworkGrant(row.gameId, row.origin)) {
			this.error = `${row.origin} 허용을 취소하지 못했어요. 저장소를 확인하고 다시 시도해주세요.`;
			this.refresh();
			return false;
		}
		this.error = '';
		this.status = `${row.origin} 허용을 취소했어요. 다음 연결부터 다시 물어봅니다.`;
		this.refresh();
		return true;
	};
	/** Another tab or window may have changed the grants. */
	storageChanged = (event: StorageEvent) => {
		if (event.key === null || event.key === NETWORK_GRANTS_KEY) {
			this.refresh();
		}
	};
	/** The same tab changed the grants while this panel stayed open. */
	private subscribe = () => {
		if (this.subscribed || this.disposed || typeof window === 'undefined') {
			return;
		}
		this.subscribed = true;
		window.addEventListener(NETWORK_GRANTS_CHANGED, this.refresh);
	};
	dispose = () => {
		this.disposed = true;
		this.generation++;
		if (this.subscribed) {
			this.subscribed = false;
			window.removeEventListener(NETWORK_GRANTS_CHANGED, this.refresh);
		}
	};
}
