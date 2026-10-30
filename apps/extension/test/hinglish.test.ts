// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Detection, TranslationRequest } from "@polyglot/core";
import { fixture } from "./fixture.js";
import { DiscordAdapter } from "../src/content/discord.js";
import { RenderLoop } from "../src/content/loop.js";

/**
 * Romanised Hindi ("kya kar rahe ho aaj shaam ko") is how many Indian group
 * chats are written. Chrome's LanguageDetector could not run where this was
 * built (`unavailable`), so what it says about such a line is unmeasured;
 * these tests pin what the extension does with each answer it might give.
 */
const HINGLISH = "kya kar rahe ho aaj shaam ko";

function setup(result: Detection[], knownLanguages = ["en"]) {
  document.body.innerHTML = fixture("discord-messages.html").replace(
    /<\/div>\s*$/,
    `<li id="chat-messages-100-990001"><div id="message-content-990001">${HINGLISH}</div></li></div>`,
  );
  const translateOnDevice = vi.fn(async (s: string, t: string, text: string) => `${s}->${t}(${text})`);
  const translateLlm = vi.fn(async (_r: TranslationRequest) => "what are you doing this evening");
  const loop = new RenderLoop({
    adapter: new DiscordAdapter(() => new URL("https://discord.com/channels/555/100")),
    doc: document,
    target: "en",
    knownLanguages,
    detect: async (text: string) => (text === HINGLISH ? result : [{ lang: "en", confidence: 0.95 }]),
    translateOnDevice,
    translateLlm,
    policy: { knownLanguages, cloudEnabled: false, availability: () => "available" },
    batch: { debounceMs: 0 },
  });
  const li = () => document.querySelector('li[id$="-990001"]') as HTMLElement;
  const wrap = () => li().querySelector("polyglot-layer")?.shadowRoot?.querySelector(".wrap");
  const text = () => (wrap()?.textContent ?? "").replace("🌐", "").trim();
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 20));
    await loop.drain();
  };
  const clickGlobe = async () => {
    li().dispatchEvent(new Event("mouseenter"));
    (wrap()?.querySelector('[data-polyglot="globe"]') as HTMLButtonElement).click();
    await settle();
  };
  const clickEscalate = async () => {
    (wrap()?.querySelector('[data-polyglot="escalate"]') as HTMLButtonElement).click();
    await settle();
  };
  return { loop, translateOnDevice, translateLlm, text, wrap, settle, clickGlobe, clickEscalate };
}

const onlyHinglish = (calls: unknown[][]) => calls.filter((c) => c[2] === HINGLISH);

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("the hover globe on romanised Hindi", () => {
  /**
   * The bug: the globe re-ran the automatic skip rule, so a message the
   * detector called English routed en → en, was skipped, and the click did
   * nothing. Latin letters full of English words is exactly how a detector
   * misreads romanised Hindi.
   */
  it("says so and offers the LLM when the detector calls it English, instead of doing nothing", async () => {
    const h = setup([{ lang: "en", confidence: 0.9 }]);
    h.loop.start();
    await h.settle();
    expect(h.text()).toBe("");

    await h.clickGlobe();
    expect(h.text()).toContain("looks like English, which you read");
    expect(h.wrap()?.querySelector('[data-polyglot="escalate"]')).not.toBeNull();
    expect(onlyHinglish(h.translateOnDevice.mock.calls)).toEqual([]);
  });

  it("uses the best guess that is not a language the reader reads", async () => {
    const h = setup([
      { lang: "en", confidence: 0.6 },
      { lang: "hi-Latn", confidence: 0.3 },
    ]);
    h.loop.start();
    await h.settle();
    await h.clickGlobe();
    expect(onlyHinglish(h.translateOnDevice.mock.calls).map((c) => c[0])).toEqual(["hi-Latn"]);
  });

  /**
   * The other bug: an undetected message went out as source "auto", which
   * Chrome's Translator rejects ("Invalid language tag: auto"), after first
   * offering to download an "auto → en" pack.
   */
  it("never sends 'auto' to the on-device translator when the detector declines", async () => {
    const h = setup([]);
    h.loop.start();
    await h.settle();
    await h.clickGlobe();
    expect(h.text()).toContain("couldn't tell what language this is");
    expect(h.text()).not.toContain("auto");
    expect(onlyHinglish(h.translateOnDevice.mock.calls)).toEqual([]);
  });
});

describe("escalating romanised Hindi to the LLM", () => {
  it("asks the LLM to identify the language, not to translate 'English' into English", async () => {
    const h = setup([{ lang: "en", confidence: 0.9 }]);
    h.loop.start();
    await h.settle();
    await h.clickGlobe();
    await h.clickEscalate();

    expect(h.translateLlm).toHaveBeenCalledTimes(1);
    expect(h.translateLlm.mock.calls[0]?.[0].source).toBe("auto");
    expect(h.text()).toContain("what are you doing this evening");
  });
});

describe("a reader who reads Hindi", () => {
  it("is not shown translations of Hindi written in Latin letters", async () => {
    const h = setup([{ lang: "hi-Latn", confidence: 0.9 }], ["en", "hi"]);
    h.loop.start();
    await h.settle();
    expect(h.text()).toBe("");
    expect(onlyHinglish(h.translateOnDevice.mock.calls)).toEqual([]);
  });
});
