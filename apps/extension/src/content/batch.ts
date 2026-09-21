/**
 * Coalescing and dispatch scheduling (PLAN.md §4.6).
 *
 * A correction to what the plan assumed. §4.6 says "batch up to ~20 segments
 * into one provider request", which presumes a batch endpoint. Chrome's
 * built-in Translator has none — `translate()` takes one string and returns
 * one string — so on the automatic path, batching cannot reduce the number of
 * calls. What it actually buys there is:
 *
 *   1. **Dedupe within the window.** A channel where six people type "gm" in
 *      the same second costs one translation, not six.
 *   2. **Bounded concurrency.** Releasing a screenful of backlog at once
 *      otherwise fires forty concurrent `translate()` calls and stalls the
 *      main thread.
 *   3. **One place where the cloud path *can* bundle**, since DeepL does take
 *      an array.
 *
 * So the batch size is a concurrency and coalescing window for on-device, and a
 * real request bundle for cloud. Worth stating, because "batching" implied a
 * cost saving on the automatic path that isn't available.
 */

export interface BatcherOptions {
  /** Wait this long for more items before dispatching. */
  debounceMs?: number;
  /** Dispatch immediately once this many distinct items are queued. */
  maxSize?: number;
}

/**
 * Dispatches a group of deduplicated items.
 *
 * Must return a result for every key it was given; a missing key rejects that
 * key's waiters rather than leaving them pending forever.
 */
export type Dispatch<T, R> = (items: { key: string; value: T }[]) => Promise<Map<string, R>>;

interface Waiter<R> {
  resolve: (value: R) => void;
  reject: (error: unknown) => void;
}

export class Batcher<T, R> {
  private dispatch: Dispatch<T, R>;
  private debounceMs: number;
  private maxSize: number;
  private queue = new Map<string, T>();
  private waiters = new Map<string, Waiter<R>[]>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight = new Set<Promise<void>>();

  constructor(dispatch: Dispatch<T, R>, options: BatcherOptions = {}) {
    this.dispatch = dispatch;
    this.debounceMs = options.debounceMs ?? 150;
    this.maxSize = options.maxSize ?? 20;
  }

  /**
   * Queues `value` under `key`.
   *
   * Two calls with the same key inside one window share a single dispatch —
   * that is the dedupe, and it is why the key is the cache key rather than the
   * message id.
   */
  add(key: string, value: T): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      const waiters = this.waiters.get(key);
      if (waiters) {
        // Already queued this window; ride along on the same dispatch.
        waiters.push({ resolve, reject });
        return;
      }

      this.queue.set(key, value);
      this.waiters.set(key, [{ resolve, reject }]);

      if (this.queue.size >= this.maxSize) {
        void this.flush();
        return;
      }

      this.timer ??= setTimeout(() => void this.flush(), this.debounceMs);
    });
  }

  /** Dispatches whatever is queued, now. */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.queue.size === 0) return;

    const items = [...this.queue].map(([key, value]) => ({ key, value }));
    const waiters = this.waiters;
    this.queue = new Map();
    this.waiters = new Map();

    const task = (async (): Promise<void> => {
      try {
        const results = await this.dispatch(items);
        for (const { key } of items) {
          const group = waiters.get(key) ?? [];
          if (results.has(key)) {
            const value = results.get(key) as R;
            for (const w of group) w.resolve(value);
          } else {
            // A dispatch that silently drops a key would otherwise leave its
            // callers pending forever.
            const error = new Error(`batch dispatch returned no result for ${key}`);
            for (const w of group) w.reject(error);
          }
        }
      } catch (error) {
        for (const group of waiters.values()) {
          for (const w of group) w.reject(error);
        }
      }
    })();

    this.inflight.add(task);
    await task.finally(() => this.inflight.delete(task));
  }

  /** Waits for queued and in-flight work to finish. Tests and teardown. */
  async drain(): Promise<void> {
    await this.flush();
    while (this.inflight.size > 0) await Promise.all([...this.inflight]);
  }

  get pending(): number {
    return this.queue.size;
  }
}

/**
 * Maps over items with a concurrency ceiling.
 *
 * This is what makes the on-device dispatch safe: forty simultaneous
 * `translate()` calls do not become forty simultaneous model invocations.
 */
export async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T);
    }
  });

  await Promise.all(workers);
  return results;
}
