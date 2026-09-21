/**
 * Scoring for Phase 0b (PLAN.md §6).
 *
 * The gate is deliberately coarse. At n≈100 the 95% interval on a proportion
 * near 0.8 is roughly ±8 points, so an earlier draft's "≥80%" versus 75% was
 * not a distinguishable difference and must not carry a ten-week decision.
 * What this reports instead is: obviously good, obviously bad, or marginal —
 * and marginal means stop, because marginal quality will not survive real use
 * and is the result most likely to be argued into a green light.
 */

export type Verdict = "good" | "bad" | "marginal";

export interface Interval {
  point: number;
  lower: number;
  upper: number;
}

/** Wilson score interval — behaves sanely at small n and near 0 or 1. */
export function wilson(successes: number, n: number, z = 1.96): Interval {
  if (n === 0) return { point: 0, lower: 0, upper: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return {
    point: p,
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
  };
}

export const GOOD_FLOOR = 0.75;
export const BAD_CEILING = 0.6;

/**
 * Verdict from the interval, not the point estimate — the whole reason the
 * threshold is coarse is that the point estimate is noisy at this n.
 */
export function verdict(interval: Interval): Verdict {
  if (interval.lower >= GOOD_FLOOR) return "good";
  if (interval.upper <= BAD_CEILING) return "bad";
  return "marginal";
}

export interface Rating {
  messageId: string;
  engine: string;
  /** Rater's judgement: did the translation preserve what the message meant? */
  meaningPreserved: boolean;
  /** Did it keep the casual register rather than formalising it? */
  registerPreserved: boolean;
}

export interface EngineScore {
  engine: string;
  n: number;
  meaning: Interval;
  register: Interval;
  verdict: Verdict;
  /** Mechanical, counted by the harness rather than rated (PLAN.md §6). */
  dntSurvival?: number;
  errors?: number;
}

export function scoreEngine(engine: string, ratings: Rating[]): EngineScore {
  const mine = ratings.filter((r) => r.engine === engine);
  const meaning = wilson(mine.filter((r) => r.meaningPreserved).length, mine.length);
  const register = wilson(mine.filter((r) => r.registerPreserved).length, mine.length);
  return {
    engine,
    n: mine.length,
    meaning,
    register,
    // The gate is on meaning. Register is reported alongside because it is what
    // a bilingual rater adds over any automated proxy, but a product that
    // preserves register while losing meaning is not a product.
    verdict: verdict(meaning),
  };
}

const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;

export function formatReport(scores: EngineScore[], codeSwitchRate?: number): string {
  const lines: string[] = [];
  lines.push("Phase 0b — translation quality bake-off (PLAN.md §6)");
  lines.push("");

  for (const s of scores) {
    lines.push(`  ${s.engine}  (n=${s.n})`);
    lines.push(
      `    meaning   ${pct(s.meaning.point)}  [${pct(s.meaning.lower)}–${pct(s.meaning.upper)}]`,
    );
    lines.push(
      `    register  ${pct(s.register.point)}  [${pct(s.register.lower)}–${pct(s.register.upper)}]`,
    );
    if (s.dntSurvival !== undefined) {
      const flag = s.dntSurvival < 1 ? "  <- §12 requires 100%" : "";
      lines.push(`    DNT spans ${pct(s.dntSurvival)} survived${flag}`);
    }
    if (s.errors) lines.push(`    errors    ${s.errors}`);
    lines.push(`    verdict   ${s.verdict.toUpperCase()}`);
    lines.push("");
  }

  if (codeSwitchRate !== undefined) {
    const call =
      codeSwitchRate < 0.05
        ? "under 5%: drop per-segment translation and the golden-set cases together"
        : codeSwitchRate > 0.15
          ? "over 15%: build per-segment translation, with evidence"
          : "in between: single-language detection plus a manual re-translate affordance";
    lines.push(`  code-switching: ${pct(codeSwitchRate)} of messages — ${call} (§4.5)`);
    lines.push("");
  }

  const automatic = scores.filter((s) => s.engine !== "llm" && !s.engine.startsWith("llm:"));
  const best = automatic.sort((a, b) => b.meaning.lower - a.meaning.lower)[0];

  if (!best) {
    lines.push("  NO AUTOMATIC-PATH ENGINE SCORED. The gate is on the automatic path.");
  } else if (best.verdict === "good") {
    lines.push(`  GATE PASSED on ${best.engine}. Proceed to Phase 0c.`);
  } else if (best.verdict === "bad") {
    lines.push(`  GATE FAILED on ${best.engine}. Stop; §4.3 needs rewriting before building.`);
  } else {
    lines.push(
      `  MARGINAL on ${best.engine}. Per §6 this is a STOP, not a pass. ` +
        "Marginal quality will not survive real use.",
    );
  }

  return lines.join("\n");
}
