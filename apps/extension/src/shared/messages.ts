import type { Availability } from "@polyglot/core";

/**
 * Content script <-> service worker protocol.
 *
 * Note what is NOT here: translation requests for the on-device path. Chrome's
 * built-in Translator is unavailable in Web Worker contexts, and an MV3 service
 * worker is one, so on-device translation happens in the content script and
 * never crosses this boundary. The worker handles settings, cloud calls and
 * counters.
 */

export type ToBackground =
  | { type: "get-settings" }
  | { type: "cloud-translate"; provider: string; source: string; target: string; text: string }
  /**
   * PLAN.md §2: what share of machines can actually run the on-device path?
   * Not externally knowable, but the extension has to call `availability()` to
   * function — so log the distribution and the question stops being rhetorical
   * by the time the public-release decision comes up.
   *
   * Counters only. No message content, ever.
   */
  | { type: "report-availability"; pair: string; state: Availability }
  | { type: "report-adapter-health"; adapter: string; ok: boolean; detail: string }
  /**
   * The durable cache lives in the worker, not here: a content script's
   * IndexedDB belongs to discord.com's origin, where Discord can clear it and
   * where no other tab can share it.
   */
  | { type: "cache-get"; key: string }
  | { type: "cache-put"; key: string; text: string; tier: string }
  /**
   * The LLM escalation. Carries the whole request so `initiation` and
   * `contextWindow` cannot be separated in transit — the worker re-checks the
   * context policy before anything leaves the machine.
   */
  | { type: "llm-translate"; request: import("@polyglot/core").TranslationRequest }
  /**
   * Quota lives in the worker so one budget covers every tab, and so a reload
   * cannot reset it.
   */
  | { type: "quota-remaining" }
  | { type: "quota-record"; chars: number };

export type FromBackground =
  | { type: "settings"; settings: import("./settings.js").Settings }
  | { type: "translation"; text: string }
  | { type: "error"; message: string }
  | { type: "cache-hit"; text: string }
  | { type: "cache-miss" }
  | { type: "quota"; remaining: number }
  | { type: "ok" };
