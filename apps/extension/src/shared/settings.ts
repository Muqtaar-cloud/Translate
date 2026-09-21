import type { LanguageCode } from "@polyglot/core";

export interface Settings {
  /** Languages I read. Never translated, never paid for. */
  knownLanguages: LanguageCode[];
  /** What everything is translated into. */
  target: LanguageCode;
  /** Off by default: cloud means other people's messages leave the machine. */
  cloudEnabled: boolean;
  cloudProvider?: "deepl" | "google";
  /** Separately gated, because a DM is not a group channel. */
  cloudInDirectMessages: boolean;
  /** Per-(guild, channel) overrides, keyed by the adapter's conversationId. */
  perConversation: Record<string, { auto: boolean }>;
}

export const DEFAULT_SETTINGS: Settings = {
  knownLanguages: ["en"],
  target: "en",
  cloudEnabled: false,
  cloudInDirectMessages: false,
  perConversation: {},
};

/**
 * Settings live in `storage.sync`; API keys never do.
 *
 * Keys go in `storage.local` — it also never leaves the device, and unlike
 * `storage.session` it survives a browser restart. `session` would have meant
 * re-pasting a DeepL key every time the browser reopened, which reads as
 * security and is just breakage.
 */
const KEY = "polyglot.settings";

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get(KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[KEY] as Partial<Settings> | undefined) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.sync.set({ [KEY]: settings });
}

const API_KEYS = "polyglot.apiKeys";

export async function loadApiKey(provider: string): Promise<string | undefined> {
  const stored = await chrome.storage.local.get(API_KEYS);
  return (stored[API_KEYS] as Record<string, string> | undefined)?.[provider];
}

export async function saveApiKey(provider: string, key: string): Promise<void> {
  const stored = await chrome.storage.local.get(API_KEYS);
  const keys = (stored[API_KEYS] as Record<string, string> | undefined) ?? {};
  await chrome.storage.local.set({ [API_KEYS]: { ...keys, [provider]: key } });
}

/** Is auto-translation on for this conversation? Defaults to on. */
export function autoFor(settings: Settings, conversationId: string): boolean {
  return settings.perConversation[conversationId]?.auto ?? true;
}

/**
 * Sets a per-channel override.
 *
 * Settings are keyed by (platform, guild, channel) rather than globally,
 * because the useful shape is "auto in #general-es, off in #memes". A single
 * global switch would make the feature all-or-nothing and it would get turned
 * off once and left off.
 */
export async function setConversationAuto(conversationId: string, auto: boolean): Promise<void> {
  const settings = await loadSettings();
  await saveSettings({
    ...settings,
    perConversation: { ...settings.perConversation, [conversationId]: { auto } },
  });
}

/** Removes an override, returning the conversation to the default (on). */
export async function clearConversationOverride(conversationId: string): Promise<void> {
  const settings = await loadSettings();
  const perConversation = { ...settings.perConversation };
  delete perConversation[conversationId];
  await saveSettings({ ...settings, perConversation });
}

/**
 * Calls back when settings change anywhere — another tab, the popup, the
 * options page.
 *
 * Without this the content script would read settings once at startup and a
 * toggle would not take effect until reload, which for a per-channel switch is
 * the same as not working.
 */
export function watchSettings(onChange: (settings: Settings) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ): void => {
    if (area !== "sync" || !(KEY in changes)) return;
    onChange({ ...DEFAULT_SETTINGS, ...(changes[KEY]?.newValue as Partial<Settings>) });
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
