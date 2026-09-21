import { describe, expect, it, vi } from "vitest";
import { Batcher, mapWithLimit } from "../src/content/batch.js";

const echo = async (items: { key: string; value: string }[]): Promise<Map<string, string>> =>
  new Map(items.map((i) => [i.key, `T(${i.value})`]));

describe("Batcher", () => {
  it("groups items queued inside the debounce window into one dispatch", async () => {
    const dispatch = vi.fn(echo);
    const batcher = new Batcher(dispatch, { debounceMs: 5 });

    const results = await Promise.all([
      batcher.add("a", "one"),
      batcher.add("b", "two"),
      batcher.add("c", "three"),
    ]);

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]?.[0]).toHaveLength(3);
    expect(results).toEqual(["T(one)", "T(two)", "T(three)"]);
  });

  // The real saving on the automatic path: six people typing "gm" in one
  // second cost one translation, not six.
  it("deduplicates repeated keys into a single translation", async () => {
    const dispatch = vi.fn(echo);
    const batcher = new Batcher(dispatch, { debounceMs: 5 });

    const results = await Promise.all([
      batcher.add("gm", "gm"),
      batcher.add("gm", "gm"),
      batcher.add("gm", "gm"),
    ]);

    expect(dispatch.mock.calls[0]?.[0]).toHaveLength(1);
    expect(results).toEqual(["T(gm)", "T(gm)", "T(gm)"]);
  });

  it("dispatches immediately once maxSize is reached, without waiting", async () => {
    const dispatch = vi.fn(echo);
    const batcher = new Batcher(dispatch, { debounceMs: 60_000, maxSize: 2 });

    const pending = Promise.all([batcher.add("a", "1"), batcher.add("b", "2")]);
    // Would hang for a minute if the size trigger did not fire.
    await expect(pending).resolves.toEqual(["T(1)", "T(2)"]);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("starts a fresh window after a flush", async () => {
    const dispatch = vi.fn(echo);
    const batcher = new Batcher(dispatch, { debounceMs: 1 });

    await batcher.add("a", "1");
    await batcher.add("b", "2");
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("rejects every waiter when a dispatch throws", async () => {
    const batcher = new Batcher<string, string>(
      async () => {
        throw new Error("provider down");
      },
      { debounceMs: 1 },
    );

    await expect(Promise.all([batcher.add("a", "1"), batcher.add("b", "2")])).rejects.toThrow(
      "provider down",
    );
  });

  // A dispatch that quietly drops a key would otherwise leave its callers
  // pending forever, and the layer stuck on "translating…".
  it("rejects a key the dispatch returned no result for", async () => {
    const batcher = new Batcher<string, string>(
      async (items) => new Map(items.slice(1).map((i) => [i.key, i.value])),
      { debounceMs: 1 },
    );

    const first = batcher.add("dropped", "1");
    const second = batcher.add("kept", "2");

    await expect(first).rejects.toThrow(/no result for dropped/);
    await expect(second).resolves.toBe("2");
  });

  it("reports what is queued and drains cleanly", async () => {
    const batcher = new Batcher(echo, { debounceMs: 60_000 });
    const pending = batcher.add("a", "1");
    expect(batcher.pending).toBe(1);

    await batcher.drain();
    await expect(pending).resolves.toBe("T(1)");
    expect(batcher.pending).toBe(0);
  });

  it("does nothing on an empty flush", async () => {
    const dispatch = vi.fn(echo);
    await new Batcher(dispatch, { debounceMs: 1 }).flush();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("mapWithLimit", () => {
  it("preserves input order", async () => {
    const out = await mapWithLimit([1, 2, 3, 4], 2, async (n) => n * 2);
    expect(out).toEqual([2, 4, 6, 8]);
  });

  // Releasing a screenful of backlog must not fire forty concurrent model
  // invocations at the main thread.
  it("never exceeds the concurrency ceiling", async () => {
    let active = 0;
    let peak = 0;

    await mapWithLimit(Array.from({ length: 20 }, (_, i) => i), 3, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 1));
      active--;
      return n;
    });

    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it("handles an empty list", async () => {
    expect(await mapWithLimit([], 4, async (n) => n)).toEqual([]);
  });
});
