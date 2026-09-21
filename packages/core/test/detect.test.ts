import { describe, expect, it } from "vitest";
import { measureCodeSwitching, resolve, segment } from "../src/detect.js";
import type { Detection } from "../src/types.js";

const d = (lang: string, confidence: number): Detection[] => [{ lang, confidence }];

describe("resolve (§4.5)", () => {
  it("trusts a confident detection on long-enough text", () => {
    expect(resolve("¿vienes mañana a la fiesta?", d("es", 0.9), { knownLanguages: ["en"] })).toEqual(
      { lang: "es", source: "detector", confident: true },
    );
  });

  it("does not trust detection below the reliable length", () => {
    const r = resolve("ya voy", d("es", 0.95), { knownLanguages: ["en"] });
    expect(r.source).not.toBe("detector");
  });

  it("falls back to author stickiness for short messages", () => {
    expect(
      resolve("ya voy", [], { knownLanguages: ["en"], authorRecent: ["es", "es"] }),
    ).toEqual({ lang: "es", source: "author", confident: false });
  });

  it("falls back to the channel's dominant language when the author is unknown", () => {
    expect(resolve("ok", [], { knownLanguages: ["en"], channelDominant: "pt" })).toEqual({
      lang: "pt",
      source: "channel",
      confident: false,
    });
  });

  // §12 counts this as a false negative: nothing renders, and a skipped Spanish
  // message is visually identical to an English one. The hover affordance has
  // to stay available on every message because of this branch.
  it("returns null rather than guessing when there is nothing to go on", () => {
    expect(resolve("ok", [], { knownLanguages: ["en"] })).toEqual({
      lang: null,
      source: "none",
      confident: false,
    });
  });

  it("treats low-confidence detection as unusable even on long text", () => {
    const r = resolve("lorem ipsum dolor sit amet", d("la", 0.2), { knownLanguages: ["en"] });
    expect(r.lang).toBeNull();
  });
});

describe("segment", () => {
  it("splits on sentence punctuation and newlines", () => {
    expect(segment("hola. ¿qué tal?\nvamos")).toEqual(["hola.", "¿qué tal?", "vamos"]);
  });
});

describe("measureCodeSwitching (§4.5)", () => {
  // This is a measurement, not a feature: the harness counts how often this
  // happens before anyone builds per-segment translation for it.
  const fake = async (s: string): Promise<Detection[]> =>
    /\b(the|store|tomorrow|going)\b/i.test(s) ? d("en", 0.9) : d("es", 0.9);

  it("detects a genuine switch across segments", async () => {
    const r = await measureCodeSwitching(
      "vamos a la tienda ahora. we are going to the store tomorrow.",
      fake,
    );
    expect(r.switched).toBe(true);
    expect(r.languages.sort()).toEqual(["en", "es"]);
  });

  it("reports no switch for a single-language message", async () => {
    const r = await measureCodeSwitching("vamos a la tienda ahora mismo compadre.", fake);
    expect(r.switched).toBe(false);
  });

  it("counts short segments as inconclusive rather than guessing", async () => {
    const r = await measureCodeSwitching("ok. ya. vale.", fake);
    expect(r.inconclusiveSegments).toBe(3);
    expect(r.switched).toBe(false);
  });
});
