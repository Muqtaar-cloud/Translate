import {
  mask,
  resolve,
  restore,
  route,
  type Detection,
  type LanguageCode,
  type RoutingPolicy,
} from "@polyglot/core";
import type { ExtractedMessage, PlatformAdapter } from "./adapter.js";
import { TranslationLayer, type LayerState } from "./layer.js";

/**
 * The render loop: DOM in, layers out.
 *
 * Phase 1 wires the lifecycle. Viewport gating and batching are Phase 2 — the
 * `shouldTranslate` hook below is where the IntersectionObserver goes, and it
 * is a parameter now so adding it later is not a rewrite.
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

export interface LoopDeps {
  adapter: PlatformAdapter;
  doc: Document;
  policy: RoutingPolicy;
  target: LanguageCode;
  /** Injected — built-in in the browser, a fake in tests (PLAN.md §4.5). */
  detect(text: string): Promise<Detection[]>;
  /** Returns null when the pack is not ready; never falls back to cloud. */
  translateOnDevice(source: string, target: string, text: string): Promise<string | null>;
  /** Cloud path. Phase 1 leaves this unimplemented; routing still decides it. */
  translateCloud?: (provider: string, source: string, target: string, text: string) => Promise<string>;
  /** Called when a pair needs a user gesture to download its pack. */
  onNeedsDownload?: (source: string, target: string) => void;
  /** Phase 2 hook: viewport gating goes here without restructuring the loop. */
  shouldTranslate?: (el: HTMLElement) => boolean;
  /** Per-author language stickiness for short messages. */
  knownLanguages: readonly LanguageCode[];
}

interface Mounted {
  key: string;
  layer: TranslationLayer;
}

export class RenderLoop {
  private deps: LoopDeps;
  private mounted = new Map<string, Mounted>();
  private authorHistory = new Map<string, LanguageCode[]>();
  private observer: MutationObserver | null = null;
  private root: Element | null = null;

  constructor(deps: LoopDeps) {
    this.deps = deps;
  }

  start(): boolean {
    this.root = this.deps.adapter.observeRoot(this.deps.doc);
    if (!this.root) return false;

    this.observer = new MutationObserver(() => {
      void this.sync();
    });
    this.observer.observe(this.root, { childList: true, subtree: true, characterData: true });

    void this.sync();
    return true;
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    for (const m of this.mounted.values()) m.layer.remove();
    this.mounted.clear();
  }

  /** Public for tests: process the current DOM once. */
  async sync(): Promise<void> {
    if (!this.root) return;
    const messages = this.deps.adapter.findMessages(this.root);
    const seen = new Set<string>();

    for (const el of messages) {
      const extracted = this.deps.adapter.extract(el);
      if (!extracted) continue;

      const key = nodeKey(extracted.id, extracted.text);
      seen.add(key);

      const existing = this.mounted.get(extracted.id);
      if (existing) {
        if (existing.key === key) continue; // unchanged; layer stands
        // Edited. Drop the stale layer and fall through to re-translate.
        existing.layer.remove();
        this.mounted.delete(extracted.id);
      }

      if (this.deps.shouldTranslate && !this.deps.shouldTranslate(el)) continue;

      await this.mount(el, extracted, key);
    }

    // Deleted messages: a layer whose message is no longer in the DOM.
    for (const [id, m] of [...this.mounted]) {
      const stillPresent = messages.some((el) => this.deps.adapter.extract(el)?.id === id);
      if (!stillPresent) {
        m.layer.remove();
        this.mounted.delete(id);
      }
    }
  }

  private async mount(
    el: HTMLElement,
    extracted: ExtractedMessage,
    key: string,
  ): Promise<void> {
    const point = this.deps.adapter.injectionPoint(el);
    if (!point) return;

    const layer = new TranslationLayer(this.deps.doc, {
      onTranslateRequest: () => void this.forceTranslate(extracted, layer),
      onEnablePack: (source, target) => this.deps.onNeedsDownload?.(source, target),
    });

    point.parent.insertBefore(layer.host, point.before);
    layer.attachHoverAffordance(el);
    this.mounted.set(extracted.id, { key, layer });

    const state = await this.resolveAndTranslate(extracted);
    layer.render(state);
  }

  private async resolveAndTranslate(extracted: ExtractedMessage): Promise<LayerState> {
    const detections = await this.deps.detect(extracted.text);
    const resolution = resolve(extracted.text, detections, {
      knownLanguages: this.deps.knownLanguages,
      ...(extracted.author ? { authorRecent: this.authorHistory.get(extracted.author) ?? [] } : {}),
    });

    if (resolution.lang === null) {
      // Nothing renders, but the layer stays mounted so the hover globe is
      // there. This is the false-negative case and the affordance is the
      // mitigation.
      return { kind: "idle" };
    }

    if (extracted.author && resolution.source === "detector") {
      const history = this.authorHistory.get(extracted.author) ?? [];
      this.authorHistory.set(extracted.author, [resolution.lang, ...history].slice(0, 10));
    }

    return this.translate(resolution.lang, extracted.text);
  }

  private async translate(source: LanguageCode, text: string): Promise<LayerState> {
    const target = this.deps.target;

    const decision = route(
      { text, source, target, initiation: "automatic" },
      this.deps.policy,
    );

    switch (decision.kind) {
      case "skip":
        return { kind: "idle" };

      case "needs-pack-download":
        // Terminal. Never falls through to cloud: a pending download must not
        // become a silent DeepL request for a pair that was about to be free.
        return { kind: "needs-download", source, target };

      case "unsupported":
        return { kind: "failed", reason: `no provider for ${source} → ${target}` };

      case "on-device":
      case "cloud-mt": {
        const { masked, spans } = mask(text);
        try {
          const raw =
            decision.kind === "on-device"
              ? await this.deps.translateOnDevice(source, target, masked)
              : await this.deps.translateCloud?.(decision.provider, source, target, masked);

          if (raw == null) return { kind: "needs-download", source, target };

          const { text: restored } = restore(raw, spans);
          return { kind: "translated", text: restored, source, target };
        } catch (error) {
          return { kind: "failed", reason: String(error) };
        }
      }
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

  /** Test/diagnostic accessor. */
  get mountedCount(): number {
    return this.mounted.size;
  }
}
