import {
  mask,
  resolve,
  restore,
  route,
  type Detection,
  type LanguageCode,
  type Route,
  type RoutingPolicy,
  type TranslationRequest,
} from "@polyglot/core";
import { buildEscalation, collectContext } from "./escalate.js";
import type { ExtractedMessage, PlatformAdapter } from "./adapter.js";
import { Batcher, mapWithLimit } from "./batch.js";
import { MemoryOnlyCache, type TranslationCache } from "./cache.js";
import { ImmediateGate, type Gate } from "./gate.js";
import { TranslationLayer, type LayerState } from "./layer.js";

/**
 * The render loop: DOM in, layers out.
 *
 * Order of operations, and why:
 *
 *   mutation -> extract -> **gate** -> cache -> **batch** -> translate -> inject
 *
 * The gate comes before everything that costs anything. Nothing is extracted
 * into a translation, no cache is consulted and no layer is built until a
 * message is near the viewport, because a 500-message scrollback must not cost
 * 500 translations. The cache is consulted before the batcher so a hit never
 * waits out the debounce window.
 */

/**
 * Cheap, synchronous content fingerprint.
 *
 * Not a cache key (those are SHA-256, in core) — this is the *node* key, and it
 * runs on every mutation, so it has to be fast rather than collision-proof.
 */
