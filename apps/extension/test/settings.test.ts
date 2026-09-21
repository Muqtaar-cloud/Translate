import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  autoFor,
  clearConversationOverride,
  DEFAULT_SETTINGS,
  loadApiKey,
  loadSettings,
  saveApiKey,
  saveSettings,
  setConversationAuto,
  watchSettings,
} from "../src/shared/settings.js";

/**
 * A minimal `chrome.storage` stand-in.
 *
 * `sync` and `local` are kept as separate bags on purpose: the test that keeps
 * API keys out of `sync` is only meaningful if the two can actually differ.
 */
type Listener = (changes: Record<string, { newValue?: unknown }>, area: string) => void;

let sync: Record<string, unknown>;
let local: Record<string, unknown>;
let listeners: Listener[];

const area = (bag: () => Record<string, unknown>, name: string) => ({
  get: async (key: string) => ({ [key]: bag()[key] }),
  set: async (items: Record<string, unknown>) => {
    Object.assign(bag(), items);
    const changes = Object.fromEntries(
      Object.entries(items).map(([k, v]) => [k, { newValue: v }]),
    );
    for (const l of listeners) l(changes, name);
  },
});

beforeEach(() => {
  sync = {};
  local = {};
  listeners = [];
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      sync: area(() => sync, "sync"),
      local: area(() => local, "local"),
      onChanged: {
        addListener: (l: Listener) => listeners.push(l),
        removeListener: (l: Listener) => {
          listeners = listeners.filter((x) => x !== l);
        },
      },
    },
  };
});

describe("settings", () => {
  it("returns defaults when nothing is stored", async () => {
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  // Cloud means other people's messages leave the machine, and they have not
  // agreed to that. Off unless deliberately turned on.
  it("has cloud translation off by default, including in DMs", async () => {
    const settings = await loadSettings();
    expect(settings.cloudEnabled).toBe(false);
    expect(settings.cloudInDirectMessages).toBe(false);
  });

  it("round-trips saved settings", async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, target: "fr", knownLanguages: ["en", "fr"] });
    const settings = await loadSettings();
    expect(settings.target).toBe("fr");
    expect(settings.knownLanguages).toEqual(["en", "fr"]);
  });

  it("fills in fields missing from older stored settings", async () => {
    sync["polyglot.settings"] = { target: "de" };
    const settings = await loadSettings();
    expect(settings.target).toBe("de");
    expect(settings.perConversation).toEqual({});
    expect(settings.cloudEnabled).toBe(false);
  });
});

describe("API keys", () => {
  it("round-trips a key", async () => {
    await saveApiKey("deepl", "abc:fx");
    expect(await loadApiKey("deepl")).toBe("abc:fx");
  });

  it("keeps several providers apart", async () => {
    await saveApiKey("deepl", "one");
    await saveApiKey("anthropic", "two");
    expect(await loadApiKey("deepl")).toBe("one");
    expect(await loadApiKey("anthropic")).toBe("two");
  });

  // storage.local never leaves the device and survives a restart; storage.sync
  // would ship the key to every signed-in browser, and storage.session would
  // drop it whenever the browser closed.
  it("never writes a key into synced storage", async () => {
    await saveApiKey("deepl", "secret");
    expect(JSON.stringify(sync)).not.toContain("secret");
    expect(JSON.stringify(local)).toContain("secret");
  });
});

describe("per-conversation overrides", () => {
  it("defaults to translating a channel it has never seen", async () => {
    expect(autoFor(await loadSettings(), "discord:555/100")).toBe(true);
  });

  it("turns a single channel off without touching the others", async () => {
    await setConversationAuto("discord:555/memes", false);
    const settings = await loadSettings();
    expect(autoFor(settings, "discord:555/memes")).toBe(false);
    expect(autoFor(settings, "discord:555/general-es")).toBe(true);
  });

  it("turns one back on explicitly", async () => {
    await setConversationAuto("discord:555/memes", false);
    await setConversationAuto("discord:555/memes", true);
    expect(autoFor(await loadSettings(), "discord:555/memes")).toBe(true);
  });

  it("resets a channel to the default", async () => {
    await setConversationAuto("discord:555/memes", false);
    await clearConversationOverride("discord:555/memes");

    const settings = await loadSettings();
    expect(settings.perConversation["discord:555/memes"]).toBeUndefined();
    expect(autoFor(settings, "discord:555/memes")).toBe(true);
  });

  it("keeps overrides across unrelated setting changes", async () => {
    await setConversationAuto("discord:555/memes", false);
    await saveSettings({ ...(await loadSettings()), target: "fr" });
    expect(autoFor(await loadSettings(), "discord:555/memes")).toBe(false);
  });
});

describe("watchSettings", () => {
  // Without this the content script reads settings once at startup, and a
  // per-channel toggle does not take effect until reload — which for this
  // feature is the same as not working.
  it("fires when settings change elsewhere", async () => {
    const seen = vi.fn();
    watchSettings(seen);
    await setConversationAuto("discord:555/memes", false);

    expect(seen).toHaveBeenCalledOnce();
    expect(autoFor(seen.mock.calls[0]![0], "discord:555/memes")).toBe(false);
  });

  it("ignores changes to other storage areas, such as API keys", async () => {
    const seen = vi.fn();
    watchSettings(seen);
    await saveApiKey("deepl", "abc");
    expect(seen).not.toHaveBeenCalled();
  });

  it("stops firing once unsubscribed", async () => {
    const seen = vi.fn();
    watchSettings(seen)();
    await setConversationAuto("discord:555/memes", false);
    expect(seen).not.toHaveBeenCalled();
  });
});
