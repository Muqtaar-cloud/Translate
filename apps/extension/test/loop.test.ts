// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixture } from "./fixture.js";
import type { Availability, Detection } from "@polyglot/core";
import { DiscordAdapter } from "../src/content/discord.js";
import { fingerprint, nodeKey, RenderLoop, type LoopDeps } from "../src/content/loop.js";

const FIXTURE = fixture("discord-messages.html");

const SPANISH = /[¿ñáéíóú]|jajaja|ya voy|vienes|perfecto|mirad/i;

const fakeDetect = async (text: string): Promise<Detection[]> =>
  SPANISH.test(text) ? [{ lang: "es", confidence: 0.95 }] : [{ lang: "en", confidence: 0.95 }];

function makeLoop(over: Partial<LoopDeps> = {}, availability: Availability = "available") {
  const translateOnDevice = vi.fn(async (_s: string, _t: string, text: string) =>
    `EN(${text})`,
  );

  const deps: LoopDeps = {
    adapter: new DiscordAdapter(() => new URL("https://discord.com/channels/555/100")),
    doc: document,
    target: "en",
    knownLanguages: ["en"],
    detect: fakeDetect,
    translateOnDevice,
    policy: {
      knownLanguages: ["en"],
      cloudEnabled: false,
      availability: () => availability,
    },
    ...over,
  };

  return { loop: new RenderLoop(deps), translateOnDevice, deps };
}

const layersIn = (): HTMLElement[] => [...document.querySelectorAll("polyglot-layer")];
/** Reads the rendered content only — not the shadow root's <style> block. */
const layerTextFor = (id: string): string => {
  const li = document.querySelector(`li[id$="-${id}"]`)!;
  const wrap = li.querySelector("polyglot-layer")?.shadowRoot?.querySelector(".wrap");
  return wrap?.textContent ?? "";
};

beforeEach(() => {
  document.body.innerHTML = FIXTURE;
});

describe("fingerprint / nodeKey", () => {
  it("changes when the text changes", () => {
    expect(fingerprint("ya voy")).not.toBe(fingerprint("ya voy!"));
  });

  it("is stable for identical text", () => {
    expect(nodeKey("1", "hola")).toBe(nodeKey("1", "hola"));
  });

  // The two failure modes the combined key exists to fix at once.
  it("distinguishes an edit from a remount", () => {
    expect(nodeKey("1", "hola")).not.toBe(nodeKey("1", "hola amigo"));
    expect(nodeKey("1", "hola")).not.toBe(nodeKey("2", "hola"));
  });
});

describe("render loop", () => {
  it("mounts a layer under each foreign message", async () => {
    const { loop } = makeLoop();
    expect(loop.start()).toBe(true);
    await loop.sync();

    expect(layerTextFor("900001")).toContain("EN(¿vienes mañana a la fiesta?)");
    expect(layerTextFor("900001")).toContain("es → en");
  });

  // PLAN.md §12: zero layers rendered on messages already in a known language.
  it("renders nothing and spends nothing on an English message", async () => {
    const { loop, translateOnDevice } = makeLoop();
    loop.start();
    await loop.sync();

    expect(layerTextFor("900004").trim()).toBe("");
    const translated = translateOnDevice.mock.calls.map((c) => c[2]);
    expect(translated.some((t) => t.includes("sounds good"))).toBe(false);
  });

  it("keeps a mounted layer for a message detection could not judge", async () => {
    const { loop } = makeLoop();
    loop.start();
    await loop.sync();

    // "ya voy" is under the reliable-length threshold; author stickiness has
    // nothing to go on yet. Nothing renders, but the node stays so the hover
    // globe is reachable — that affordance is what makes skipping safe.
    const li = document.querySelector('li[id$="-900003"]')!;
    expect(li.querySelector("polyglot-layer")).not.toBeNull();
    expect(layerTextFor("900003").trim()).toBe("");
  });

  it("does not translate the same message twice across syncs", async () => {
    const { loop, translateOnDevice } = makeLoop();
    loop.start();
    await loop.sync();
    const first = translateOnDevice.mock.calls.length;

    await loop.sync();
    await loop.sync();
    expect(translateOnDevice.mock.calls.length).toBe(first);
  });

  it("re-translates an edited message and drops the stale layer", async () => {
    const { loop, translateOnDevice } = makeLoop();
    loop.start();
    await loop.sync();
    const before = translateOnDevice.mock.calls.length;

    document.querySelector("#message-content-900001")!.textContent =
      "¿vienes el domingo a la fiesta?";
    await loop.sync();

    expect(translateOnDevice.mock.calls.length).toBe(before + 1);
    expect(layerTextFor("900001")).toContain("domingo");
    // Exactly one layer — the stale one must be gone, not stacked.
    expect(
      document.querySelectorAll('li[id$="-900001"] polyglot-layer'),
    ).toHaveLength(1);
  });

  it("removes the layer when a message is deleted", async () => {
    const { loop } = makeLoop();
    loop.start();
    await loop.sync();
    const before = layersIn().length;

    document.querySelector('li[id$="-900001"]')!.remove();
    await loop.sync();

    expect(layersIn().length).toBe(before - 1);
  });

  it("stops cleanly and takes its layers with it", async () => {
    const { loop } = makeLoop();
    loop.start();
    await loop.sync();
    expect(layersIn().length).toBeGreaterThan(0);

    loop.stop();
    expect(layersIn()).toHaveLength(0);
  });

  it("reports failure when the page has no message list", () => {
    document.body.innerHTML = "<div>loading</div>";
    expect(makeLoop().loop.start()).toBe(false);
  });
});

