import { GamePackageError } from '#lib/games/package/limits.js';

/** Admit the oldest eligible waiter; a saturated game cannot reserve global slots. */
export class MediaQueue {
	private active = 0;
	private games = new Map<string, number>();
	private waiting = new Set<() => void>();
	constructor(
		private total: number,
		private perGame = total,
		private timeout = 30000
	) {}
	private acquire(game: string) {
		return new Promise<void>((resolve, reject) => {
			const expires = performance.now() + this.timeout;
			const busy = () => {
				this.waiting.delete(admit);
				reject(new GamePackageError('busy'));
			};
			const admit = () => {
				if (performance.now() >= expires) {
					clearTimeout(timer);
					busy();
					return;
				}
				const count = this.games.get(game) ?? 0;
				if (this.active >= this.total || count >= this.perGame) {
					return;
				}
				this.games.set(game, count + 1);
				this.active++;
				clearTimeout(timer);
				this.waiting.delete(admit);
				resolve();
			};
			const timer = setTimeout(busy, this.timeout);
			this.waiting.add(admit);
			admit();
		});
	}
	async run<T>(game: string, work: () => Promise<T>) {
		await this.acquire(game);
		try {
			return await work();
		} finally {
			this.active--;
			const count = this.games.get(game)! - 1;
			if (count) {
				this.games.set(game, count);
			} else {
				this.games.delete(game);
			}
			for (const admit of this.waiting) {
				admit();
			}
		}
	}
}
