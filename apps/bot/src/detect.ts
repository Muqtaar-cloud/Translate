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
 * This is a heuristic, and a deliberately modest one: script ranges, which are
 * decisive, plus stopword scoring for Latin-script languages, which is not.
 * It is weaker than the browser's detector and it is weakest on exactly the
 * short messages chat is full of. That is a real quality gap between the two
 * products, not a detail — and it is the sort of thing the bake-off should
 * measure before Phase 3 is trusted.
 *
 * Injectable throughout, so a better detector (CLD3/franc via WASM, or a
 * provider's own auto-detection) can replace it without touching the handlers.
 */

const SCRIPTS: [RegExp, string][] = [
  [/[؀-ۿݐ-ݿ]/u, "ar"],
  [/[֐-׿]/u, "he"],
  [/[Ѐ-ӿ]/u, "ru"],
  [/[Ͱ-Ͽ]/u, "el"],
  [/[ऀ-ॿ]/u, "hi"],
  [/[぀-ゟ゠-ヿ]/u, "ja"],
  [/[가-힯]/u, "ko"],
  [/[一-鿿]/u, "zh"],
  [/[฀-๿]/u, "th"],
];

/** Common function words. Short, frequent, and rarely shared across languages. */
const STOPWORDS: Record<string, string[]> = {
  es: ["que", "de", "la", "el", "en", "no", "los", "una", "por", "con", "para", "está", "pero"],
  pt: ["que", "de", "não", "para", "com", "uma", "os", "mas", "por", "já", "você", "então"],
  fr: ["que", "de", "le", "la", "les", "des", "est", "pas", "pour", "vous", "avec", "mais"],
  de: ["der", "die", "das", "und", "ist", "nicht", "ein", "eine", "mit", "auch", "aber", "wir"],
  it: ["che", "di", "il", "la", "non", "per", "con", "una", "sono", "ma", "anche", "come"],
  en: ["the", "is", "you", "and", "to", "of", "it", "that", "for", "with", "are", "but"],
  tr: ["bir", "ve", "bu", "için", "ama", "çok", "ne", "var", "daha", "gibi"],
};

/**
 * Orthographic cues: characters and marks that only a few languages use.
 *
 * Added after the stopword pass alone failed on "¿vienes mañana a la fiesta?" —
 * its only stopword, "la", belongs to both Spanish and French, so the tie rule
 * below correctly refused to guess and the bot declined to translate perfectly
 * ordinary Spanish. Function words are shared across related languages;
 * orthography often is not, and `¿` and `ñ` settle that particular tie
 * immediately.
 */
const ORTHOGRAPHY: [RegExp, string, number][] = [
  [/[¿¡]/u, "es", 3],
  [/ñ/iu, "es", 2],
  [/[ãõ]/iu, "pt", 3],
  [/ç/iu, "pt", 1],
  [/ß/iu, "de", 3],
  [/[äöü]/iu, "de", 1],
  [/œ/iu, "fr", 3],
  [/[àèùêô]/iu, "fr", 1],
  [/[ğşı]/iu, "tr", 3],
];

export const MIN_RELIABLE_CHARS = 15;

/**
 * Best-effort detection.
 *
 * Returns an empty list rather than a guess when there is not enough to go on.
 * A wrong source language produces confident nonsense, which is worse in a
 * group chat than no translation at all — everyone sees it, and nobody can tell
 * it was the detector rather than the translator.
 */
export function detectLanguage(text: string): Detection[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];

  for (const [pattern, lang] of SCRIPTS) {
    if (pattern.test(trimmed)) return [{ lang, confidence: 0.9 }];
  }

  if (trimmed.length < MIN_RELIABLE_CHARS) return [];

  const words = trimmed
    .toLowerCase()
    .split(/[^\p{L}\p{M}']+/u)
    .filter(Boolean);
  if (words.length < 3) return [];

  const tally = new Map<string, number>();
  for (const [lang, list] of Object.entries(STOPWORDS)) {
    const hits = words.filter((w) => list.includes(w)).length;
    if (hits > 0) tally.set(lang, hits);
  }
  for (const [pattern, lang, weight] of ORTHOGRAPHY) {
    if (pattern.test(trimmed)) tally.set(lang, (tally.get(lang) ?? 0) + weight);
  }

  const scores = [...tally]
    .map(([lang, hits]) => ({ lang, hits }))
    .sort((a, b) => b.hits - a.hits);

  const best = scores[0];
  if (!best) return [];

  const runnerUp = scores[1]?.hits ?? 0;
  // A tie between two languages is not a detection. Spanish and Portuguese
  // share enough function words that a one-hit lead means nothing.
  if (best.hits === runnerUp) return [];

  const confidence = Math.min(0.85, 0.45 + best.hits / words.length);
  return [{ lang: best.lang, confidence }];
}

export type Detector = (text: string) => Detection[];
