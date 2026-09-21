import { describe, expect, it } from "vitest";
import {
  DEFAULT_DAILY_CHARS,
  emptyQuota,
  record,
  remaining,
  today,
  wouldExceed,
} from "../src/quota.js";

describe("quota", () => {
  it("starts empty", () => {
    expect(remaining(emptyQuota("2026-09-21"), 100, "2026-09-21")).toBe(100);
  });

  it("accumulates within a day", () => {
    let state = emptyQuota("2026-09-21");
    state = record(state, 30, "2026-09-21");
    state = record(state, 20, "2026-09-21");
    expect(remaining(state, 100, "2026-09-21")).toBe(50);
  });

  it("resets when the day rolls over", () => {
    const state = record(emptyQuota("2026-09-21"), 90, "2026-09-21");
    expect(remaining(state, 100, "2026-09-22")).toBe(100);
  });

  it("never reports negative headroom", () => {
    const state = record(emptyQuota("2026-09-21"), 500, "2026-09-21");
    expect(remaining(state, 100, "2026-09-21")).toBe(0);
  });

  // A budget enforced only after the fact is a report, not a budget.
  it("checks a request before it is sent", () => {
    const state = record(emptyQuota("2026-09-21"), 90, "2026-09-21");
    expect(wouldExceed(state, 5, 100, "2026-09-21")).toBe(false);
    expect(wouldExceed(state, 20, 100, "2026-09-21")).toBe(true);
  });

  it("treats yesterday's spend as spent, not as headroom used", () => {
    const state = record(emptyQuota("2026-09-20"), 100, "2026-09-20");
    expect(wouldExceed(state, 50, 100, "2026-09-21")).toBe(false);
  });

  it("ignores negative usage rather than crediting the budget", () => {
    const state = record(emptyQuota("2026-09-21"), -50, "2026-09-21");
    expect(remaining(state, 100, "2026-09-21")).toBe(100);
  });

  // A budget that reset mid-evening would read as a bug.
  it("uses the local calendar day", () => {
    const newYearsEveEvening = new Date(2026, 11, 31, 23, 30);
    expect(today(newYearsEveEvening)).toBe("2026-12-31");
  });

  it("has a default worth having", () => {
    expect(DEFAULT_DAILY_CHARS).toBeGreaterThan(10_000);
  });
});
