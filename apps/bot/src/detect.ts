import { heuristicDetect } from "@polyglot/core";
import type { Detection } from "@polyglot/core";

/**
 * Language detection for the server.
 *
 * **An asymmetry §8 did not list.** The browser hands the extension a
 * `LanguageDetector` for free; a server has no such thing. Detection is a
 * prerequisite for translating anything — NLLB needs an explicit source
 * language, and "translate into everyone's language" is meaningless without
 * knowing what language it is already in — so the bot has to bring its own.
 *
 * The rules themselves now live in `@polyglot/core` (`heuristicDetect`): the
 * Phase 0b corpus collector needs the same detector and cannot import from an
 * app. This module stays as the bot's seam, so a better detector (CLD3/franc
 * via WASM, or a provider's own auto-detection) can be swapped in here without
 * touching the handlers.
 */

/** Sync, unlike core's injected `Detector`: the bot has nothing to await. */
export type Detector = (text: string) => Detection[];

export const detectLanguage: Detector = heuristicDetect;

export { MIN_RELIABLE_CHARS } from "@polyglot/core";
