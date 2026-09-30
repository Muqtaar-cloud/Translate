/**
 * Builds tools/bakeoff/reference/<lang>.jsonl — the committed reference pairs
 * for known-good gold rows — from Tatoeba's test sets in facebookresearch/LASER.
 *
 *   npx tsx tools/bakeoff/scripts/build-reference.ts
 *
 * Reproducible end to end, and refuses to drift silently:
 *
 * - Every source file is checked against a pinned SHA-256. LASER's copy is a
 *   2018 snapshot that has not changed since, and if it ever does the build
 *   stops rather than producing pairs nobody reviewed.
 * - The candidate list the filter produces is hashed and compared with the one
 *   that was reviewed (reference/review.json). A change to `chatLike` or
 *   `selectReference` changes that list, and the build then stops and says so,
 *   instead of shipping new pairs past a review that never saw them.
 * - Rejections are keyed by sentence text, not position.
 *
 * Why LASER and not Tatoeba directly: this was built in a sandbox whose network
 * blocks tatoeba.org, manythings.org and Hugging Face. LASER's copy is the
 * 2018-11-17 Tatoeba snapshot, 1,000 English sentences and their translations
 * per language, and it was reachable. Tatoeba's licence (CC-BY 2.0 FR) permits
 * redistribution with attribution, which every line of the output carries.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAlignedPairs, selectReference, type ReferencePair } from "../src/reference.js";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "reference");
const BASE = "https://raw.githubusercontent.com/facebookresearch/LASER/main/data/tatoeba/v1";
const PER_LANGUAGE = 100;

const ORIGIN =
  "Tatoeba (tatoeba.org), CC-BY 2.0 FR; 2018-11-17 snapshot via facebookresearch/LASER data/tatoeba/v1";

/** ISO 639-1 as the collector and detector write it, then Tatoeba's code. */
const LANGUAGES: [string, string, Record<string, string>][] = [
  ["es", "spa", {
    spa: "f9628cea40481e8251f0999718bd893cff0f261752f5e526b3bc20284e2ca018",
    eng: "89e4470f4572040b1ca94b3edad97dcd8bd2f0141f072e12933b8659dadf917d",
  }],
  ["pt", "por", {
    por: "b0c926a232c9889a87a1a970f9399c5618c2d95baf204321e9da794c0aec16f5",
    eng: "deb4568cfb7b7cbbc060a7fe97c4639fb4680842f4fcd28df791ffdbb753855a",
  }],
  ["fr", "fra", {
    fra: "644172ff9642fefa9e41c29b7d6f44196518e84350dc44d4992e943c0cca92b6",
    eng: "5634220f8a26a9a23b84753a9aec0b0832e6bdaa9da3f83e0bd84c928c3f46e3",
  }],
  ["zh", "cmn", {
    cmn: "965d033966fcd186c89741ad49ab4b0a0b2bbd33e02666635ff3b2be23c1ac1f",
    eng: "29ba36232488f5806aceccac57c59c5e750ddd08edb40eef417e3ada9ff9a239",
  }],
  ["tr", "tur", {
    tur: "1ffa0acc006018b3105abda41a4d4ca42f3c122964a49b71793546367b079a86",
    eng: "a768df7dd3d1344f872a458b32c3a65e24f8381826ccb16ba6677426176c8121",
  }],
  ["hi", "hin", {
    hin: "15e4fb0a394be4438319f1d6955d1aea226e2a8c5ad38798b23b76ae43d742ed",
    eng: "adfce2269a55dbac69b25c0f4f6eb89e0f9383165485925a2e042e61b9480562",
  }],
];

interface Review {
  reviewer: string;
  languages: Record<
    string,
    { candidatesSha256: string; reviewed: number; wrongMeaning: number; rejected: { text: string; reason: string }[] }
  >;
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

async function fetchPinned(file: string, expected: string): Promise<string> {
  const res = await fetch(`${BASE}/${file}`);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  const text = await res.text();
  const got = sha256(text);
  if (got !== expected) {
    throw new Error(`${file}: content changed upstream (sha256 ${got}). Re-review before rebuilding.`);
  }
  return text;
}

const review = JSON.parse(readFileSync(join(OUT, "review.json"), "utf8")) as Review;

for (const [lang, code, hashes] of LANGUAGES) {
  const src = await fetchPinned(`tatoeba.${code}-eng.${code}`, hashes[code] as string);
  const eng = await fetchPinned(`tatoeba.${code}-eng.eng`, hashes["eng"] as string);

  const pairs = parseAlignedPairs(src, eng, lang, ORIGIN);
  const { kept } = selectReference(pairs, PER_LANGUAGE);

  const reviewed = review.languages[lang];
  if (!reviewed) throw new Error(`${lang}: no review in review.json`);
  const candidates = sha256(kept.map((p) => p.text).join("\n"));
  if (candidates !== reviewed.candidatesSha256) {
    throw new Error(
      `${lang}: the filter now produces different candidates than the ones reviewed. ` +
        "Dump them, review them, and update review.json before rebuilding.",
    );
  }

  const rejected = new Set(reviewed.rejected.map((r) => r.text));
  const missing = [...rejected].filter((t) => !kept.some((p) => p.text === t));
  if (missing.length > 0) throw new Error(`${lang}: rejections not among candidates: ${missing.join(" | ")}`);

  const final: ReferencePair[] = kept.filter((p) => !rejected.has(p.text));
  const header = [
    `// Reference pairs for known-good gold rows, language "${lang}". Built by scripts/build-reference.ts.`,
    `// Source: ${ORIGIN}.`,
    `// ${PER_LANGUAGE} chat-like pairs selected; ${rejected.size} rejected on review, ` +
      `${reviewed.wrongMeaning} of them for a wrong translation (reasons in review.json).`,
    `// Reviewed by ${review.reviewer}`,
  ].join("\n");
  writeFileSync(join(OUT, `${lang}.jsonl`), `${header}\n${final.map((p) => JSON.stringify(p)).join("\n")}\n`);
  console.log(`${lang}: ${final.length} pairs (${rejected.size} rejected, ${reviewed.wrongMeaning} for meaning)`);
}
