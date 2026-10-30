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

/**
 * Letters and words two languages share must not count for only one of them.
 * Each case below is a measured mislabel from Tatoeba sentences (PLAN.md §6):
 * before these fixes, 170 of 5,480 held-out sentences were labelled as the
 * wrong language, 55 of them Portuguese labelled French.
 */
describe("shared letters and words", () => {
  it("does not read Turkish ö and ü as German", () => {
    expect(lang("Öğretmen, öğrencilerle iyi başa çıkıyor.")).toBe("tr");
    expect(lang("Bütün bildiğimiz o, başka bir şey yok.")).not.toBe("de");
  });

  it("does not read Portuguese ê as French", () => {
    expect(lang("Você não gosta de histórias de amor.")).toBe("pt");
  });

  it("does not read ç as Portuguese when it is French or Turkish", () => {
    expect(lang("Ça me paraît intéressant !")).not.toBe("pt");
    expect(lang("Sigara içmekten vazgeçtim.")).not.toBe("pt");
  });

  it("does not read French negation ne as Turkish", () => {
    expect(lang("Je ne suis pas sûr de pouvoir venir ce soir.")).toBe("fr");
  });

  it("does not read Spanish tu as French", () => {
    expect(lang("Quisiera ser tu novio.")).not.toBe("fr");
  });
});

/**
 * Hindi in Latin letters. Before this, every such line was declined. The
 * positives below were written for this test, not collected, so they show the
 * rule works rather than how often it does; the false-positive check that
 * matters ran on 18,000 real Tatoeba sentences in nine languages and found none.
 */
describe("romanised Hindi", () => {
  it("labels it hi-Latn", () => {
    expect(lang("kya kar rahe ho aaj shaam ko")).toBe("hi-Latn");
    expect(lang("mujhe nahi pata yaar, tum batao")).toBe("hi-Latn");
    expect(lang("bro meeting kitne baje hai?")).toBe("hi-Latn");
  });

  it("still labels Devanagari Hindi hi", () => {
    expect(lang("क्या कर रहे हो आज शाम को")).toBe("hi");
  });

  it("does not take one shared word as Hindi", () => {
    // "hai" is Italian for "you have": one hit is not enough.
    expect(lang("hai fame? possiamo mangiare qualcosa insieme")).not.toBe("hi-Latn");
    expect(lang("what are you doing this evening")).not.toBe("hi-Latn");
    expect(lang("kamu sudah makan belum? aku lagi di rumah")).not.toBe("hi-Latn");
  });
});
