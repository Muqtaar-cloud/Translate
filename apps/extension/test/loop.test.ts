// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixture } from "./fixture.js";
import type { Availability, Detection } from "@polyglot/core";
import { DiscordAdapter } from "../src/content/discord.js";
import { fingerprint, nodeKey, RenderLoop, type LoopDeps } from "../src/content/loop.js";
import { MemoryOnlyCache } from "../src/content/cache.js";

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
    batch: { debounceMs: 0 },
    ...over,
  };

  return { loop: new RenderLoop(deps), translateOnDevice, deps };
}

/**
 * Release and translation are asynchronous now that the gate and batcher sit
 * in the path, so sync() returning no longer means the layers are rendered.
 */
async function settle(loop: RenderLoop): Promise<void> {
  await loop.sync();
  await loop.drain();
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
    await settle(loop);

    expect(layerTextFor("900001")).toContain("EN(¿vienes mañana a la fiesta?)");
    expect(layerTextFor("900001")).toContain("es → en");
  });

  // PLAN.md §12: zero layers rendered on messages already in a known language.
  it("renders nothing and spends nothing on an English message", async () => {
    const { loop, translateOnDevice } = makeLoop();
    loop.start();
    await settle(loop);

    expect(layerTextFor("900004").trim()).toBe("");
    const translated = translateOnDevice.mock.calls.map((c) => c[2]);
    expect(translated.some((t) => t.includes("sounds good"))).toBe(false);
  });

  it("keeps a mounted layer for a message detection could not judge", async () => {
    const { loop } = makeLoop();
    loop.start();
    await settle(loop);

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
    await settle(loop);
    const first = translateOnDevice.mock.calls.length;

    await loop.sync();
    await loop.sync();
    expect(translateOnDevice.mock.calls.length).toBe(first);
  });

  it("re-translates an edited message and drops the stale layer", async () => {
    const { loop, translateOnDevice } = makeLoop();
    loop.start();
    await settle(loop);
    const before = translateOnDevice.mock.calls.length;

    document.querySelector("#message-content-900001")!.textContent =
      "¿vienes el domingo a la fiesta?";
    await settle(loop);

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
    await settle(loop);
    const before = layersIn().length;

    document.querySelector('li[id$="-900001"]')!.remove();
    await settle(loop);

    expect(layersIn().length).toBe(before - 1);
  });

  it("stops cleanly and takes its layers with it", async () => {
    const { loop } = makeLoop();
    loop.start();
    await settle(loop);
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
    await settle(loop);

    expect(translateCloud).not.toHaveBeenCalled();
    expect(translateOnDevice).not.toHaveBeenCalled();
    expect(layerTextFor("900001")).toMatch(/needs a language pack/);
    expect(layerTextFor("900001")).toMatch(/Download es pack/);
  });

  it("treats a null on-device result as a download prompt, not an error", async () => {
    const { loop } = makeLoop({ translateOnDevice: async () => null });
    loop.start();
    await settle(loop);
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
    await settle(loop);
    expect(translateCloud).toHaveBeenCalled();
    expect(layerTextFor("900001")).toContain("cloud translation");
  });

  it("says so plainly when no provider covers the pair", async () => {
    const { loop } = makeLoop({
      policy: { knownLanguages: ["en"], cloudEnabled: false, availability: () => "unavailable" },
    });
    loop.start();
    await settle(loop);
    expect(layerTextFor("900001")).toMatch(/no provider for es → en/);
  });

  it("surfaces a translation error instead of rendering an empty layer", async () => {
    const { loop } = makeLoop({
      translateOnDevice: async () => {
        throw new Error("pack evicted");
      },
    });
    loop.start();
    await settle(loop);
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
    await settle(loop);

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


describe("Phase 2: gating, caching, batching in the loop", () => {
  /** A gate we open by hand, standing in for the viewport. */
  class ManualGate {
    private pending = new Map<HTMLElement, () => void>();
    watch(el: HTMLElement, release: () => void): void {
      this.pending.set(el, release);
    }
    unwatch(el: HTMLElement): void {
      this.pending.delete(el);
    }
    disconnect(): void {
      this.pending.clear();
    }
    releaseAll(): void {
      const all = [...this.pending.values()];
      this.pending.clear();
      for (const r of all) r();
    }
    release(id: string): void {
      for (const [el, r] of this.pending) {
        if (el.id.endsWith(id)) {
          this.pending.delete(el);
          r();
          return;
        }
      }
    }
    get size(): number {
      return this.pending.size;
    }
  }

  // The cost defence. A backlog nobody has scrolled to must cost nothing.
  it("translates nothing while the gate stays shut", async () => {
    const gate = new ManualGate();
    const { loop, translateOnDevice } = makeLoop({ gate });

    loop.start();
    await settle(loop);

    expect(translateOnDevice).not.toHaveBeenCalled();
    expect(layersIn()).toHaveLength(0);
    expect(loop.watchedCount).toBe(6);
  });

  it("translates only what the gate releases", async () => {
    const gate = new ManualGate();
    const { loop, translateOnDevice } = makeLoop({ gate });

    loop.start();
    await settle(loop);
    gate.release("900001");
    await loop.drain();

    expect(translateOnDevice).toHaveBeenCalledOnce();
    expect(layersIn()).toHaveLength(1);
    expect(layerTextFor("900001")).toContain("EN(¿vienes mañana a la fiesta?)");
  });

  it("does not build a layer for a message that was never released", async () => {
    const gate = new ManualGate();
    const { loop } = makeLoop({ gate });

    loop.start();
    await settle(loop);
    gate.release("900001");
    await loop.drain();

    const other = document.querySelector('li[id$="-900002"]')!;
    expect(other.querySelector("polyglot-layer")).toBeNull();
  });

  it("stops watching a message that is deleted before it is ever seen", async () => {
    const gate = new ManualGate();
    const { loop } = makeLoop({ gate });

    loop.start();
    await settle(loop);
    expect(gate.size).toBe(6);

    document.querySelector('li[id$="-900001"]')!.remove();
    await settle(loop);

    expect(gate.size).toBe(5);
    expect(loop.watchedCount).toBe(5);
  });

  it("re-gates a message edited while it was still off-screen", async () => {
    const gate = new ManualGate();
    const { loop, translateOnDevice } = makeLoop({ gate });

    loop.start();
    await settle(loop);
    document.querySelector("#message-content-900001")!.textContent = "¿vienes el lunes?";
    await settle(loop);

    gate.releaseAll();
    await loop.drain();

    // Translated once, with the new text — not once per version.
    const calls = translateOnDevice.mock.calls.map((c) => c[2]);
    expect(calls.filter((t) => t.includes("vienes"))).toEqual(["¿vienes el lunes?"]);
  });

  describe("cache", () => {
    it("serves a repeat of the same text without translating again", async () => {
      const cache = new MemoryOnlyCache();
      const gate = new ManualGate();
      const { loop, translateOnDevice } = makeLoop({ cache, gate });

      loop.start();
      await settle(loop);
      gate.release("900001");
      await loop.drain();
      expect(translateOnDevice).toHaveBeenCalledOnce();

      // Same text posted again as a new message.
      const fresh = document.createElement("li");
      fresh.id = "chat-messages-100-900099";
      fresh.innerHTML =
        '<h3><span id="message-username-900099">ana</span></h3>' +
        '<div id="message-content-900099">¿vienes mañana a la fiesta?</div>';
      document.querySelector('[data-list-id="chat-messages"]')!.append(fresh);

      await settle(loop);
      gate.release("900099");
      await loop.drain();

      expect(translateOnDevice).toHaveBeenCalledOnce(); // still one
      expect(layerTextFor("900099")).toContain("EN(¿vienes mañana a la fiesta?)");
    });

    it("keeps a cache hit out of the batcher's debounce window", async () => {
      const cache = new MemoryOnlyCache();
      await cache.put({ text: "¿vienes mañana a la fiesta?", source: "es", target: "en" }, "on-device", "cached!");

      const { loop, translateOnDevice } = makeLoop({
        cache,
        batch: { debounceMs: 60_000 },
      });

      loop.start();
      // No drain: if a hit waited on the batcher this would still be pending.
      await loop.sync();
      await new Promise((r) => setTimeout(r, 20));

      expect(layerTextFor("900001")).toContain("cached!");
      expect(translateOnDevice).not.toHaveBeenCalled();
    });

    it("does not let one message's cache entry answer another's", async () => {
      const cache = new MemoryOnlyCache();
      const { loop } = makeLoop({ cache });

      loop.start();
      await settle(loop);

      expect(layerTextFor("900001")).toContain("¿vienes mañana a la fiesta?");
      expect(layerTextFor("900002")).toContain("jajaja");
    });
  });

  describe("batching", () => {
    it("coalesces identical messages into a single translation", async () => {
      const gate = new ManualGate();
      const { loop, translateOnDevice } = makeLoop({
        gate,
        // No cache, so a shared dispatch is the only thing that can dedupe.
        cache: { get: async () => null, put: async () => {} },
        batch: { debounceMs: 5 },
      });

      const list = document.querySelector('[data-list-id="chat-messages"]')!;
      for (const id of ["900101", "900102", "900103"]) {
        const li = document.createElement("li");
        li.id = `chat-messages-100-${id}`;
        li.innerHTML = `<div id="message-content-${id}">buenos días a todos</div>`;
        list.append(li);
      }

      loop.start();
      await settle(loop);
      gate.releaseAll();
      await loop.drain();

      const greetings = translateOnDevice.mock.calls
        .map((c) => c[2])
        .filter((t) => t.includes("buenos días"));
      expect(greetings).toHaveLength(1);
      for (const id of ["900101", "900102", "900103"]) {
        expect(layerTextFor(id)).toContain("EN(buenos días a todos)");
      }
    });

    it("keeps concurrent translations under the ceiling", async () => {
      let active = 0;
      let peak = 0;
      const gate = new ManualGate();
      const { loop } = makeLoop({
        gate,
        batch: { debounceMs: 5, concurrency: 2 },
        translateOnDevice: async (_s, _t, text) => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 1));
          active--;
          return `EN(${text})`;
        },
      });

      loop.start();
      await settle(loop);
      gate.releaseAll();
      await loop.drain();

      expect(peak).toBeLessThanOrEqual(2);
    });
  });
});

