/**
 * Bounded LRU, used as the in-memory hot layer in front of IndexedDB
 * (PLAN.md §4.4).
 *
 * Lives in core rather than the extension because the bot needs the same thing
 * in front of a server-side store, and because it has no browser dependency.
 *
 * Relies on Map preserving insertion order: delete-then-set moves a key to the
 * most-recent end, so the oldest key is always the first one `keys()` yields.
 */
export class MemoryLru<V> {
  private map = new Map<string, V>();
  private limit: number;

  constructor(limit = 500) {
    if (limit < 1) throw new RangeError("MemoryLru limit must be at least 1");
    this.limit = limit;
  }

  get(key: string): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key) as V;
    // Touch: re-insert so this key becomes the most recently used.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next();
      if (oldest.done === true) break;
      this.map.delete(oldest.value);
    }
  }

  delete(key: string): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }

  /** Oldest first. Exposed for tests and for flushing to a durable store. */
  keys(): string[] {
    return [...this.map.keys()];
  }
}