describe("routing through the loop", () => {
  // The regression that matters most: a pending pack download must never
  // become a silent cloud request for a pair that was about to be free.
  it("prompts for a download instead of falling through to cloud", async () => {
    const translateCloud = vi.fn(async () => "should never be called");
    const { loop, translateOnDevice } = makeLoop(
      {
        translateCloud,
        policy: {
          knownLanguages: ["en"],
          cloudEnabled: true,
          cloudProvider: "deepl",
          availability: () => "downloadable",
        },
      },
      "downloadable",
    );

    loop.start();
    await loop.sync();

    expect(translateCloud).not.toHaveBeenCalled();
    expect(translateOnDevice).not.toHaveBeenCalled();
    expect(layerTextFor("900001")).toMatch(/needs a language pack/);
    expect(layerTextFor("900001")).toMatch(/Download es pack/);
  });

  it("treats a null on-device result as a download prompt, not an error", async () => {
    const { loop } = makeLoop({ translateOnDevice: async () => null });
    loop.start();
    await loop.sync();
    expect(layerTextFor("900001")).toMatch(/needs a language pack/);
  });

  it("uses cloud only when the pair is genuinely unavailable", async () => {
    const translateCloud = vi.fn(async () => "cloud translation");
    const { loop } = makeLoop({
      translateCloud,
      policy: {
        knownLanguages: ["en"],
        cloudEnabled: true,
        cloudProvider: "deepl",
        availability: () => "unavailable",
      },
    });

    loop.start();
    await loop.sync();
    expect(translateCloud).toHaveBeenCalled();
    expect(layerTextFor("900001")).toContain("cloud translation");
  });

  it("says so plainly when no provider covers the pair", async () => {
    const { loop } = makeLoop({
      policy: { knownLanguages: ["en"], cloudEnabled: false, availability: () => "unavailable" },
    });
    loop.start();
    await loop.sync();
    expect(layerTextFor("900001")).toMatch(/no provider for es → en/);
  });

  it("surfaces a translation error instead of rendering an empty layer", async () => {
    const { loop } = makeLoop({
      translateOnDevice: async () => {
        throw new Error("pack evicted");
      },
    });
    loop.start();
    await loop.sync();
    expect(layerTextFor("900001")).toMatch(/translation failed/);
  });
});

describe("DNT spans through the loop", () => {
  it("hides mentions, emoji and links from the engine and puts them back", async () => {
    const seen: string[] = [];
    const { loop } = makeLoop({
      translateOnDevice: async (_s, _t, text) => {
        seen.push(text);
        return text; // echo, so restoration is what is being checked
      },
    });

    loop.start();
    await loop.sync();

    const sent = seen.find((t) => t.includes("jajaja"))!;
    expect(sent).not.toContain("<@123>");
    expect(sent).not.toContain(":facepalm:");
    expect(sent).not.toContain("https://example.com/a");

    const rendered = layerTextFor("900002");
    expect(rendered).toContain("<@123>");
    expect(rendered).toContain(":facepalm:");
    expect(rendered).toContain("https://example.com/a");
  });
});

describe("Phase 2 seam", () => {
  it("honours a gating hook without the loop needing to change", async () => {
    // This is where the IntersectionObserver goes. Wiring it now means adding
    // viewport gating later is a parameter, not a rewrite.
    const { loop, translateOnDevice } = makeLoop({
      shouldTranslate: (el) => el.id.endsWith("900001"),
    });

    loop.start();
    await loop.sync();
    expect(translateOnDevice).toHaveBeenCalledTimes(1);
  });
});
