import { cacheKey, MemoryLru, type TranslationRequest } from "@polyglot/core";

/**
 * Two-level translation cache (PLAN.md §4.4).
 *
 * Level 1 is an in-memory LRU in this content script — the hot layer for the
 * conversation on screen. Level 2 is IndexedDB in the service worker, reached
 * by message, shared across tabs and living on the extension origin rather
 * than discord.com's.
 *
 * The memory layer is not an optimisation detail: every IndexedDB hit costs a
 * write (LRU touch) plus a message round trip, and a scrollback re-reads the
 * same messages repeatedly. Without it the durable store would be hit on every
 * pass over the same screenful.
 */
export interface TranslationCache {
  get(req: CacheableRequest, provider: string): Promise<string | null>;
  put(req: CacheableRequest, provider: string, text: string): Promise<void>;
}

export type CacheableRequest = Pick<
  TranslationRequest,
  "text" | "source" | "target" | "contextWindow"
>;

/** Cache key plus the tier it belongs to. The tier is part of the key. */
export async function keyFor(
  req: CacheableRequest,
  provider: string,
): Promise<{ key: string; tier: string }> {
  const { key, tier } = await cacheKey(req, provider);
  return { key, tier };
}

export class MessagingCache implements TranslationCache {
  private memory: MemoryLru<string>;
  private send: (message: unknown) => Promise<unknown>;

  constructor(
    send: (message: unknown) => Promise<unknown> = (m) => chrome.runtime.sendMessage(m),
    memoryLimit = 500,
  ) {
    this.memory = new MemoryLru<string>(memoryLimit);
    this.send = send;
  }

  async get(req: CacheableRequest, provider: string): Promise<string | null> {
    const { key } = await keyFor(req, provider);

    const hot = this.memory.get(key);
    if (hot !== undefined) return hot;

    try {
      const reply = (await this.send({ type: "cache-get", key })) as
        | { type: "cache-hit"; text: string }
        | { type: "cache-miss" }
        | undefined;
      if (reply?.type === "cache-hit") {
        this.memory.set(key, reply.text);
        return reply.text;
      }
    } catch {
      // The worker may be restarting. A cache miss is always a safe answer —
      // it costs a translation, never a wrong one.
    }
    return null;
  }

  async put(req: CacheableRequest, provider: string, text: string): Promise<void> {
    const { key, tier } = await keyFor(req, provider);
    this.memory.set(key, text);
    try {
      await this.send({ type: "cache-put", key, text, tier });
    } catch {
      // Same: losing a write costs a future translation, not correctness.
    }
  }
}

/** For tests and for running with no durable store at all. */
export class MemoryOnlyCache implements TranslationCache {
  private memory = new MemoryLru<string>(500);

  async get(req: CacheableRequest, provider: string): Promise<string | null> {
    return this.memory.get((await keyFor(req, provider)).key) ?? null;
  }

  async put(req: CacheableRequest, provider: string, text: string): Promise<void> {
    this.memory.set((await keyFor(req, provider)).key, text);
  }
}
