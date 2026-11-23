/** Media is fetched once concurrently and retained under a separate memory budget. */
export class StorageAssets {
	private entries = new Map<string, { result: Promise<string>; bytes: number }>();
	private bytes = 0;
	constructor(private load: (gameId: string, hash: string) => Promise<string>) {}
	read(gameId: string, hash: string): Promise<string> {
		const key = gameId + ':' + hash;
		const cached = this.entries.get(key);
		if (cached) {
			return cached.result;
		}
		const entry = { result: Promise.resolve(''), bytes: 0 };
		entry.result = this.load(gameId, hash)
			.then((value) => {
				if (this.entries.get(key) === entry) {
					entry.bytes = value.length * 2;
					this.bytes += entry.bytes;
					for (const old of this.entries.keys()) {
						if (this.bytes <= 32 * 1024 * 1024) {
							break;
						}
						this.remove(old);
					}
				}
				return value;
			})
			.catch((error: unknown) => {
				if (this.entries.get(key) === entry) {
					this.remove(key);
				}
				throw error;
			});
		this.entries.set(key, entry);
		return entry.result;
	}
	private remove(key: string) {
		this.bytes -= this.entries.get(key)?.bytes ?? 0;
		this.entries.delete(key);
	}
	forget(gameId: string) {
		for (const key of this.entries.keys()) {
			if (key.startsWith(gameId + ':')) {
				this.remove(key);
			}
		}
	}
}
