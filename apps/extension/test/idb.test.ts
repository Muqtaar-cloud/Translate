import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_BYTES, TranslationStore, TTL_MS } from "../src/background/idb.js";

let clock = Date.UTC(2026, 0, 1);
const now = (): number => clock;
let store: TranslationStore;

beforeEach(() => {
  clock = Date.UTC(2026, 0, 1);
  // A fresh factory per test: these share a database name.
  store = new TranslationStore(new IDBFactory(), now);
});

describe("TranslationStore", () => {
  it("round-trips a translation", async () => {
    await store.put("k1", "are you coming tomorrow?", "context-free");
    expect(await store.get("k1")).toBe("are you coming tomorrow?");
  });

  it("misses cleanly on an unknown key", async () => {
    expect(await store.get("nope")).toBeNull();
  });

  it("overwrites an existing key rather than duplicating it", async () => {
    await store.put("k1", "first", "context-free");
    await store.put("k1", "second", "context-free");
    expect(await store.get("k1")).toBe("second");
  });

  it("keeps the two cache tiers distinguishable for auditing", async () => {
    await store.put("cf:x", "free", "context-free");
    await store.put("ca:x", "assisted", "context-assisted");
    expect(await store.get("cf:x")).toBe("free");
    expect(await store.get("ca:x")).toBe("assisted");
  });

  describe("TTL", () => {
    it("serves an entry inside the window", async () => {
      await store.put("k1", "hola", "context-free");
      clock += TTL_MS - 1000;
      expect(await store.get("k1")).toBe("hola");
    });

    it("drops an entry past the window on read", async () => {
      await store.put("k1", "hola", "context-free");
      clock += TTL_MS + 1000;
      expect(await store.get("k1")).toBeNull();
      // And it is gone, not merely hidden.
      clock -= TTL_MS + 1000;
      expect(await store.get("k1")).toBeNull();
    });

    it("a read refreshes recency but not the expiry clock", async () => {
      await store.put("k1", "hola", "context-free");
      clock += TTL_MS - 1000;
      await store.get("k1"); // touch
      clock += 2000; // now past creation + TTL
      expect(await store.get("k1")).toBeNull();
    });
  });

  describe("eviction", () => {
    it("reports sizes and removes expired entries", async () => {
      await store.put("old", "x".repeat(100), "context-free");
      clock += TTL_MS + 1;
      await store.put("new", "y".repeat(100), "context-free");

      const { expired } = await store.evict();
      expect(expired).toBe(1);
      expect(await store.get("new")).not.toBeNull();
    });

    it("evicts least-recently-used first when over budget", async () => {
      const big = "z".repeat(1000);
      await store.put("a", big, "context-free");
      clock += 1000;
      await store.put("b", big, "context-free");
      clock += 1000;
      await store.put("c", big, "context-free");

      clock += 1000;
      await store.get("a"); // "a" becomes the most recently used

      const { evicted } = await store.evict(2100); // room for roughly two
      expect(evicted).toBeGreaterThan(0);
      expect(await store.get("a")).not.toBeNull(); // hot key survives
      expect(await store.get("b")).toBeNull(); // coldest goes first
    });

    it("leaves a store under budget alone", async () => {
      await store.put("a", "small", "context-free");
      expect(await store.evict()).toEqual({ expired: 0, evicted: 0 });
      expect(await store.get("a")).toBe("small");
    });

    it("tracks total bytes", async () => {
      await store.put("a", "x".repeat(10), "context-free");
      await store.put("b", "y".repeat(20), "context-free");
      // key length plus text length for each entry
      expect(await store.size()).toBe(1 + 10 + 1 + 20);
    });

    it("budgets to the documented 50MB", () => {
      expect(MAX_BYTES).toBe(50 * 1024 * 1024);
    });
  });

  // MV3 kills an idle worker and takes the database handle with it. Reopening
  // is normal operation, not an error path.
  it("reopens after the handle is closed", async () => {
    await store.put("k1", "hola", "context-free");
    store.close();
    expect(await store.get("k1")).toBe("hola");
  });

  it("clears", async () => {
    await store.put("k1", "hola", "context-free");
    await store.clear();
    expect(await store.get("k1")).toBeNull();
  });
});
