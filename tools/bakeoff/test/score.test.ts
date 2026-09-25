import { describe, expect, it } from "vitest";
import {
  BAD_CEILING,
  collectRatings,
  formatReport,
  GOLD_CATCH_FLOOR,
  GOOD_FLOOR,
  scoreEngine,
  verdict,
  wilson,
  type KeyEntry,
  type Rating,
  type SheetAnswer,
} from "../src/score.js";

describe("wilson", () => {
  it("brackets the point estimate", () => {
    const i = wilson(80, 100);
    expect(i.point).toBe(0.8);
    expect(i.lower).toBeLessThan(0.8);
    expect(i.upper).toBeGreaterThan(0.8);
  });

  // The measurement fact that forced the gate to be coarse.
  it("is about ±8 points wide at n=100 near 0.8", () => {
    const i = wilson(80, 100);
    expect(i.upper - i.lower).toBeGreaterThan(0.13);
    expect(i.upper - i.lower).toBeLessThan(0.18);
  });

  it("cannot distinguish 80% from 75% at n=100", () => {
    const a = wilson(80, 100);
    const b = wilson(75, 100);
    // Overlapping intervals: a ten-week decision must not hinge on this gap.
    expect(a.lower).toBeLessThan(b.upper);
  });

  it("stays inside [0,1] at the extremes", () => {
    expect(wilson(0, 30).lower).toBe(0);
    expect(wilson(30, 30).upper).toBe(1);
  });

  it("returns a maximally uncertain interval for no data", () => {
    expect(wilson(0, 0)).toEqual({ point: 0, lower: 0, upper: 1 });
  });
});

describe("verdict", () => {
  it("calls a clearly good engine good", () => {
    expect(verdict(wilson(95, 100))).toBe("good");
  });

  it("calls a clearly bad engine bad", () => {
    expect(verdict(wilson(30, 100))).toBe("bad");
  });

  // PLAN.md §6: marginal is a stop, not a pass. It is the result most likely
  // to be argued into a green light, so it gets its own name.
  it("calls an ambiguous engine marginal rather than rounding it up", () => {
    const i = wilson(78, 100);
    expect(i.point).toBeGreaterThan(GOOD_FLOOR);
    expect(verdict(i)).toBe("marginal");
  });

  it("is driven by the interval, not the point estimate", () => {
    // Same 80% point estimate, different n: small samples cannot pass.
    expect(verdict(wilson(8, 10))).toBe("marginal");
    expect(verdict(wilson(800, 1000))).toBe("good");
  });

  it("uses thresholds that leave a genuine marginal band", () => {
    expect(GOOD_FLOOR).toBeGreaterThan(BAD_CEILING);
  });
});

describe("scoreEngine", () => {
  const ratings: Rating[] = [
    ...Array.from({ length: 90 }, (_, i) => ({
      messageId: `m${i}`,
      engine: "deepl",
      meaningPreserved: true,
      registerPreserved: i % 2 === 0,
    })),
    ...Array.from({ length: 10 }, (_, i) => ({
      messageId: `n${i}`,
      engine: "deepl",
      meaningPreserved: false,
      registerPreserved: false,
    })),
    { messageId: "x", engine: "llm", meaningPreserved: true, registerPreserved: true },
  ];

  it("scores only its own engine's ratings", () => {
    expect(scoreEngine("deepl", ratings).n).toBe(100);
    expect(scoreEngine("llm", ratings).n).toBe(1);
  });

  it("gates on meaning, not register", () => {
    const s = scoreEngine("deepl", ratings);
    expect(s.meaning.point).toBe(0.9);
    expect(s.register.point).toBeLessThan(0.5);
    // Register is poor, but meaning carries the verdict.
    expect(s.verdict).toBe("good");
  });
});

