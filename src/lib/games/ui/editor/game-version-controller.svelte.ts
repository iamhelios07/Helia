import { untrack } from 'svelte';

import type { Game } from '../../model.js';
import type { CreateGameReleaseResult, GameVersioning } from '../../versioning.js';

import { createGameRelease, getGameVersioning } from '../../repository.js';
import { parseSemVer } from '../../versioning.js';

type VersionConflict = Extract<CreateGameReleaseResult, { kind: 'conflict' }>;

export class GameVersionController {
	state = $state.raw<GameVersioning | null>(null);
	conflict = $state.raw<VersionConflict | null>(null);
	version = $state('');
	loading = $state(true);
	busy = $state(false);
	error = $state('');
	success = $state('');
	private generation = 0;
	private gameId = '';
	private refreshAfterUnlock = false;

	constructor(
		private getGame: () => Game,
		private blocked: () => boolean,
		private onpending: (pending: boolean) => void
	) {
		// Applied game identity drives a repository read. Request state must not retrigger it.
		$effect(() => {
			const game = this.getGame();
			untrack(() => void this.load(game));
			return () => {
				++this.generation;
			};
		});
		$effect(() => {
			const blocked = this.blocked();
			untrack(() => {
				if (!blocked && this.refreshAfterUnlock) {
					void this.load();
				}
			});
		});
	}

	private current(game: Game, generation: number) {
		return this.getGame() === game && this.generation === generation;
	}

	load = async (game = this.getGame()) => {
		const generation = ++this.generation;
		// A panel remounted during a release must reread once that operation settles.
		this.refreshAfterUnlock = this.blocked() && !this.busy;
		if (game.id !== this.gameId) {
			this.version = '';
			this.gameId = game.id;
		}
		this.state = null;
		this.conflict = null;
		this.error = '';
		this.success = '';
		this.loading = true;
		try {
			const state = await getGameVersioning(game.id);
			if (this.current(game, generation)) {
				this.state = state;
			}
		} catch {
			if (this.current(game, generation)) {
				this.error = '버전 정보를 불러오지 못했어요. 다시 시도해주세요.';
			}
		} finally {
			if (this.current(game, generation)) {
				this.loading = false;
			}
		}
	};

	changeVersion = (value: string) => {
		this.version = value;
		this.conflict = null;
		this.error = '';
		this.success = '';
	};

	private validVersion(version: string) {
		try {
			parseSemVer(version);
			return true;
		} catch {
			this.error = 'SemVer 형식으로 입력해주세요. 예: 1.0.0 또는 1.1.0-beta.1';
			return false;
		}
	}

	release = async (ignoreConflict = false) => {
		if (this.busy || this.loading || this.blocked() || !this.state) {
			return;
		}
		const version = this.version.trim();
		const conflict = this.conflict;
		if (ignoreConflict && (!conflict || conflict.contentVersion !== version)) {
			this.conflict = null;
			return;
		}
		if (!this.validVersion(version)) {
			return;
		}
		const game = this.getGame();
		const generation = this.generation;
		this.busy = true;
		this.error = '';
		this.success = '';
		this.onpending(true);
		try {
			const options =
				ignoreConflict && conflict
					? { ignoreConflict: true, expectedContentHash: conflict.incomingHash }
					: { expectedContentHash: this.state.contentHash };
			const result = await createGameRelease(game.id, version, options);
			if (this.current(game, generation)) {
				this.accept(result);
			}
		} catch {
			if (this.current(game, generation)) {
				this.conflict = null;
				this.state = null;
				this.error =
					'배포본을 확정하지 못했어요. 버전 정보를 다시 불러온 뒤 시도해주세요. 입력한 버전과 초안은 유지돼요.';
			}
		} finally {
			this.busy = false;
			this.onpending(false);
		}
	};

	private accept(result: CreateGameReleaseResult) {
		if (result.kind === 'conflict') {
			this.conflict = result;
			return;
		}
		this.state = result.state;
		this.conflict = null;
		this.success = `${result.state.currentRelease?.contentVersion} 배포본을 확정했어요.`;
	}
}
