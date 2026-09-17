import { describe, expect, it } from "vitest";
import { leavesDevice, route, type RoutingPolicy } from "../src/routing.js";
import type { Availability, TranslationRequest } from "../src/types.js";

const req = (over: Partial<TranslationRequest> = {}): TranslationRequest => ({
  text: "¿vienes mañana?",
  source: "es",
  target: "en",
  initiation: "automatic",
  ...over,
});

const policy = (availability: Availability, over: Partial<RoutingPolicy> = {}): RoutingPolicy => ({
  knownLanguages: ["en"],
  cloudEnabled: false,
  availability: () => availability,
  ...over,
});

describe("route", () => {
  it("skips a language I already read, at no cost", () => {
    expect(route(req({ source: "en" }), policy("available"))).toEqual({
      kind: "skip",
      reason: "known-language",
    });
  });

  it("uses the on-device path when the pack is present", () => {
    expect(route(req(), policy("available"))).toEqual({
      kind: "on-device",
      source: "es",
      target: "en",
    });
  });

  it("falls back to cloud only when the pair is genuinely unavailable", () => {
    const r = route(req(), policy("unavailable", { cloudEnabled: true, cloudProvider: "deepl" }));
    expect(r).toEqual({ kind: "cloud-mt", provider: "deepl", source: "es", target: "en" });
  });

  it("reports unsupported rather than inventing a provider", () => {
    expect(route(req(), policy("unavailable"))).toEqual({
      kind: "unsupported",
      source: "es",
      target: "en",
    });
  });

  // PLAN.md §4.3. This is the regression the fourth review round caught: four
  // availability states collapsed to a boolean meant a pending pack download
  // silently became a DeepL request.
  describe("downloadable is a terminal branch, never a fallthrough", () => {
    for (const state of ["downloadable", "downloading"] as const) {
      it(`prompts for download on '${state}' even when cloud is enabled`, () => {
        const r = route(
          req(),
          policy(state, { cloudEnabled: true, cloudProvider: "deepl" }),
        );
        expect(r).toEqual({ kind: "needs-pack-download", source: "es", target: "en", state });
      });

      it(`does not send content off-device on '${state}'`, () => {
        const r = route(req(), policy(state, { cloudEnabled: true, cloudProvider: "deepl" }));
        expect(leavesDevice(r)).toBe(false);
      });
    }
  });

  // PLAN.md §12: "Cloud character count 0 while cloud is disabled."
  it("never leaves the device while cloud is disabled, across every state", () => {
    const states: Availability[] = ["available", "downloadable", "downloading", "unavailable"];
    for (const state of states) {
      expect(leavesDevice(route(req(), policy(state)))).toBe(false);
    }
  });

  // PLAN.md §11: the package must not assume an on-device provider exists.
  it("works for a consumer with no on-device provider at all (the bot)", () => {
    const botPolicy = policy("unavailable", {
      cloudEnabled: true,
      cloudProvider: "nllb-selfhosted",
    });
    expect(route(req(), botPolicy).kind).toBe("cloud-mt");
  });
});
