import { describe, expect, it } from "vitest";
import { cacheKey } from "../src/cache.js";

const base = { text: "sí, ese", source: "es", target: "en" } as const;

describe("cache keys (§4.4)", () => {
  it("is stable for identical context-free input", async () => {
    const a = await cacheKey(base, "on-device");
    const b = await cacheKey(base, "on-device");
    expect(a).toEqual(b);
    expect(a.tier).toBe("context-free");
  });

  it("separates providers", async () => {
    const a = await cacheKey(base, "on-device");
    const b = await cacheKey(base, "deepl");
    expect(a.key).not.toBe(b.key);
  });

  // The bug this tier split exists to prevent: the same text under different
  // surrounding messages has a different correct translation, so a single key
  // would serve "yes, that one" into a thread that needed "yeah, him".
  it("gives the same text different keys under different context", async () => {
    const a = await cacheKey({ ...base, contextWindow: ["¿quién viene?"] }, "llm");
    const b = await cacheKey({ ...base, contextWindow: ["¿qué coche?"] }, "llm");
    expect(a.key).not.toBe(b.key);
    expect(a.tier).toBe("context-assisted");
  });

  it("hits on a genuine repeat of both text and context", async () => {
    const ctx = { ...base, contextWindow: ["¿quién viene?"] };
    expect((await cacheKey(ctx, "llm")).key).toBe((await cacheKey(ctx, "llm")).key);
  });

  it("never lets the two tiers collide", async () => {
    const free = await cacheKey(base, "llm");
    const assisted = await cacheKey({ ...base, contextWindow: ["¿quién viene?"] }, "llm");
    expect(free.key).not.toBe(assisted.key);
    expect(free.key.startsWith("cf:")).toBe(true);
    expect(assisted.key.startsWith("ca:")).toBe(true);
  });
});
