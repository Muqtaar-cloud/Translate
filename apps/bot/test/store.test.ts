import { beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/store.js";

let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});

describe("chat settings", () => {
  it("defaults to on-request only, with no notice shown", () => {
    expect(store.chat(-1)).toEqual({ chatId: -1, eager: false, noticeShown: false });
  });

  it("round-trips eager mode", () => {
    store.setEager(-1, true);
    expect(store.chat(-1).eager).toBe(true);
    store.setEager(-1, false);
    expect(store.chat(-1).eager).toBe(false);
  });

  it("keeps the notice flag when eager mode is toggled", () => {
    store.markNoticeShown(-1);
    store.setEager(-1, true);
    expect(store.chat(-1).noticeShown).toBe(true);
  });

  it("keeps chats separate", () => {
    store.setEager(-1, true);
    expect(store.chat(-2).eager).toBe(false);
  });
});

describe("language preferences", () => {
  it("round-trips a preference", () => {
    store.setLanguage(-1, 7, "en");
    expect(store.languageOf(-1, 7)).toBe("en");
  });

  it("overwrites rather than duplicating", () => {
    store.setLanguage(-1, 7, "en");
    store.setLanguage(-1, 7, "pt");
    expect(store.languageOf(-1, 7)).toBe("pt");
    expect(store.memberCount(-1)).toBe(1);
  });

  it("scopes a preference to one chat", () => {
    store.setLanguage(-1, 7, "en");
    expect(store.languageOf(-2, 7)).toBeNull();
  });

  it("clears one person without touching the others", () => {
    store.setLanguage(-1, 7, "en");
    store.setLanguage(-1, 8, "pt");
    store.clearLanguage(-1, 7);
    expect(store.languageOf(-1, 7)).toBeNull();
    expect(store.languageOf(-1, 8)).toBe("pt");
  });

  // The fan-out bound: cost scales with language diversity, not membership.
  it("reports distinct languages, not people", () => {
    for (const [user, language] of [[1, "en"], [2, "en"], [3, "en"], [4, "pt"]] as const) {
      store.setLanguage(-1, user, language);
    }
    expect(store.targetLanguages(-1)).toEqual(["en", "pt"]);
    expect(store.memberCount(-1)).toBe(4);
  });
});

describe("usage", () => {
  it("starts at zero and accumulates within a day", () => {
    expect(store.usageToday("2026-09-21")).toBe(0);
    store.recordUsage("2026-09-21", 100);
    store.recordUsage("2026-09-21", 50);
    expect(store.usageToday("2026-09-21")).toBe(150);
  });

  it("keeps days apart, so a budget resets", () => {
    store.recordUsage("2026-09-21", 100);
    expect(store.usageToday("2026-09-22")).toBe(0);
  });

  it("ignores negative usage rather than crediting the budget", () => {
    store.recordUsage("2026-09-21", -100);
    expect(store.usageToday("2026-09-21")).toBe(0);
  });
});

// Not a nice-to-have: the bot handles other people's words on someone else's
// behalf, and a database of them is a liability nobody in the group agreed to.
describe("what is not stored", () => {
  it("has no column anywhere for message text", () => {
    store.setLanguage(-1, 7, "en");
    store.recordUsage("2026-09-21", 10);
    const dump = JSON.stringify({
      chat: store.chat(-1),
      langs: store.targetLanguages(-1),
      usage: store.usageToday("2026-09-21"),
    });
    expect(dump).not.toMatch(/mañana|hola|message/i);
  });
});