describe("LLM escalation (§4.3, §5.1)", () => {
  const clickEscalate = (id: string): boolean => {
    const li = document.querySelector(`li[id$="-${id}"]`)!;
    const button = li
      .querySelector("polyglot-layer")
      ?.shadowRoot?.querySelector<HTMLButtonElement>('[data-polyglot="escalate"]');
    button?.click();
    return Boolean(button);
  };

  it("offers no escalation button when no LLM path is wired", async () => {
    const { loop } = makeLoop();
    loop.start();
    await settle(loop);
    expect(clickEscalate("900001")).toBe(false);
  });

  it("offers one on a translated message once the path exists", async () => {
    const { loop } = makeLoop({ translateLlm: async () => "properly translated" });
    loop.start();
    await settle(loop);
    expect(clickEscalate("900001")).toBe(true);
  });

  it("re-translates with the LLM and marks the result as such", async () => {
    const translateLlm = vi.fn(async () => "are you coming to the party tomorrow?");
    const { loop } = makeLoop({ translateLlm });

    loop.start();
    await settle(loop);
    clickEscalate("900001");
    await new Promise((r) => setTimeout(r, 20));

    expect(translateLlm).toHaveBeenCalledOnce();
    expect(layerTextFor("900001")).toContain("are you coming to the party tomorrow?");
    // Distinguished from the free path: this one cost money and sent context.
    expect(layerTextFor("900001")).toContain("ai");
  });

  // The whole point of the escalation being user-initiated.
  it("sends bounded thread context, marked user-initiated", async () => {
    let captured: Parameters<NonNullable<LoopDeps["translateLlm"]>>[0] | null = null;
    const { loop } = makeLoop({
      translateLlm: async (request) => {
        captured = request;
        return "ok";
      },
    });

    loop.start();
    await settle(loop);
    // 900002 rather than 900003: the latter is the short message detection
    // cannot judge, so it renders idle and carries the hover globe instead of
    // an escalation button.
    clickEscalate("900002");
    await new Promise((r) => setTimeout(r, 20));

    expect(captured).not.toBeNull();
    expect(captured!.initiation).toBe("user");
    expect(captured!.contextWindow?.length).toBeGreaterThan(0);
    expect(captured!.contextWindow?.length).toBeLessThanOrEqual(5);
  });

  it("never sends context on the automatic path", async () => {
    const seen: unknown[] = [];
    const { loop } = makeLoop({
      translateOnDevice: async (_s, _t, text) => {
        seen.push(text);
        return `EN(${text})`;
      },
      translateLlm: async () => "never called",
    });

    loop.start();
    await settle(loop);

    // translateOnDevice takes a bare string: there is no channel through which
    // context could reach it even by accident.
    for (const text of seen) expect(typeof text).toBe("string");
  });

  it("masks DNT spans before the LLM sees them and restores after", async () => {
    let sent = "";
    const { loop } = makeLoop({
      translateLlm: async (request) => {
        sent = request.text;
        return request.text; // echo
      },
    });

    loop.start();
    await settle(loop);
    clickEscalate("900002");
    await new Promise((r) => setTimeout(r, 20));

    expect(sent).not.toContain("<@123>");
    expect(layerTextFor("900002")).toContain("<@123>");
  });

  it("caches on the context-assisted tier, so a repeat costs nothing", async () => {
    const translateLlm = vi.fn(async () => "cached llm result");
    const cache = new MemoryOnlyCache();
    const { loop } = makeLoop({ translateLlm, cache });

    loop.start();
    await settle(loop);
    clickEscalate("900001");
    await new Promise((r) => setTimeout(r, 20));
    clickEscalate("900001");
    await new Promise((r) => setTimeout(r, 20));

    expect(translateLlm).toHaveBeenCalledOnce();
    expect(layerTextFor("900001")).toContain("cached llm result");
  });

  it("surfaces an LLM failure in the layer rather than swallowing it", async () => {
    const { loop } = makeLoop({
      translateLlm: async () => {
        throw new Error("no API key set");
      },
    });

    loop.start();
    await settle(loop);
    clickEscalate("900001");
    await new Promise((r) => setTimeout(r, 20));

    expect(layerTextFor("900001")).toMatch(/no API key set/);
  });

  // A first-run user has no language packs at all. Putting an LLM button on
  // that state would funnel every new user straight to a paid cloud call,
  // which is the pressure §4.3 exists to remove.
  it("offers no escalation while a language pack is merely pending", async () => {
    const { loop } = makeLoop(
      {
        translateLlm: async () => "should not be reachable",
        policy: { knownLanguages: ["en"], cloudEnabled: false, availability: () => "downloadable" },
      },
      "downloadable",
    );

    loop.start();
    await settle(loop);
    expect(layerTextFor("900001")).toMatch(/needs a language pack/);
    expect(clickEscalate("900001")).toBe(false);
  });
});
