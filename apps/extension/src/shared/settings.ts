import { DEFAULT_DAILY_CHARS, type LanguageCode } from "@polyglot/core";

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

  /**
   * Append the original under an outbound translation.
   *
   * On by default, and it is the real mitigation for outbound risk: a bad
   * translation becomes self-correcting because any bilingual reader sees both
   * lines. Back-translation review cannot do that job — see outbound.ts.
   */
  appendOriginal: boolean;
  /** Terms never to translate, in either direction: project names, in-jokes. */
  glossary: string[];
  /** Daily cap on paid characters. On-device translation is free and unmetered. */
  dailyCharLimit: number;

  /**
   * When cloud was last turned on, and for which provider.
   *
   * §5 asks for one-time explicit consent *naming the provider*, which is an
   * event rather than a notice on a wall. Recording it means a future provider
   * can ask again rather than inheriting an agreement the user made about a
   * different company. Cleared when cloud is turned off, so the next time is a
   * fresh decision.
   */
  cloudConsent?: { provider: string; at: string };
}

export const DEFAULT_SETTINGS: Settings = {
  knownLanguages: ["en"],
  target: "en",
  cloudEnabled: false,
  cloudInDirectMessages: false,
  perConversation: {},
  appendOriginal: true,
  glossary: [],
  dailyCharLimit: DEFAULT_DAILY_CHARS,
};

/**
 * Settings live in `storage.sync`; API keys never do.
 *
 * Keys go in `storage.local` — it also never leaves the device, and unlike
 * `storage.session` it survives a browser restart. `session` would have meant
 * re-pasting a DeepL key every time the browser reopened, which reads as
 * security and is just breakage.
 */
/**
 * What the consent record becomes when the cloud toggle is saved.
 *
 * Pure and separate from the options page so the rule is testable: a consent
 * record that is wrong is worse than none, because it is evidence of an
 * agreement that was never made.
 *
 * - Off: no record. Re-enabling later is a fresh decision.
 * - Newly on, or on for a different provider: a new record, dated now.
 * - Already on for the same provider: the original date is kept, so saving an
 *   unrelated setting does not re-date the consent.
 */
export function nextCloudConsent(
  next: { enabled: boolean; provider: string },
  previous: { enabled: boolean; consent: { provider: string; at: string } | undefined },
  at: string,
): { provider: string; at: string } | null {
  if (!next.enabled) return null;
  if (previous.enabled && previous.consent?.provider === next.provider) return previous.consent;
  return { provider: next.provider, at };
}

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
