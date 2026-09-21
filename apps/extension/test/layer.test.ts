// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { TranslationLayer, type LayerState } from "../src/content/layer.js";

const render = (state: LayerState, onEscalate?: () => void): TranslationLayer => {
  const layer = new TranslationLayer(
    document,
    onEscalate
      ? { onTranslateRequest: vi.fn(), onEnablePack: vi.fn(), onEscalate }
      : { onTranslateRequest: vi.fn(), onEnablePack: vi.fn() },
  );
  document.body.append(layer.host);
  layer.render(state);
  return layer;
};

const textOf = (layer: TranslationLayer): string =>
  layer.host.shadowRoot?.querySelector(".wrap")?.textContent ?? "";

const translated = (via: "auto" | "cloud" | "llm"): LayerState => ({
  kind: "translated",
  text: "are you coming tomorrow?",
  source: "es",
  target: "en",
  via,
});

describe("the translation itself", () => {
  it("shows the badge and the text", () => {
    const layer = render(translated("auto"));
    // Lowercase in the DOM; the uppercasing is CSS, so the text node is "es → en".
    expect(textOf(layer)).toContain("es → en");
    expect(textOf(layer)).toContain("are you coming tomorrow?");
  });

  it("names itself a translation for screen readers", () => {
    const layer = render(translated("auto"));
    expect(layer.host.getAttribute("role")).toBe("note");
    expect(layer.host.getAttribute("aria-label")).toContain("es");
  });

  it("sets dir and lang so an RTL translation is not scrambled", () => {
    const text = render(translated("auto")).host.shadowRoot?.querySelector(".text");
    expect(text?.getAttribute("dir")).toBe("auto");
    expect(text?.getAttribute("lang")).toBe("en");
  });
});

// PLAN.md §5 promises a visible indicator whenever a cloud provider is in use,
// and the options page now tells the user in as many words that cloud-translated
// messages are marked. A line that left the machine must not look identical to
// one that never did.
describe("provenance", () => {
  it("marks a cloud translation", () => {
    expect(textOf(render(translated("cloud")))).toContain("cloud");
  });

  it("leaves an on-device translation unmarked", () => {
    const out = textOf(render(translated("auto")));
    expect(out).not.toContain("cloud");
    expect(out).not.toContain("ai");
  });

  it("marks an LLM translation, which also sent context", () => {
    expect(textOf(render(translated("llm")))).toContain("ai");
  });

  it("does not offer to escalate something already escalated", () => {
    const layer = render(translated("llm"), vi.fn());
    expect(layer.host.shadowRoot?.querySelector('[data-polyglot="escalate"]')).toBeNull();
  });

  // A cloud result is exactly the case where the cheap path may have mangled
  // something, so the escalation has to stay reachable from it.
  it("still offers to escalate a cloud translation", () => {
    const layer = render(translated("cloud"), vi.fn());
    expect(layer.host.shadowRoot?.querySelector('[data-polyglot="escalate"]')).not.toBeNull();
  });

  it("offers to escalate an on-device translation", () => {
    const layer = render(translated("auto"), vi.fn());
    expect(layer.host.shadowRoot?.querySelector('[data-polyglot="escalate"]')).not.toBeNull();
  });
});

describe("the other states", () => {
  it("asks for a pack rather than failing silently", () => {
    const layer = render({ kind: "needs-download", source: "es", target: "en" });
    expect(textOf(layer)).toContain("language pack");
    expect(layer.host.shadowRoot?.querySelector("button")).not.toBeNull();
  });

  it("renders nothing for a message it could not judge", () => {
    expect(textOf(render({ kind: "idle" })).trim()).toBe("");
  });

  // The hover affordance is what makes the short-message skip rule safe, so it
  // has to be reachable on a layer that renders nothing at all.
  it("keeps the hover globe reachable on an empty layer", () => {
    const message = document.createElement("li");
    document.body.append(message);
    const layer = render({ kind: "idle" });
    layer.attachHoverAffordance(message);
    message.dispatchEvent(new Event("mouseenter"));
    expect(layer.host.shadowRoot?.querySelector('[data-polyglot="globe"]')).not.toBeNull();
  });
});
