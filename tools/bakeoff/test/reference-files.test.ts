import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { heuristicDetect } from "@polyglot/core";
import { chatLike, isCantonese, isTraditionalChinese, loadReference } from "../src/reference.js";

/**
 * The committed reference files are the ground truth for known-good gold rows:
 * a bad line there makes a careful rater look careless. These tests check the
 * files as shipped, not the code that built them.
 */
const DIR = join(process.cwd(), "tools/bakeoff/reference");
const LANGUAGES = ["es", "pt", "fr", "zh", "tr", "hi"];
const review = JSON.parse(readFileSync(join(DIR, "review.json"), "utf8")) as {
  languages: Record<string, { rejected: { text: string; reason: string }[] }>;
};

describe.each(LANGUAGES)("reference/%s.jsonl", (lang) => {
  const pairs = loadReference(join(DIR, `${lang}.jsonl`));

  it("has enough pairs that a sheet's 20 known-good rows vary between runs", () => {
    expect(pairs.length).toBeGreaterThanOrEqual(60);
  });

  it("is all one language, all attributed", () => {
    expect(pairs.every((p) => p.source === lang)).toBe(true);
    expect(pairs.every((p) => p.origin.includes("CC-BY 2.0 FR"))).toBe(true);
  });

  it("contains nothing the review rejected", () => {
    const rejected = new Set(review.languages[lang]?.rejected.map((r) => r.text));
    expect(rejected.size).toBeGreaterThan(0);
    expect(pairs.filter((p) => rejected.has(p.text))).toEqual([]);
  });

  it("passes the chat filter it was built with", () => {
    expect(pairs.filter((p) => chatLike(p) !== null)).toEqual([]);
  });

  it("has no duplicate originals", () => {
    expect(new Set(pairs.map((p) => p.text)).size).toBe(pairs.length);
  });
});

describe("reference/zh.jsonl", () => {
  const pairs = loadReference(join(DIR, "zh.jsonl"));

  // A chat uses one script. Tatoeba mixes them line by line.
  it("is Simplified only", () => {
    expect(pairs.filter((p) => isTraditionalChinese(p.text)).map((p) => p.text)).toEqual([]);
  });

  it("has no Cantonese", () => {
    expect(pairs.filter((p) => isCantonese(p.text))).toEqual([]);
  });
});

describe("Chinese script filters", () => {
  it("recognises the Traditional lines the first list let through", () => {
    for (const t of ["我很抱歉給你添麻煩了。", "我可以在一週內做。", "我的胸罩髒了。", "我需要證據。", "我的公寓在四樓。"]) {
      expect(isTraditionalChinese(t)).toBe(true);
    }
  });

  it("leaves Simplified lines alone", () => {
    for (const t of ["对不起，我来晚了。", "你知道我住哪吗？", "我想要出国。"]) {
      expect(isTraditionalChinese(t)).toBe(false);
    }
  });

  it("recognises Cantonese", () => {
    expect(isCantonese("你用啲咩嚟撩耳屎㗎？")).toBe(true);
    expect(isCantonese("你知道我住哪吗？")).toBe(false);
  });

  it("drops a Latin-letter name inside a Chinese line", () => {
    expect(chatLike({ source: "zh", text: "Luke，我是你的爸爸。", translation: "Luke, I am your father.", origin: "t" })).toBe("proper-noun");
  });

  /** Chinese has no spaces; the old word count rejected every line of it. */
  it("judges length on the English side, so unspaced Chinese survives", () => {
    expect(chatLike({ source: "zh", text: "你知道我住哪吗？", translation: "Do you know where I live?", origin: "t" })).toBeNull();
  });
});

/**
 * The reference files are also the best labelled test set the project has:
 * 520 human sentences in six languages whose language is known. The collector
 * labels corpus messages with this detector, and a mislabelled corpus message
 * makes an engine answer for obeying a wrong source language — so declining is
 * fine here and mislabelling is not.
 */
describe("the corpus detector on the reference files", () => {
  it.each(LANGUAGES)("never labels a %s reference sentence as another language", (lang) => {
    const pairs = loadReference(join(DIR, `${lang}.jsonl`));
    const wrong = pairs
      .map((p) => ({ text: p.text, got: heuristicDetect(p.text)[0]?.lang }))
      .filter((r) => r.got !== undefined && r.got !== lang);
    expect(wrong).toEqual([]);
  });

  it("labels Chinese and Hindi every time, since their scripts are decisive", () => {
    for (const lang of ["zh", "hi"]) {
      const pairs = loadReference(join(DIR, `${lang}.jsonl`));
      expect(pairs.every((p) => heuristicDetect(p.text)[0]?.lang === lang)).toBe(true);
    }
  });
});

describe("a Traditional-Chinese import", () => {
  const trad = { source: "zh-Hant", text: "我很抱歉給你添麻煩了。", translation: "I am sorry to trouble you.", origin: "t" };

  it("keeps Traditional lines when imported as zh-Hant", () => {
    expect(chatLike(trad)).toBeNull();
  });

  it("still drops them from the Simplified file", () => {
    expect(chatLike({ ...trad, source: "zh" })).toBe("script");
  });

  it("still drops Cantonese either way", () => {
    expect(chatLike({ ...trad, text: "你用啲咩嚟撩耳屎㗎？", translation: "What do you use to pick your ears?" })).toBe("script");
  });
});
