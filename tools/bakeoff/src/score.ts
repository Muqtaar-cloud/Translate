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

/**
 * A rater must call at least this share of gold rows (known-wrong
 * translations) wrong. Below it, their ratings cannot carry the gate: a rater
 * who waves through fluent-but-wrong translations is measuring fluency, and
 * fluency is the one thing every engine already has.
 *
 * 0.8 rather than 1.0 because a mismatch can occasionally land close in
 * meaning to its host ("ok" beside "vale"), and one such row should not
 * disqualify a careful rater.
 */
export const GOLD_CATCH_FLOOR = 0.8;

/** Share of real rows marked wrong above which the report asks for a spot-check. */
export const ALL_NO_WARNING = 0.95;

export interface KeyEntry {
  messageId: string;
  engine: string;
  kind: "real" | "gold";
}

/** One filled row: `null` where the rater left the column blank. */
export interface SheetAnswer {
  rowId: string;
  meaningPreserved: boolean | null;
  registerPreserved: boolean | null;
}

export interface RaterCheck {
  /** Which sheet — in practice, which rater and language. */
  sheet: string;
  gold: number;
  /** Gold rows the rater correctly marked meaning_preserved = n. */
  caught: number;
  /** `null` when the sheet has no gold rows, so the rater is unchecked. */
  passed: boolean | null;
  realRated: number;
  realMarkedWrong: number;
}

/**
 * Splits one rater's sheet into engine ratings and a reliability check.
 *
 * Gold rows never reach an engine score: they are not any engine's output, and
 * counting them would drag every engine down by the traps' known-wrong answers.
 */
export function collectRatings(
  sheet: string,
  answers: readonly SheetAnswer[],
  key: ReadonlyMap<string, KeyEntry>,
): { ratings: Rating[]; check: RaterCheck } {
  const ratings: Rating[] = [];
  let gold = 0;
  let caught = 0;
  let realMarkedWrong = 0;

  for (const a of answers) {
    const k = key.get(a.rowId);
    if (!k || a.meaningPreserved === null) continue; // unknown or unratable

    if (k.kind === "gold") {
      gold++;
      if (!a.meaningPreserved) caught++;
      continue;
    }

    if (!a.meaningPreserved) realMarkedWrong++;
    ratings.push({
      messageId: k.messageId,
      engine: k.engine,
      meaningPreserved: a.meaningPreserved,
      registerPreserved: a.registerPreserved ?? false,
    });
  }

  return {
    ratings,
    check: {
      sheet,
      gold,
      caught,
      passed: gold === 0 ? null : caught / gold >= GOLD_CATCH_FLOOR,
      realRated: ratings.length,
      realMarkedWrong,
    },
  };
}

const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;

export function formatReport(
  scores: EngineScore[],
  codeSwitchRate?: number,
  checks: readonly RaterCheck[] = [],
): string {
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

  if (checks.length > 0) {
    lines.push("  rater checks (gold rows: known-wrong translations mixed into each sheet)");
    for (const c of checks) {
      if (c.passed === null) {
        lines.push(`    ${c.sheet}: no gold rows answered. This rater is unchecked.`);
      } else {
        const verdictText = c.passed
          ? "PASS"
          : `FAIL, marked ${c.gold - c.caught} of ${c.gold} known-wrong translations as correct`;
        lines.push(`    ${c.sheet}: caught ${c.caught}/${c.gold}  ${verdictText}`);
      }
      if (c.realRated >= 20 && c.realMarkedWrong / c.realRated >= ALL_NO_WARNING) {
        lines.push(
          `      marked ${pct(c.realMarkedWrong / c.realRated)} of real rows wrong. Gold rows cannot tell a ` +
            "harsh rater from bad engines; have someone spot-check 20 rows before accepting a FAIL.",
        );
      }
    }
    lines.push("");
  }

  // A verdict built on a rater who waves through wrong translations is the
  // number the gate was hoping for, not a measurement. Withhold it entirely
  // rather than quietly scoring the remaining raters: dropping one language
  // would change the verdict without anyone deciding that it should.
  const failed = checks.filter((c) => c.passed === false);
  if (failed.length > 0) {
    lines.push(
      `  GATE NOT DECIDED. ${failed.map((c) => c.sheet).join(", ")} failed the gold check, so ` +
        "these ratings cannot carry the decision. Re-rate with another rater (§6 has the paid fallback).",
    );
    return lines.join("\n");
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
