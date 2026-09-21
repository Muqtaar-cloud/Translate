/**
 * The durable translation cache (PLAN.md §4.4).
 *
 * Lives in the service worker, not the content script, for a reason that is
 * easy to miss: a content script's IndexedDB belongs to the *page's* origin.
 * Caching there would write our data into discord.com's storage, where Discord
 * can clear it and where it cannot be shared with another tab. The worker runs
 * on the extension origin, so the cache is ours, survives Discord clearing its
 * own storage, and is shared across every open channel.
 *
 * What this is and is not for: it is a **latency** win. Viewport gating is the
 * cost defence. The stock phrases that would drive a high hit rate — "gm",
 * "thanks", "ok" — are exactly the sub-15-character messages detection skips,
 * and a virtualized remount of unchanged text is already free via the node key.
 * Expect modest hit rates and do not build a cost model on them.
 */

const DB_NAME = "polyglot";
const DB_VERSION = 1;
const STORE = "translations";
const INDEX_ACCESSED = "accessed";

/** PLAN.md §4.4. */
export const TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_BYTES = 50 * 1024 * 1024;

export interface CacheEntry {
  key: string;
  text: string;
  /** "context-free" | "context-assisted" — part of the key, kept for auditing. */
  tier: string;
  bytes: number;
  created: number;
  accessed: number;
}

function open(indexedDB: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "key" });
        // Eviction walks this index oldest-first, so it must exist from v1.
        store.createIndex(INDEX_ACCESSED, "accessed");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

const request = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

export class TranslationStore {
  private factory: IDBFactory;
  private db: IDBDatabase | null = null;
  private now: () => number;

  /**
   * `indexedDB` and `now` are injected so the store is testable without a
   * browser and so TTL expiry can be exercised without waiting 30 days.
   */
  constructor(factory: IDBFactory = indexedDB, now: () => number = Date.now) {
    this.factory = factory;
    this.now = now;
  }

  private async handle(): Promise<IDBDatabase> {
    // MV3 workers are killed when idle, taking the handle with them. Reopening
    // on demand is normal operation here, not an error path.
    this.db ??= await open(this.factory);
    return this.db;
  }

  async get(key: string): Promise<string | null> {
    const db = await this.handle();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const entry = (await request(store.get(key))) as CacheEntry | undefined;

    if (!entry) {
      await done(tx);
      return null;
    }

    if (this.now() - entry.created > TTL_MS) {
      store.delete(key);
      await done(tx);
      return null;
    }

    // Touch for LRU. Costs a write on every hit, which is why the content
    // script keeps a memory layer in front of this.
    entry.accessed = this.now();
    store.put(entry);
    await done(tx);
    return entry.text;
  }

  async put(key: string, text: string, tier: string): Promise<void> {
    const db = await this.handle();
    const tx = db.transaction(STORE, "readwrite");
    const now = this.now();
    tx.objectStore(STORE).put({
      key,
      text,
      tier,
      bytes: key.length + text.length,
      created: now,
      accessed: now,
    } satisfies CacheEntry);
    await done(tx);
  }

  /** Total bytes currently stored. */
  async size(): Promise<number> {
    const db = await this.handle();
    const tx = db.transaction(STORE, "readonly");
    const entries = (await request(tx.objectStore(STORE).getAll())) as CacheEntry[];
    await done(tx);
    return entries.reduce((sum, e) => sum + e.bytes, 0);
  }

  /**
   * Drops expired entries, then evicts least-recently-used until under budget.
   *
   * Called on a schedule rather than on every write: eviction walks the whole
   * store, and doing that per put would make writes O(n).
   */
  async evict(maxBytes = MAX_BYTES): Promise<{ expired: number; evicted: number }> {
    const db = await this.handle();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const entries = (await request(store.getAll())) as CacheEntry[];

    const now = this.now();
    let expired = 0;
    let total = 0;
    const live: CacheEntry[] = [];

    for (const entry of entries) {
      if (now - entry.created > TTL_MS) {
        store.delete(entry.key);
        expired++;
      } else {
        live.push(entry);
        total += entry.bytes;
      }
    }

    live.sort((a, b) => a.accessed - b.accessed); // oldest access first
    let evicted = 0;
    for (const entry of live) {
      if (total <= maxBytes) break;
      store.delete(entry.key);
      total -= entry.bytes;
      evicted++;
    }

    await done(tx);
    return { expired, evicted };
  }

  async clear(): Promise<void> {
    const db = await this.handle();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    await done(tx);
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}