describe("formatReport", () => {
  const good = scoreEngine(
    "chrome-builtin",
    Array.from({ length: 100 }, (_, i) => ({
      messageId: `m${i}`,
      engine: "chrome-builtin",
      meaningPreserved: i < 95,
      registerPreserved: i < 90,
    })),
  );

  it("passes the gate on an automatic-path engine", () => {
    expect(formatReport([good])).toContain("GATE PASSED");
  });

  it("does not let the LLM tier carry the gate", () => {
    const llm = scoreEngine(
      "llm:claude-opus-5",
      Array.from({ length: 100 }, (_, i) => ({
        messageId: `m${i}`,
        engine: "llm:claude-opus-5",
        meaningPreserved: true,
        registerPreserved: true,
      })),
    );
    const report = formatReport([llm]);
    // The gate is on the automatic path; a perfect LLM score cannot pass it.
    expect(report).toContain("NO AUTOMATIC-PATH ENGINE SCORED");
  });

  it("reports a marginal result as a stop", () => {
    const marginal = scoreEngine(
      "deepl",
      Array.from({ length: 100 }, (_, i) => ({
        messageId: `m${i}`,
        engine: "deepl",
        meaningPreserved: i < 78,
        registerPreserved: i < 78,
      })),
    );
    expect(formatReport([marginal])).toContain("STOP");
  });

  it("flags DNT survival below the 100% §12 requires", () => {
    expect(formatReport([{ ...good, dntSurvival: 0.97 }])).toContain("§12 requires 100%");
  });

  it("turns a code-switching rate into the §4.5 decision", () => {
    expect(formatReport([good], 0.02)).toContain("drop per-segment translation");
    expect(formatReport([good], 0.22)).toContain("build per-segment translation");
    expect(formatReport([good], 0.1)).toContain("manual re-translate");
  });
});

describe("rater checks (gold rows)", () => {
  const key = new Map<string, KeyEntry>([
    ...Array.from({ length: 30 }, (_, i) => [
      `r${i}`,
      { messageId: `m${i}`, engine: "deepl", kind: "real" as const },
    ] as const),
    ...Array.from({ length: 5 }, (_, i) => [
      `g${i}`,
      { messageId: `m${i}`, engine: "gold", kind: "gold" as const },
    ] as const),
  ]);
  const answers = (real: boolean, goldCaught: number): SheetAnswer[] => [
    ...Array.from({ length: 30 }, (_, i) => ({
      rowId: `r${i}`,
      meaningPreserved: real,
      registerPreserved: real,
    })),
    ...Array.from({ length: 5 }, (_, i) => ({
      rowId: `g${i}`,
      // Caught means the rater answered n on a known-wrong translation.
      meaningPreserved: i >= goldCaught,
      registerPreserved: true,
    })),
  ];

  it("keeps gold rows out of every engine's score", () => {
    const { ratings } = collectRatings("es", answers(true, 5), key);
    expect(ratings).toHaveLength(30);
    expect(ratings.every((r) => r.engine === "deepl")).toBe(true);
  });

  it("passes a rater who catches the traps", () => {
    expect(collectRatings("es", answers(true, 5), key).check.passed).toBe(true);
    expect(collectRatings("es", answers(true, 4), key).check.passed).toBe(true);
  });

  it("fails a rater who waves wrong translations through", () => {
    const { check } = collectRatings("es", answers(true, 3), key);
    expect(check.caught).toBe(3);
    expect(check.passed).toBe(false);
    expect(3 / 5).toBeLessThan(GOLD_CATCH_FLOOR);
  });

  it("reports a sheet with no gold rows as unchecked rather than passed", () => {
    const realOnly = answers(true, 0).filter((a) => a.rowId.startsWith("r"));
    expect(collectRatings("old", realOnly, key).check.passed).toBeNull();
  });

  it("skips blank answers instead of counting them either way", () => {
    const blank = answers(true, 5).map((a) =>
      a.rowId === "g0" ? { ...a, meaningPreserved: null } : a,
    );
    expect(collectRatings("es", blank, key).check.gold).toBe(4);
  });

  const good = scoreEngine(
    "deepl",
    Array.from({ length: 200 }, (_, i) => ({
      messageId: `m${i}`,
      engine: "deepl",
      meaningPreserved: i % 20 !== 0,
      registerPreserved: true,
    })),
  );

  /**
   * The teeth. An engine that would otherwise pass cannot, if the ratings
   * behind it came from someone who did not catch the traps.
   */
  it("withholds the gate verdict when any rater fails", () => {
    const passing = collectRatings("rating-sheet.es.csv", answers(true, 5), key).check;
    const failing = collectRatings("rating-sheet.pt.csv", answers(true, 1), key).check;

    expect(formatReport([good], undefined, [passing])).toContain("GATE PASSED");

    const report = formatReport([good], undefined, [passing, failing]);
    expect(report).toContain("GATE NOT DECIDED");
    expect(report).toContain("rating-sheet.pt.csv");
    expect(report).not.toContain("GATE PASSED");
  });

  it("asks for a spot-check when a rater marked nearly everything wrong", () => {
    const harsh = collectRatings("es", answers(false, 5), key).check;
    expect(harsh.passed).toBe(true); // mismatch gold cannot catch this
    expect(formatReport([good], undefined, [harsh])).toMatch(/spot-check 20 rows/);
  });
});
