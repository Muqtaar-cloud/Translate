import { describe, expect, it } from "vitest";
import { parseCorpus, summarise } from "../src/corpus.js";
import {
  buildRatingSheet,
  GOLD_MAX,
  goldCount,
  prepare,
  RATER_INSTRUCTIONS,
  restoreOutputs,
} from "../src/prepare.js";

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

describe("gold rows", () => {
  // Twenty messages through four engines: 80 real rows, the smallest sheet
  // that looks like a real one.
  const big = parseCorpus(
    Array.from({ length: 20 }, (_, i) =>
      JSON.stringify({ id: `g${i}`, source: "es", text: `mensaje número ${i} del grupo` }),
    ).join("\n"),
  );
  const bigPrepared = prepare(big, "en", { includeContext: false });
  const engines = ["ondevice", "deepl", "llm", "selfhosted"];
  const bigOutputs = engines.flatMap((engine) =>
    restoreOutputs(
      bigPrepared,
      big.map((m) => ({ id: m.id, output: `${engine} translation of ${m.id} topic${m.id}` })),
      engine,
    ),
  );

  const keyRows = (key: string) =>
    key
      .split("\n")
      .slice(1)
      .map((line) => {
        const [rowId, messageId, engine, kind, donor] = line.split(",");
        return { rowId, messageId, engine, kind, donor };
      });

  it("mixes in about 5% gold rows, marked only in the key", () => {
    const { key, gold } = buildRatingSheet(bigPrepared, bigOutputs);
    expect(gold).toBe(goldCount(80, 20));
    expect(gold).toBe(4);
    expect(keyRows(key).filter((r) => r.kind === "gold")).toHaveLength(4);
  });

  /**
   * The construction: message A's original beside message B's translation.
   * Fluent, casual and wrong — the failure raters exist to catch — and
   * buildable without reading the source language.
   */
  it("pairs each gold row's original with a different message's real translation", () => {
    const { sheet, key } = buildRatingSheet(bigPrepared, bigOutputs);
    const lines = new Map(sheet.split("\n").slice(1).map((l) => [l.split(",")[0], l]));

    for (const g of keyRows(key).filter((r) => r.kind === "gold")) {
      expect(g.donor).toBeTruthy();
      expect(g.donor).not.toBe(g.messageId);
      const line = lines.get(g.rowId) ?? "";
      // Original from the host message, translation from the donor's.
      expect(line).toContain(`mensaje número ${g.messageId?.slice(1)} del grupo`);
      expect(line).toContain(`translation of ${g.donor} `);
      expect(line).not.toContain(`translation of ${g.messageId} `);
    }
  });

  it("gives a rater nothing that marks a gold row as different", () => {
    const { sheet } = buildRatingSheet(bigPrepared, bigOutputs);
    expect(sheet).not.toMatch(/gold/i);
    const columns = new Set(sheet.split("\n").slice(1).map((l) => l.split('","').length));
    expect(columns.size).toBe(1);
  });

  /**
   * Regression for a measured blinding leak: ids were assigned before the
   * shuffle, so r0–r19 were all one engine and anyone could read engine
   * groupings off the row_id column. Ids now follow display order, so they
   * carry no information beyond position.
   */
  it("numbers rows in display order, so an id says nothing about the engine", () => {
    const { sheet, key } = buildRatingSheet(bigPrepared, bigOutputs, { prefix: "es-" });
    const ids = sheet.split("\n").slice(1).map((l) => l.split(",")[0]);
    expect(ids).toEqual(ids.map((_, i) => `es-${i + 1}`));

    // And the first quarter of the sheet is not one engine.
    const engineOf = new Map(keyRows(key).map((r) => [r.rowId, r.engine]));
    const firstQuarter = new Set(ids.slice(0, 20).map((id) => engineOf.get(id)));
    expect(firstQuarter.size).toBeGreaterThan(1);
  });

  it("never borrows a translation identical to one of the host's own", () => {
    // Every engine says "ok" for m0 and m1: a mismatch between them would be a
    // trap whose correct answer is y.
    const same = parseCorpus(
      [
        '{"id":"s0","source":"es","text":"vale"}',
        '{"id":"s1","source":"es","text":"ok"}',
        ...Array.from({ length: 8 }, (_, i) =>
          JSON.stringify({ id: `s${i + 2}`, source: "es", text: `algo distinto ${i}` }),
        ),
      ].join("\n"),
    );
    const p = prepare(same, "en", { includeContext: false });
    const o = restoreOutputs(
      p,
      same.map((m) => ({ id: m.id, output: m.id === "s0" || m.id === "s1" ? "ok" : `other ${m.id}` })),
      "deepl",
    );
    const { key } = buildRatingSheet(p, o);
    for (const g of keyRows(key).filter((r) => r.kind === "gold")) {
      const pair = new Set([g.messageId, g.donor]);
      expect(pair.has("s0") && pair.has("s1")).toBe(false);
    }
  });

  it("is deterministic with gold rows included", () => {
    expect(buildRatingSheet(bigPrepared, bigOutputs).key).toBe(
      buildRatingSheet(bigPrepared, bigOutputs).key,
    );
  });

  it("adds none when there is no second message to borrow from, or when asked not to", () => {
    expect(goldCount(4, 1)).toBe(0);
    expect(buildRatingSheet(bigPrepared, bigOutputs, { gold: false }).gold).toBe(0);
  });

  it("caps gold rows so a large sheet is not padded with traps", () => {
    expect(goldCount(400, 100)).toBe(GOLD_MAX);
    expect(goldCount(10_000, 2_000)).toBe(GOLD_MAX);
  });

  it("tells raters that checks exist, without saying which rows they are", () => {
    expect(RATER_INSTRUCTIONS).toMatch(/checks with a known answer/);
  });
});
