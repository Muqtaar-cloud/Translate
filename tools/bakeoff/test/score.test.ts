import { describe, expect, it } from "vitest";
import {
  BAD_CEILING,
  formatReport,
  GOOD_FLOOR,
  scoreEngine,
  verdict,
  wilson,
  type Rating,
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
