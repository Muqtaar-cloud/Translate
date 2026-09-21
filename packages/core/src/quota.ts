/**
 * Daily character budget for paid translation (PLAN.md §4, "rate limits and
 * cost runaway").
 *
 * Counts only what actually costs money. On-device translation is free and
 * unmetered, so charging it against a budget would train the user to turn the
 * budget off — which is the opposite of what a visible meter is for.
 *
 * Deliberately not a rate limiter: the hard defence against runaway cost is
 * viewport gating, which bounds work by attention. This is the backstop that
 * makes spend visible and stops a runaway from being unbounded.
 */

export interface QuotaState {
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  chars: number;
}

export const DEFAULT_DAILY_CHARS = 50_000;

export function today(now: Date = new Date()): string {
  // Local date, not UTC: a budget that resets mid-evening would read as a bug.
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export const emptyQuota = (day = today()): QuotaState => ({ day, chars: 0 });

/** Rolls the counter over when the day has changed. */
export function normalise(state: QuotaState, day = today()): QuotaState {
  return state.day === day ? state : { day, chars: 0 };
}

export function record(state: QuotaState, chars: number, day = today()): QuotaState {
  const current = normalise(state, day);
  return { day, chars: current.chars + Math.max(0, chars) };
}

export function remaining(state: QuotaState, limit = DEFAULT_DAILY_CHARS, day = today()): number {
  return Math.max(0, limit - normalise(state, day).chars);
}

/**
 * Checks a request before it is sent, not after.
 *
 * A budget enforced only after the fact is a report, not a budget.
 */
export function wouldExceed(
  state: QuotaState,
  chars: number,
  limit = DEFAULT_DAILY_CHARS,
  day = today(),
): boolean {
  return normalise(state, day).chars + chars > limit;
}
