import { describe, expect, it } from "vitest";
import { detectLanguage } from "../src/detect.js";

const lang = (text: string): string | null => detectLanguage(text)[0]?.lang ?? null;

describe("detectLanguage", () => {
  describe("scripts, which are decisive", () => {
    it.each([
      ["مرحبا كيف حالك اليوم", "ar"],
      ["שלום מה שלומך היום", "he"],
      ["привет как дела сегодня", "ru"],
      ["こんにちは元気ですか", "ja"],
      ["안녕하세요 잘 지내세요", "ko"],
    ])("identifies %s", (text, expected) => {
      expect(lang(text)).toBe(expected);
    });
  });

  describe("Latin script, which is not", () => {
    it("identifies Spanish from stopwords and orthography", () => {
      expect(lang("¿vienes mañana a la fiesta?")).toBe("es");
      expect(lang("buenos dias a todos los amigos")).toBe("es");
    });

    it("identifies English", () => {
      expect(lang("the quick brown fox is here")).toBe("en");
    });

    it("identifies Portuguese by its own orthography", () => {
      expect(lang("não vamos para a reunião hoje")).toBe("pt");
    });
  });

  // A wrong source language produces confident nonsense, in public, where
  // nobody can tell it was the detector rather than the translator. Declining
  // is the cheaper failure.
  describe("declining to guess", () => {
    it("says nothing about a message too short to judge", () => {
      expect(lang("ok")).toBeNull();
      expect(lang("ya voy")).toBeNull();
    });

    it("says nothing when the evidence is a tie", () => {
      // "la" is a stopword in Spanish, French and Italian alike. Without an
      // orthographic cue there is genuinely nothing to choose between them,
      // and this is the case that first exposed the need for those cues.
      expect(lang("la casa la mesa la silla")).toBeNull();
    });

    it("says nothing about text with no recognisable function words", () => {
      expect(lang("zzzz qqqq wwww vvvv")).toBeNull();
    });

    it("handles empty and whitespace input", () => {
      expect(detectLanguage("")).toEqual([]);
      expect(detectLanguage("   ")).toEqual([]);
    });
  });

  it("reports a confidence, and never a certain one", () => {
    const [best] = detectLanguage("buenos dias a todos los amigos");
    expect(best?.confidence).toBeGreaterThan(0.4);
    expect(best?.confidence).toBeLessThanOrEqual(0.85);
  });
});