export function fingerprint(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * Identity of a *rendered* layer.
 *
 * Keying on the message id alone was a bug: Discord messages are edited
 * constantly, the id survives the edit, and a stale translation would sit under
 * the new text. Keying on a hash of author+text+timestamp instead failed the
 * other way — the key changed on edit, orphaning the old layer and silently
 * re-translating. Keying on both fixes both at once, and makes a virtualized
 * remount of unchanged text a free cache hit by construction.
 */
export const nodeKey = (id: string, text: string): string => `${id}@${fingerprint(text)}`;

/** One unit of translation work, after routing has decided where it goes. */
interface TranslateJob {
  masked: string;
  source: LanguageCode;
  target: LanguageCode;
  decision: Extract<Route, { kind: "local" } | { kind: "cloud-mt" }>;
}

export interface LoopDeps {
  adapter: PlatformAdapter;
  doc: Document;
  policy: RoutingPolicy;
  target: LanguageCode;
  knownLanguages: readonly LanguageCode[];
  /** Injected — built-in in the browser, a fake in tests. */
  detect(text: string): Promise<Detection[]>;
  /** Returns null when the pack is not ready; never falls back to cloud. */
  translateOnDevice(source: string, target: string, text: string): Promise<string | null>;
  translateCloud?: (provider: string, source: string, target: string, text: string) => Promise<string>;
  /**
   * The LLM escalation. Absent means the layer shows no "translate properly"
   * button at all — the affordance exists only when the path behind it does.
   *
   * Takes the whole request rather than loose arguments so `initiation` and
   * `contextWindow` travel together and cannot be separated on the way down.
   */
  translateLlm?: (request: TranslationRequest) => Promise<string>;
  onNeedsDownload?: (source: string, target: string) => void;
  /**
   * Gating policy, injected rather than assumed. A viewport gate in the
   * browser; a demand gate (reply command, reaction) for a consumer with no
   * viewport. Defaults to releasing everything.
   */
  gate?: Gate;
  cache?: TranslationCache;
  batch?: { debounceMs?: number; maxSize?: number; concurrency?: number };
}

interface Mounted {
  key: string;
  layer: TranslationLayer;
}

export class RenderLoop {
  private deps: LoopDeps;
  private gate: Gate;
  private cache: TranslationCache;
  private batcher: Batcher<TranslateJob, string | null>;

  private mounted = new Map<string, Mounted>();
  /** Gated, awaiting release. Not yet mounted, not yet costing anything. */
  private watched = new Map<string, { key: string; el: HTMLElement }>();
  private authorHistory = new Map<string, LanguageCode[]>();
  /** Tally of confidently detected languages, used to pick an outbound target. */
  private languageTally = new Map<LanguageCode, number>();
  private observer: MutationObserver | null = null;
  private root: Element | null = null;
  private stopped = false;
  /** Release tasks still running, so `drain()` can wait for a stable state. */
  private inflight = new Set<Promise<void>>();

  constructor(deps: LoopDeps) {
    this.deps = deps;
    this.gate = deps.gate ?? new ImmediateGate();
    this.cache = deps.cache ?? new MemoryOnlyCache();

    const concurrency = deps.batch?.concurrency ?? 4;
    this.batcher = new Batcher<TranslateJob, string | null>(
      async (items) => {
        const results = new Map<string, string | null>();
        // On-device has no batch endpoint, so this is a concurrency ceiling
        // rather than a request bundle. A cloud provider that accepts an array
        // would group its items here instead — see batch.ts.
        const settled = await mapWithLimit(items, concurrency, async (item) => {
          const { masked, source, target, decision } = item.value;
          const text =
            decision.kind === "local"
              ? await this.deps.translateOnDevice(source, target, masked)
              : ((await this.deps.translateCloud?.(decision.provider, source, target, masked)) ??
                null);
          return [item.key, text] as const;
        });
        for (const [key, text] of settled) results.set(key, text);
        return results;
      },
      {
        debounceMs: deps.batch?.debounceMs ?? 150,
        maxSize: deps.batch?.maxSize ?? 20,
      },
    );
  }

  start(): boolean {
    this.root = this.deps.adapter.observeRoot(this.deps.doc);
    if (!this.root) return false;
    this.stopped = false;

    this.observer = new MutationObserver(() => {
      void this.sync();
    });
    // `aria-expanded` is watched so that revealing a spoiler re-translates the
    // message: the reveal changes the extracted text, which changes the node key
    // (messageId, hash(text)), so the existing lifecycle handles it for free.
    // Filtered to that one attribute — watching `class` across a Discord subtree
    // would fire on every hover.
    this.observer.observe(this.root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-expanded"],
    });

    void this.sync();
    return true;
  }

  stop(): void {
    this.stopped = true;
    this.observer?.disconnect();
    this.observer = null;
    this.gate.disconnect();
    for (const m of this.mounted.values()) m.layer.remove();
    this.mounted.clear();
    this.watched.clear();
  }

  /** Public for tests: reconcile the current DOM once. */
  async sync(): Promise<void> {
    if (!this.root || this.stopped) return;
    const messages = this.deps.adapter.findMessages(this.root);
    const liveIds = new Set<string>();

    for (const el of messages) {
      const extracted = this.deps.adapter.extract(el);
      if (!extracted) continue;
      liveIds.add(extracted.id);

      const key = nodeKey(extracted.id, extracted.text);

      const mounted = this.mounted.get(extracted.id);
      if (mounted) {
        if (mounted.key === key) continue; // unchanged; layer stands
        mounted.layer.remove(); // edited; drop stale layer and re-gate
        this.mounted.delete(extracted.id);
      }

      const watched = this.watched.get(extracted.id);
      if (watched) {
        if (watched.key === key) continue; // already waiting on the gate
        this.gate.unwatch(watched.el); // edited before it was ever released
        this.watched.delete(extracted.id);
      }

      this.watched.set(extracted.id, { key, el });
      this.gate.watch(el, () => {
        const task = this.release(el, extracted, key);
        this.inflight.add(task);
        void task.finally(() => this.inflight.delete(task));
      });
    }

    // Deletions: anything we hold whose message left the DOM.
    for (const [id, m] of [...this.mounted]) {
      if (liveIds.has(id)) continue;
      m.layer.remove();
      this.mounted.delete(id);
    }
    for (const [id, w] of [...this.watched]) {
      if (liveIds.has(id)) continue;
      this.gate.unwatch(w.el);
      this.watched.delete(id);
    }
  }

  /** The gate opened: this message is worth spending on. */
  private async release(
    el: HTMLElement,
    extracted: ExtractedMessage,
    key: string,
  ): Promise<void> {
    if (this.stopped) return;

    const watched = this.watched.get(extracted.id);
    if (!watched || watched.key !== key) return; // superseded by an edit
    this.watched.delete(extracted.id);

    const point = this.deps.adapter.injectionPoint(el);
    if (!point) return;

    const layer = new TranslationLayer(this.deps.doc, {
      onTranslateRequest: () => void this.forceTranslate(extracted, layer),
      onEnablePack: (source, target) => this.deps.onNeedsDownload?.(source, target),
      ...(this.deps.translateLlm
        ? { onEscalate: () => void this.escalate(extracted, layer) }
        : {}),
    });

    point.parent.insertBefore(layer.host, point.before);
    layer.attachHoverAffordance(el);
    this.mounted.set(extracted.id, { key, layer });

    layer.render(await this.resolveAndTranslate(extracted));
  }

  private async resolveAndTranslate(extracted: ExtractedMessage): Promise<LayerState> {
    const detections = await this.deps.detect(extracted.text);
    const resolution = resolve(extracted.text, detections, {
      knownLanguages: this.deps.knownLanguages,
      ...(extracted.author ? { authorRecent: this.authorHistory.get(extracted.author) ?? [] } : {}),
    });

    if (resolution.lang === null) {
      // Nothing renders, but the layer stays mounted so the hover globe is
      // reachable. This is the false-negative case and the affordance is the
      // mitigation.
      return { kind: "idle" };
    }

    if (resolution.source === "detector") {
      this.languageTally.set(resolution.lang, (this.languageTally.get(resolution.lang) ?? 0) + 1);
      if (extracted.author) {
        const history = this.authorHistory.get(extracted.author) ?? [];
        this.authorHistory.set(extracted.author, [resolution.lang, ...history].slice(0, 10));
      }
    }

    return this.translate(resolution.lang, extracted.text);
  }

  private async translate(source: LanguageCode, text: string): Promise<LayerState> {
    const target = this.deps.target;
    const decision = route({ text, source, target, initiation: "automatic" }, this.deps.policy);

    switch (decision.kind) {
      case "skip":
        return { kind: "idle" };

      case "needs-pack-download":
        // Terminal. Never falls through to cloud: a pending download must not
        // become a silent DeepL request for a pair that was about to be free.
        return { kind: "needs-download", source, target };

      case "unsupported":
        return { kind: "failed", reason: `no provider for ${source} → ${target}` };

      case "local":
      case "cloud-mt":
        return this.dispatch(source, target, text, decision);
    }
  }

  private async dispatch(
    source: LanguageCode,
    target: LanguageCode,
    text: string,
    decision: TranslateJob["decision"],
  ): Promise<LayerState> {
    const provider = decision.kind === "local" ? "on-device" : decision.provider;
    const { masked, spans } = mask(text);

    // No context window: this is the automatic path, and thread context is
    // permitted only on user-initiated paths.
    const cacheable = { text, source, target };

    const hit = await this.cache.get(cacheable, provider);
    if (hit !== null) {
      // Ahead of the batcher on purpose — a hit must not wait out the debounce.
      const { text: restored } = restore(hit, spans);
      return { kind: "translated", text: restored, source, target, via: "auto" };
    }

    try {
      // Keyed on the masked text and pair, so six people typing the same thing
      // in one window cost one translation.
      const raw = await this.batcher.add(`${provider}|${source}|${target}|${masked}`, {
        masked,
        source,
        target,
        decision,
      });

      if (raw == null) return { kind: "needs-download", source, target };

      await this.cache.put(cacheable, provider, raw);
      const { text: restored } = restore(raw, spans);
      return { kind: "translated", text: restored, source, target, via: "auto" };
    } catch (error) {
      return { kind: "failed", reason: String(error) };
    }
  }

  /**
   * "Translate properly": re-translate this one message with an LLM, using the
   * preceding few messages as context.
   *
   * Everything here is deliberately confined to the user's click. This is the
   * only path that sends thread context, the only path that reaches an LLM, and
   * the only path that writes the context-assisted cache tier — which is keyed
   * on the context too, so it hits only on a genuine repeat of both.
   */
  private async escalate(
    extracted: ExtractedMessage,
    layer: TranslationLayer,
  ): Promise<void> {
    const translateLlm = this.deps.translateLlm;
    if (!translateLlm || !this.root) return;

    layer.render({ kind: "escalating" });

    const detections = await this.deps.detect(extracted.text);
    const source = detections[0]?.lang ?? "auto";
    const target = this.deps.target;

    const context = collectContext(this.deps.adapter, this.root, extracted.id);
    const { masked, spans } = mask(extracted.text);

    let request: TranslationRequest;
    try {
      // Throws if this were ever wired to something automatic. Cheap, and the
      // drift it catches is exactly the one that would go unnoticed.
      request = buildEscalation({ text: masked }, source, target, context);
    } catch (error) {
      layer.render({ kind: "failed", reason: String(error) });
      return;
    }

    // The context is part of the key: the same text under different
    // surroundings has a different correct translation, so this tier hits only
    // on a genuine repeat of both.
    const cacheable = {
      text: extracted.text,
      source,
      target,
      ...(request.contextWindow ? { contextWindow: request.contextWindow } : {}),
    };

    const hit = await this.cache.get(cacheable, "llm");
    if (hit !== null) {
      layer.render({
        kind: "translated",
        text: restore(hit, spans).text,
        source,
        target,
        via: "llm",
      });
      return;
    }

    try {
      const raw = await translateLlm(request);
      await this.cache.put(cacheable, "llm", raw);
      layer.render({
        kind: "translated",
        text: restore(raw, spans).text,
        source,
        target,
        via: "llm",
      });
    } catch (error) {
      layer.render({ kind: "failed", reason: String(error) });
    }
  }

  /** Hover globe: translate regardless of the skip rules that suppressed it. */
  private async forceTranslate(
    extracted: ExtractedMessage,
    layer: TranslationLayer,
  ): Promise<void> {
    layer.render({ kind: "pending" });
    const detections = await this.deps.detect(extracted.text);
    const source = detections[0]?.lang ?? "auto";
    layer.render(await this.translate(source, extracted.text));
  }

  /**
   * Waits until nothing is in flight.
   *
   * Release is asynchronous and the batcher deliberately waits for more work,
   * so `sync()` returning does not mean the layers are rendered. Tests and
   * teardown need a stable point; this alternates letting queued work reach the
   * batcher with flushing it, rather than awaiting in-flight tasks first, which
   * would deadlock against the debounce.
   */
  async drain(): Promise<void> {
    for (let i = 0; i < 25; i++) {
      if (this.inflight.size === 0 && this.batcher.pending === 0) break;
      await new Promise((r) => setTimeout(r, 0));
      await this.batcher.flush();
    }
    await Promise.all([...this.inflight]);
  }

  get mountedCount(): number {
    return this.mounted.size;
  }

  get watchedCount(): number {
    return this.watched.size;
  }

  /**
   * The language this channel mostly speaks, or null if nothing has been read
   * confidently yet.
   *
   * Outbound needs a target and guessing one would be worse than asking: sending
   * a message in the wrong language is not recoverable the way a bad inbound
   * translation is. Counts only confident detections, and only languages I do
   * not already read — translating into my own language is not a send target.
   */
  dominantLanguage(): LanguageCode | null {
    let best: LanguageCode | null = null;
    let bestCount = 0;
    for (const [lang, count] of this.languageTally) {
      if (this.deps.knownLanguages.includes(lang)) continue;
      if (count > bestCount) {
        best = lang;
        bestCount = count;
      }
    }
    return best;
  }
}
