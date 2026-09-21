import { describe, expect, it } from "vitest";
import { parseCorpus, summarise } from "../src/corpus.js";
import { buildRatingSheet, prepare, restoreOutputs } from "../src/prepare.js";

const corpus = parseCorpus(`
{"id":"m1","source":"es","text":"ya voy","context":["¿dónde estás?"]}
{"id":"m2","source":"es","text":"jaja <@123> otra vez :facepalm:"}
{"id":"m3","source":"pt","text":"bora sexta?"}
`);

describe("parseCorpus", () => {
  it("parses JSONL and skips comments and blanks", () => {
    expect(corpus).toHaveLength(3);
    expect(summarise(corpus)).toEqual({ es: 2, pt: 1 });
  });

  it("rejects duplicate ids, which would silently collapse ratings", () => {
    expect(() => parseCorpus('{"id":"a","source":"es","text":"x"}\n{"id":"a","source":"es","text":"y"}')).toThrow(
      /duplicate id/,
    );
  });

  it("rejects a message with no source language", () => {
    expect(() => parseCorpus('{"id":"a","text":"hola"}')).toThrow(/source/);
  });
});

describe("prepare (§6: mask before any engine sees the corpus)", () => {
  it("masks DNT spans so engines are not scored on the unmasked baseline", () => {
    const [, second] = prepare(corpus, "en", { includeContext: false });
    expect(second?.item.masked).not.toContain("<@123>");
    expect(second?.item.masked).not.toContain(":facepalm:");
    expect(second?.spans).toContain("<@123>");
  });

  // PLAN.md §5.1: only the user-initiated tier may see thread context.
  it("withholds context unless the engine tier is entitled to it", () => {
    const without = prepare(corpus, "en", { includeContext: false });
    expect(without[0]?.item.context).toBeUndefined();

    const withCtx = prepare(corpus, "en", { includeContext: true });
    expect(withCtx[0]?.item.context).toEqual(["¿dónde estás?"]);
  });
});

describe("restoreOutputs", () => {
  it("puts DNT spans back and reports survival per message", () => {
    const prepared = prepare(corpus, "en", { includeContext: false });
    const second = prepared[1];
    if (!second) throw new Error("fixture missing");

    const outputs = restoreOutputs(
      prepared,
      [{ id: "m2", output: second.item.masked }],
      "fake",
    );
    expect(outputs[0]?.restored).toBe("jaja <@123> otra vez :facepalm:");
    expect(outputs[0]?.dntSurvival).toBe(1);
  });

  it("catches an engine that ate a placeholder", () => {
    const prepared = prepare(corpus, "en", { includeContext: false });
    const outputs = restoreOutputs(prepared, [{ id: "m2", output: "haha again" }], "fake");
    expect(outputs[0]?.dntSurvival).toBeLessThan(1);
  });
});

describe("buildRatingSheet", () => {
  const prepared = prepare(corpus, "en", { includeContext: false });
  const outputs = restoreOutputs(
    prepared,
    corpus.map((m) => ({ id: m.id, output: `translated ${m.id}` })),
    "deepl",
  );

  it("hides the engine from the rater and keeps it in the key", () => {
    const { sheet, key } = buildRatingSheet(prepared, outputs);
    expect(sheet).not.toContain("deepl");
    expect(key).toContain("deepl");
    expect(sheet.split("\n")[0]).toContain("meaning_preserved");
  });

  it("is deterministic, so a re-run produces the same sheet", () => {
    expect(buildRatingSheet(prepared, outputs).sheet).toBe(
      buildRatingSheet(prepared, outputs).sheet,
    );
  });

  it("drops errored and empty outputs rather than asking raters to score them", () => {
    const withError = [
      ...outputs,
      { id: "m9", engine: "deepl", restored: "", dntSurvival: 1, error: "429" },
    ];
    const { key } = buildRatingSheet(prepared, withError);
    expect(key).not.toContain("m9");
  });

  it("escapes quotes and commas so CSV survives real chat text", () => {
    const tricky = parseCorpus('{"id":"t1","source":"es","text":"dijo \\"hola\\", y se fue"}');
    const p = prepare(tricky, "en", { includeContext: false });
    const o = restoreOutputs(p, [{ id: "t1", output: 'said "hi", then left' }], "deepl");
    const { sheet } = buildRatingSheet(p, o);
    expect(sheet).toContain('""hi""');
    expect(sheet.split("\n")).toHaveLength(2);
  });
});
