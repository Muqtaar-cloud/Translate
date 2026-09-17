import type { FromBackground, ToBackground } from "../shared/messages.js";
import { loadApiKey, loadSettings } from "../shared/settings.js";

/**
 * MV3 service worker.
 *
 * Handles settings, cloud calls and counters. It deliberately does NOT do
 * on-device translation: Chrome's built-in Translator is unavailable in Web
 * Worker contexts, and this is one. That work lives in the content script.
 */

/** Counters only. Message content never reaches this file. */
const COUNTERS = "polyglot.counters";

async function bump(key: string): Promise<void> {
  const stored = await chrome.storage.local.get(COUNTERS);
  const counters = (stored[COUNTERS] as Record<string, number> | undefined) ?? {};
  counters[key] = (counters[key] ?? 0) + 1;
  await chrome.storage.local.set({ [COUNTERS]: counters });
}

async function cloudTranslate(
  provider: string,
  source: string,
  target: string,
  text: string,
): Promise<FromBackground> {
  const settings = await loadSettings();
  if (!settings.cloudEnabled) {
    // Belt and braces. Routing should never have produced a cloud decision
    // with cloud disabled, but this is the last gate before content leaves the
    // machine, so it checks again rather than trusting the caller.
    return { type: "error", message: "cloud translation is disabled" };
  }

  const key = await loadApiKey(provider);
  if (!key) return { type: "error", message: `no API key for ${provider}` };

  if (provider !== "deepl") {
    return { type: "error", message: `provider ${provider} is not implemented` };
  }

  const endpoint = key.endsWith(":fx")
    ? "https://api-free.deepl.com/v2/translate"
    : "https://api.deepl.com/v2/translate";

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `DeepL-Auth-Key ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        text: [text],
        source_lang: source.toUpperCase(),
        target_lang: target.toUpperCase(),
        // No `context` field, and this is not an oversight. DeepL's context
        // parameter is unbilled, so cost will never push back on sending
        // surrounding messages with every automatic translation — only a rule
        // does. Context is permitted on user-initiated paths only.
      }),
    });

    if (!response.ok) {
      await bump(`cloud.error.${response.status}`);
      return { type: "error", message: `${response.status} ${response.statusText}` };
    }

    const body = (await response.json()) as { translations?: { text: string }[] };
    await bump("cloud.ok");
    await bump(`cloud.chars.${Math.ceil(text.length / 100) * 100}`);
    return { type: "translation", text: body.translations?.[0]?.text ?? "" };
  } catch (error) {
    await bump("cloud.error.network");
    return { type: "error", message: String(error) };
  }
}

chrome.runtime.onMessage.addListener(
  (message: ToBackground, _sender, respond: (r: FromBackground) => void) => {
    void (async () => {
      switch (message.type) {
        case "get-settings":
          respond({ type: "settings", settings: await loadSettings() });
          break;

        case "cloud-translate":
          respond(
            await cloudTranslate(message.provider, message.source, message.target, message.text),
          );
          break;

        case "report-availability":
          await bump(`availability.${message.state}`);
          await bump(`pair.${message.pair}.${message.state}`);
          respond({ type: "ok" });
          break;

        case "report-adapter-health":
          await bump(`adapter.${message.adapter}.${message.ok ? "ok" : "broken"}`);
          respond({ type: "ok" });
          break;
      }
    })();
    return true; // async response
  },
);
