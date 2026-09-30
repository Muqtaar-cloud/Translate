import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  chatLike,
  formatReference,
  loadReference,
  parseTabbedPairs,
  selectReference,
  type ReferencePair,
} from "../src/reference.js";

const pair = (translation: string, text: string): ReferencePair => ({
  source: "es",
  text,
  translation,
  origin: "test",
});

describe("parseTabbedPairs", () => {
  it("reads Tatoeba's format with the attribution column", () => {
    const [p] = parseTabbedPairs(
      "Where should I put this?\t¿Dónde debería poner esto?\tCC-BY 2.0 (France) Attribution: tatoeba.org #1 & #2\n",
      "es",
      "fallback",
    );
    expect(p).toEqual({
      source: "es",
      text: "¿Dónde debería poner esto?",
      translation: "Where should I put this?",
      origin: "CC-BY 2.0 (France) Attribution: tatoeba.org #1 & #2",
    });
  });

  /** Some mirrors strip attribution; the licence credit must not vanish with it. */
  it("records the fallback attribution when the column is missing", () => {
    const [p] = parseTabbedPairs("I like both.\tMe gustan los dos.\r\n", "es", "Tatoeba, CC-BY 2.0 FR");
    expect(p?.origin).toBe("Tatoeba, CC-BY 2.0 FR");
    expect(p?.text).toBe("Me gustan los dos.");
  });

  it("skips blank and one-sided lines", () => {
    expect(parseTabbedPairs("\nonly english\n\t\n", "es", "x")).toEqual([]);
  });
});

describe("chatLike", () => {
  it("keeps a line that could be a chat message", () => {
    expect(chatLike(pair("Where should I put this?", "¿Dónde debería poner esto?"))).toBeNull();
    expect(chatLike(pair("I can't stop him.", "No puedo pararle."))).toBeNull();
  });

  /** A fifth of Tatoeba names Tom or Mary. In a chat sheet that marks the row. */
  it("drops Tatoeba's stock names", () => {
    expect(chatLike(pair("Tell Tom we don't want to go.", "Decile a Tom que no queremos ir."))).toBe(
      "stock-name",
    );
  });

  it("drops lines with a name or place in them", () => {
    expect(chatLike(pair("He has a large farm in Colorado.", "Él tiene una gran granja en Colorado."))).toBe(
      "proper-noun",
    );
  });

  it("keeps the pronoun I, which is capitalised mid-sentence", () => {
    expect(chatLike(pair("Where should I put this?", "¿Dónde debería poner esto?"))).toBeNull();
  });

  it("drops textbook narration nobody would send", () => {
    expect(chatLike(pair("Most children hate school.", "La mayoría de los chicos odia la escuela."))).toBe(
      "not-conversational",
    );
  });

  it("drops lines too short or too long to pass as a message", () => {
    expect(chatLike(pair("Go.", "Ve."))).toBe("length");
    expect(chatLike(pair("x".repeat(20), `${"palabra ".repeat(12)}`))).toBe("length");
  });
});

describe("selectReference", () => {
  it("dedupes on the source-language side", () => {
    const { kept, rejected } = selectReference([
      pair("Where should I put this?", "¿Dónde debería poner esto?"),
      pair("Where do I put this?", "¿Dónde debería poner esto?"),
    ]);
    expect(kept).toHaveLength(1);
    expect(rejected.duplicate).toBe(1);
  });

  /** These exports are sorted by length: the head of the file is two-word lines. */
  it("samples across the whole file rather than taking its head", () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      pair(`Can you bring item number ${"x".repeat(i % 5)} for me?`, `¿Puedes traer la cosa ${i} para mí?`.replace(/\d+/, "n".repeat(i + 1))),
    );
    const { kept } = selectReference(many, 10);
    expect(kept).toHaveLength(10);
    expect(kept.at(-1)?.text.length).toBeGreaterThan(kept[0]?.text.length ?? 0);
  });

  it("says how many it dropped and why", () => {
    const { rejected } = selectReference([pair("Tell Tom we don't want to go.", "Decile a Tom que no queremos ir.")]);
    expect(rejected["stock-name"]).toBe(1);
  });
});

describe("loadReference", () => {
  const dir = mkdtempSync(join(tmpdir(), "ref-"));

  it("round-trips what the import writes", () => {
    const pairs = [pair("Where should I put this?", "¿Dónde debería poner esto?")];
    const file = join(dir, "ok.jsonl");
    writeFileSync(file, formatReference(pairs));
    expect(loadReference(file)).toEqual(pairs);
  });

  it("refuses a line without a translation, rather than making a row with no answer", () => {
    const file = join(dir, "bad.jsonl");
    writeFileSync(file, '{"source":"es","text":"hola a todos"}\n');
    expect(() => loadReference(file)).toThrow(/translation/);
  });
});
