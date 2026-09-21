import { describe, expect, it } from "vitest";
import { MemoryLru } from "../src/lru.js";

describe("MemoryLru", () => {
  it("stores and returns values", () => {
    const lru = new MemoryLru<string>(3);
    lru.set("a", "1");
    expect(lru.get("a")).toBe("1");
    expect(lru.get("missing")).toBeUndefined();
  });

  it("evicts the least recently used entry when full", () => {
    const lru = new MemoryLru<string>(2);
    lru.set("a", "1");
    lru.set("b", "2");
    lru.set("c", "3");
    expect(lru.get("a")).toBeUndefined();
    expect(lru.get("b")).toBe("2");
    expect(lru.get("c")).toBe("3");
  });

  it("counts a read as a use, so a hot key survives", () => {
    const lru = new MemoryLru<string>(2);
    lru.set("a", "1");
    lru.set("b", "2");
    lru.get("a"); // "a" is now the most recent
    lru.set("c", "3");
    expect(lru.get("a")).toBe("1");
    expect(lru.get("b")).toBeUndefined();
  });

  it("overwrites without growing", () => {
    const lru = new MemoryLru<string>(2);
    lru.set("a", "1");
    lru.set("a", "2");
    expect(lru.size).toBe(1);
    expect(lru.get("a")).toBe("2");
  });

  it("reports keys oldest first", () => {
    const lru = new MemoryLru<string>(3);
    lru.set("a", "1");
    lru.set("b", "2");
    lru.get("a");
    expect(lru.keys()).toEqual(["b", "a"]);
  });

  it("rejects a nonsensical limit rather than silently caching nothing", () => {
    expect(() => new MemoryLru(0)).toThrow(RangeError);
  });
});
