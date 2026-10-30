import { MIN_RELIABLE_CHARS } from "./detect.js";
import type { Detection } from "./types.js";

/**
 * A script-and-stopword language detector, for consumers that have no platform
 * one.
 *
 * Written for the Telegram bot, which unlike the extension gets no
 * `LanguageDetector` from its runtime (PLAN.md §8 did not list this asymmetry;
 * the bot exposed it). It now has a second such consumer — the Phase 0b corpus
 * collector, which has to label a message's source language before any engine
 * can be asked to translate it — so it lives here rather than inside one app
 * where the other cannot reach it.
 *
 * It is deliberately modest: script ranges, which are decisive, plus stopword
 * and orthographic scoring for Latin-script languages, which is not. It is
 * weaker than a browser's detector and weakest on exactly the short messages
 * chat is full of. Treat its output as a proposal, not a fact — the collector
 * flags what it is unsure about for review rather than writing a guess into the
 * corpus.
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
  es: ["que", "de", "la", "el", "en", "no", "los", "una", "por", "con", "para", "está", "pero", "yo", "muy", "tengo", "estoy", "también", "le", "os"],
  // "está" and "no" are as common in Portuguese as in Spanish, and listing them
  // under `es` alone handed Spanish a one-word lead on plainly Portuguese text
  // ("alguém pode trazer gelo por favor está quente" scored es=2, pt=1 and was
  // labelled Spanish). A word shared by two languages belongs in both lists, so
  // it cancels out and the tie rule decides — which for this pair means
  // declining to guess, which is the correct answer.
  pt: ["que", "de", "não", "para", "com", "uma", "os", "mas", "por", "já", "você", "então", "está", "no", "eu", "muito", "também", "estou", "tenho", "meu", "minha", "mais"],
  fr: ["que", "de", "le", "la", "les", "des", "est", "pas", "pour", "vous", "avec", "mais", "je", "suis", "c'est", "j'ai", "très", "et", "en", "il", "ce", "une", "mon", "ne"],
  de: ["der", "die", "das", "und", "ist", "nicht", "ein", "eine", "mit", "auch", "aber", "wir"],
  it: ["che", "di", "il", "la", "non", "per", "con", "una", "sono", "ma", "anche", "come"],
  en: ["the", "is", "you", "and", "to", "of", "it", "that", "for", "with", "are", "but"],
  // Question particles and pronouns: frequent, and shared with none of the
  // other lists ("mi" is left out — it is Spanish and Italian too).
  tr: ["bir", "ve", "bu", "için", "ama", "çok", "ne", "var", "daha", "gibi", "ben", "sen", "değil", "mı", "mu", "mü", "musun", "misin", "mısın"],
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
  [/ß/iu, "de", 3],
  // Not ö or ü: Turkish uses both constantly, and with them here plainly
  // Turkish text with no ğ, ş or ı scored as German (4 of 90 reference
  // sentences). ä is the one German-only vowel of the three.
  [/ä/iu, "de", 1],
  [/œ/iu, "fr", 3],
  // Not à, ê or ô: Portuguese uses all three ("você", "avô", "à"), and with
  // them here Portuguese scored as French (6 of 95 reference sentences).
  [/[èù]/iu, "fr", 1],
  [/[ğşı]/iu, "tr", 3],
];

/**
 * Hindi written in Latin letters ("kya kar rahe ho aaj shaam ko"), labelled
 * `hi-Latn` (BCP 47), the tag Chrome's Translator accepts as a source.
 *
 * Many Indian group chats are written this way rather than in Devanagari, and
 * before this the detector declined every such line: the only thing it knew
 * about Hindi was the script.
 *
 * Distinctive words only. Hindi's commonest little words are left out because
 * they are words elsewhere too: "ho" (Italian "I have"), "mein" (German), "se"
 * (Spanish, French, Portuguese), and ka/ki/ke/ko/na/to/me/main. A line needs
 * two distinct hits, so a single "hai" in Italian ("hai fame?") is not enough.
 * Romanised Urdu is largely the same text; it is labelled hi-Latn as well,
 * which is the honest limit of a word list.
 */
const HINDI_LATIN = new Set([
  "hai", "hain", "nahi", "nahin", "kya", "kyun", "kyon", "kaise", "kahan", "kab", "kitne", "kitna",
  "mujhe", "mujhko", "tujhe", "tumhe", "tumko", "tumhara", "tumhari", "mera", "meri", "mere", "tera",
  "teri", "hum", "humein", "aap", "aapka", "aapko", "yaar", "bhai", "accha", "acha", "achha", "theek",
  "thik", "abhi", "bahut", "bohot", "kuch", "raha", "rahe", "rahi", "gaya", "gayi", "gaye", "karo",
  "karna", "karte", "karta", "kiya", "hoon", "hun", "bhi", "toh", "wala", "wali", "wale", "lekin",
  "phir", "dekho", "chalo", "aaj", "kal", "baad", "pehle", "saath", "liye", "tum", "unko", "usko",
  "haan", "nahi", "batao", "dena", "lena", "jana", "aana", "milte", "baje", "kitni", "kaun", "sabka",
]);
const HINDI_LATIN_MIN_HITS = 2;

/**
 * Best-effort detection.
 *
 * Returns an empty list rather than a guess when there is not enough to go on.
 * A wrong source language produces confident nonsense, which is worse in a
 * group chat than no translation at all — everyone sees it, and nobody can tell
 * it was the detector rather than the translator.
 */
export function heuristicDetect(text: string): Detection[] {
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
  const hindiHits = new Set(words.filter((w) => HINDI_LATIN.has(w))).size;
  if (hindiHits >= HINDI_LATIN_MIN_HITS) tally.set("hi-Latn", hindiHits);

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

