import { readFileSync } from "node:fs";

/**
 * Human-made reference translations, for known-good gold rows.
 *
 * The mismatch gold rows in prepare.ts have a known answer of "n" and can be
 * built for any language without reading it. Their blind spot is a rater who
 * answers "n" to everything: they pass every trap. Catching that needs rows
 * whose known answer is "y", which means a translation someone has already
 * checked, and nobody on this project reads the source languages. So the
 * translations come from outside: Tatoeba (tatoeba.org), whose sentences are
 * short, everyday and translated by people, and which publishes pairs for
 * hundreds of languages under CC-BY 2.0 FR.
 *
 * What this does not give you:
 *
 * - **Tatoeba is community-written.** A small share of its pairs are loose or
 *   wrong. A wrong "known-good" row makes a careful rater look careless, which
 *   is why the catch floor in score.ts is 80% and not 100%.
 * - **The originals are not from the chat.** Mismatch rows reuse real
 *   messages; these cannot. A rater who is in the channel may notice that
 *   nobody there said a given line. `chatLike` narrows the gap: short,
 *   first- and second-person, no stock names, no textbook facts. It cannot
 *   close it.
 * - **They catch a rater who is not reading, not one who is too strict.** A
 *   clean reference translation is obviously right, so a strict rater still
 *   answers "y". The spot-check warning in the score report stays for that.
 */
export interface ReferencePair {
  source: string;
  /** The sentence in the source language. Shown in the "original" column. */
  text: string;
  /** Its human translation into the target language. */
  translation: string;
  /** Attribution, as the source file gave it. CC-BY requires keeping it. */
  origin: string;
}

/**
 * Tatoeba's tab-separated pair format, as published per language pair on
 * manythings.org/anki and in Tatoeba's own sentence-pair downloads:
 *
 *   English sentence <TAB> other-language sentence [<TAB> attribution]
 *
 * The attribution column is optional because some mirrors strip it; when it
 * is missing, `fallbackOrigin` is recorded instead, so the licence credit is
 * never silently lost.
 */
export function parseTabbedPairs(
  tsv: string,
  source: string,
  fallbackOrigin: string,
): ReferencePair[] {
  const out: ReferencePair[] = [];
  for (const line of tsv.split("\n")) {
    const cols = line.replace(/\r$/, "").split("\t");
    const translation = cols[0]?.trim() ?? "";
    const text = cols[1]?.trim() ?? "";
    if (translation === "" || text === "") continue;
    out.push({ source, text, translation, origin: cols[2]?.trim() || fallbackOrigin });
  }
  return out;
}

/**
 * Tatoeba's placeholder cast. Close to a fifth of its English sentences name
 * Tom or Mary, and a chat sheet with "Tom" in it is a check row announcing
 * itself.
 */
const STOCK_NAMES = /\b(tom|mary|john|alice|bob|jack|ken)\b/i;

/** Pronouns that make a sentence sound addressed to someone, as chat is. */
const CONVERSATIONAL = /\b(i|i'm|i'll|i've|i'd|me|my|you|you're|you'll|your|we|we're|let's|us|our)\b/i;

export type RejectReason =
  | "length"
  | "stock-name"
  | "proper-noun"
  | "not-conversational"
  | "number";

/**
 * Keeps pairs that could pass for a line in a group chat. Returns the reason
 * a pair was rejected, or null when it is kept, so the import can report what
 * it threw away rather than just a smaller number.
 */
export function chatLike(pair: ReferencePair): RejectReason | null {
  const { text, translation } = pair;
  if (text.length < 15 || text.length > 70) return "length";
  if (text.split(/\s+/).length < 3) return "length";
  if (STOCK_NAMES.test(translation) || STOCK_NAMES.test(text)) return "stock-name";

  // A capital letter mid-sentence, other than "I", is almost always a name or
  // a place: "He has a large farm in Colorado." Those read as textbook facts,
  // and a name that nobody in the chat has is a giveaway.
  const inner = translation.split(/\s+/).slice(1);
  if (inner.some((w) => /^[A-Z]/.test(w) && !/^I('|$|\b)/.test(w))) return "proper-noun";

  if (/\d/.test(text)) return "number";

  // Chat is addressed to someone: a question, an exclamation, or first or
  // second person. Third-person narration is the textbook register.
  const addressed = /[?!]/.test(translation) || CONVERSATIONAL.test(translation);
  if (!addressed) return "not-conversational";

  return null;
}

const normalise = (s: string): string => s.toLowerCase().replace(/\s+/gu, " ").trim();

/**
 * Filters and dedupes an import, keeping at most `max` pairs.
 *
 * Deduped on the source-language side: Tatoeba often lists several English
 * renderings of one sentence, and the same original twice in a sheet would be
 * a pattern a rater could notice.
 */
export function selectReference(
  pairs: readonly ReferencePair[],
  max = 500,
): { kept: ReferencePair[]; rejected: Record<RejectReason | "duplicate", number> } {
  const rejected: Record<RejectReason | "duplicate", number> = {
    length: 0,
    "stock-name": 0,
    "proper-noun": 0,
    "not-conversational": 0,
    number: 0,
    duplicate: 0,
  };
  const seen = new Set<string>();
  const kept: ReferencePair[] = [];

  for (const p of pairs) {
    const reason = chatLike(p);
    if (reason) {
      rejected[reason]++;
      continue;
    }
    const key = normalise(p.text);
    if (seen.has(key)) {
      rejected.duplicate++;
      continue;
    }
    seen.add(key);
    kept.push(p);
  }

  // Spread the sample across the file rather than taking its first rows:
  // these exports are sorted by length, so the head is all two-word lines.
  if (kept.length <= max) return { kept, rejected };
  const step = kept.length / max;
  return { kept: Array.from({ length: max }, (_, i) => kept[Math.floor(i * step)] as ReferencePair), rejected };
}

export function formatReference(pairs: readonly ReferencePair[]): string {
  return pairs.map((p) => JSON.stringify(p)).join("\n") + "\n";
}

export function loadReference(path: string): ReferencePair[] {
  const out: ReferencePair[] = [];
  readFileSync(path, "utf8")
    .split("\n")
    .forEach((line, i) => {
      const t = line.trim();
      if (t === "" || t.startsWith("//")) return;
      let p: Partial<ReferencePair>;
      try {
        p = JSON.parse(t) as Partial<ReferencePair>;
      } catch {
        throw new Error(`${path} line ${i + 1}: not valid JSON`);
      }
      if (!p.text || !p.translation || !p.source) {
        throw new Error(`${path} line ${i + 1}: needs "source", "text" and "translation"`);
      }
      out.push({ source: p.source, text: p.text, translation: p.translation, origin: p.origin ?? "" });
    });
  return out;
}
