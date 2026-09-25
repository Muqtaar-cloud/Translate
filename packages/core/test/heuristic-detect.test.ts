import { describe, expect, it } from "vitest";
import { heuristicDetect } from "../src/heuristic-detect.js";

const lang = (text: string): string | null => heuristicDetect(text)[0]?.lang ?? null;

/**
 * The bot's own detector tests cover the rules; these cover the failure the
 * corpus collector surfaced, which is the one that matters for Phase 0b. A
 * mislabelled corpus message is worse than a missing one: the engine is told the
 * source language, so it answers for obeying a wrong label.
 */
describe("Spanish against Portuguese", () => {
  it("declines to guess on text whose only cues are shared by both", () => {
    // Portuguese, but its cues ("por", "está") are equally Spanish. Detected as
    // Spanish before "está" was listed under pt as well.
    expect(lang("alguém pode trazer gelo por favor está quente")).toBeNull();
  });

  it("still reads Portuguese when a Portuguese-only cue is present", () => {
    expect(lang("não posso, tenho que trabalhar de manhã")).toBe("pt");
    expect(lang("você vem amanhã para a festa da ana?")).toBe("pt");
  });

  it("still reads Spanish when a Spanish-only cue is present", () => {
    expect(lang("¿vienes mañana a la fiesta de ana?")).toBe("es");
    expect(lang("no te preocupes, yo llevo la bebida y el postre")).toBe("es");
  });
});
