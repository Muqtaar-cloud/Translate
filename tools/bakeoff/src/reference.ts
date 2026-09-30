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
 * Two line-aligned files, one sentence per line: line n of `sourceText`
 * translates line n of `englishText`. The layout of the Tatoeba test sets in
 * facebookresearch/LASER, the one copy of Tatoeba reachable from a sandbox
 * whose network blocks tatoeba.org, manythings.org and Hugging Face.
 */
export function parseAlignedPairs(
  sourceText: string,
  englishText: string,
  source: string,
  origin: string,
): ReferencePair[] {
  const src = sourceText.split("\n");
  const eng = englishText.split("\n");
  if (Math.abs(src.length - eng.length) > 1) {
    // A one-line difference is a trailing newline; more is misalignment, and a
    // misaligned file would turn every "known-good" row into a mismatch.
    throw new Error(`aligned files differ in length: ${src.length} vs ${eng.length} lines`);
  }
  const out: ReferencePair[] = [];
  for (let i = 0; i < Math.min(src.length, eng.length); i++) {
    const text = src[i]?.replace(/\r$/, "").trim() ?? "";
    const translation = eng[i]?.replace(/\r$/, "").trim() ?? "";
    if (text !== "" && translation !== "") out.push({ source, text, translation, origin });
  }
  return out;
}

/**
 * Characters that exist only in Traditional Chinese.
 *
 * Tatoeba's Mandarin mixes both scripts line by line. A chat uses one, so a
 * check row in the other script is a check row announcing itself. Not a
 * converter, and not complete: a line with none of these may still be
 * Traditional. Measured: the first, shorter list (function characters only)
 * let 14 of 100 Traditional lines through — 麻煩, 週, 髒, 滿, 筆, 證據, 藍, 斷,
 * 運, 體, 樓 — and the second still missed 禮, 擾, 獨, 傘, 兒, so it now covers
 * common content characters too. Whatever still slips through, review catches. Every entry has
 * a distinct Simplified form; characters shared by both scripts (麻, 幸, 眼,
 * 餐) are deliberately absent.
 */
const TRADITIONAL_ONLY = new Set(
  [
    "們這個說話沒還會為來時對國過關點麼開裡後現樣見學問讓車電請謝買賣東與從當發",
    "經頭長門間實應該幾網讀寫書氣歡難聽覺將錢貓愛變邊遠記錯雙雖醫號總種親機歲嗎",
    "給煩週內髒滿筆談證據藍領帶斷運體樓裝訂隻塊熱聲視臉鐘錶飯飲館鳥魚馬雞鴨貝風",
    "飛雲陽陰腦眾無燈爭戰畫劃節範韓華歷曆壞亂認識語誤課試詩誰調論設許計訊講議護",
    "權觀顏題顯類餓餘駕驗髮鬆鬧麗黨齊齒龍龜衛術補製複觸軍輕載輪轉辦農進適選郵釋",
    "鍵閉閒陳陸隊階際隨險隱離靜頁項順須顧飽養驚鬥鹽麥黃於裏夠",
    "禮擾獨傘兒夢聯蘭羅蘇義藝處虛衝襪訴詢誇賽贏趕跡蹤躍輩遲達違鄉鄰鍋鏡閃陣雜霧響頓頻顆餅驕鬍",
  ].join("").split(""),
);

/** Cantonese-only characters: a Cantonese line is a different language. */
const CANTONESE_ONLY = new Set("啲咩嚟㗎嘅佢冇喺哋咁嘢唔咗嗰".split(""));

export function isTraditionalChinese(text: string): boolean {
  for (const ch of text) if (TRADITIONAL_ONLY.has(ch)) return true;
  return false;
}

export function isCantonese(text: string): boolean {
  for (const ch of text) if (CANTONESE_ONLY.has(ch)) return true;
  return false;
}

/** Languages whose script is not Latin, so Latin letters in a line are a name. */
const NON_LATIN = new Set(["zh", "zh-Hant", "hi", "ar", "ru", "ja", "ko", "he", "el", "th"]);

/**
 * Tatoeba's placeholder cast. Close to a fifth of its English sentences name
 * Tom or Mary, and a chat sheet with "Tom" in it is a check row announcing
 * itself.
 */
const STOCK_NAMES = /\b(tom|mary|john|alice|bob|jack|ken)\b/i;

/** Pronouns that make a sentence sound addressed to someone, as chat is. */
const CONVERSATIONAL = /\b(i|i'm|i'll|i've|i'd|me|my|you|you're|you'll|your|we|we're|let's|us|our)\b/i;

export type RejectReason =
  | "script"
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
  // Length is judged on the English side, because it is the only side whose
  // length means the same thing in every language: fifteen characters is a
  // short Spanish line and a long Chinese one, and Chinese has no spaces to
  // count words by. The source side only gets a sanity cap.
  if (translation.length < 12 || translation.length > 70) return "length";
  if (translation.split(/\s+/).length < 3) return "length";
  if (text.length > 90) return "length";
  // "zh" is Simplified; "zh-Hant" is the import variant for a Traditional
  // chat, which keeps Traditional lines and still drops Cantonese.
  if (pair.source === "zh" && (isTraditionalChinese(text) || isCantonese(text))) return "script";
  if (pair.source === "zh-Hant" && isCantonese(text)) return "script";
  // "Luke，我是你的爸爸" — a name in Latin letters inside a non-Latin line
  // gets past the capital-letter check below, which only reads the English.
  if (NON_LATIN.has(pair.source) && /[A-Za-z]/.test(text)) return "proper-noun";
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
    script: 0,
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
