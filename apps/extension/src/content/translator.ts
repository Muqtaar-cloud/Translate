import type { Availability } from "@polyglot/core";

/**
 * Chrome's built-in Translator and LanguageDetector.
 *
 * Runs in the content script, not the service worker: the built-in APIs are
 * unavailable in Web Worker contexts (Permissions Policy), and an MV3 service
 * worker is one. This is not a stylistic choice — putting it in the background
 * would simply not work.
 *
 * The other platform constraint shapes the whole UX: when a language pack is
 * not present, `create()` requires a user gesture. There is no silent warm-up
 * on page load, so the extension owes the user a visible, per-pair "enable
 * Spanish" affordance and a download state. That is what `PackManager` is.
 */

interface TranslatorInstance {
  translate(text: string): Promise<string>;
  destroy?(): void;
}

interface TranslatorGlobal {
  availability(o: { sourceLanguage: string; targetLanguage: string }): Promise<Availability>;
  create(o: {
    sourceLanguage: string;
    targetLanguage: string;
    monitor?: (m: EventTarget) => void;
  }): Promise<TranslatorInstance>;
}

interface DetectorGlobal {
  availability(): Promise<Availability>;
  create(): Promise<{ detect(text: string): Promise<{ detectedLanguage: string; confidence: number }[]> }>;
}

function translatorApi(): TranslatorGlobal | null {
  return (globalThis as { Translator?: TranslatorGlobal }).Translator ?? null;
}

function detectorApi(): DetectorGlobal | null {
  return (globalThis as { LanguageDetector?: DetectorGlobal }).LanguageDetector ?? null;
}

export function builtInAvailable(): boolean {
  return translatorApi() !== null;
}

export const pairKey = (source: string, target: string): string => `${source}->${target}`;

export type PackState =
  | { kind: "unknown" }
  | { kind: "unavailable" }
  | { kind: "needs-download" }
  | { kind: "downloading"; progress: number }
  | { kind: "ready" }
  | { kind: "failed"; error: string };

export type PackListener = (pair: string, state: PackState) => void;

/**
 * Per-pair language pack lifecycle.
 *
 * Deliberately refuses to call `create()` outside a user gesture. A download
 * triggered from an observer callback would be rejected by the browser, and
 * silently swallowing that produces a translator that never works and never
 * says why.
 */
export class PackManager {
  private states = new Map<string, PackState>();
  private translators = new Map<string, TranslatorInstance>();
  private inflight = new Map<string, Promise<void>>();
  private listeners = new Set<PackListener>();

  onChange(listener: PackListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(pair: string, state: PackState): void {
    this.states.set(pair, state);
    for (const l of this.listeners) l(pair, state);
  }

  stateOf(source: string, target: string): PackState {
    return this.states.get(pairKey(source, target)) ?? { kind: "unknown" };
  }

  /** Read-only. Safe to call from the render loop; never starts a download. */
  async refresh(source: string, target: string): Promise<PackState> {
    const pair = pairKey(source, target);
    const api = translatorApi();
    if (!api) {
      this.set(pair, { kind: "unavailable" });
      return { kind: "unavailable" };
    }

    try {
      const availability = await api.availability({
        sourceLanguage: source,
        targetLanguage: target,
      });
      const state: PackState =
        availability === "available"
          ? { kind: "ready" }
          : availability === "downloadable"
            ? { kind: "needs-download" }
            : availability === "downloading"
              ? { kind: "downloading", progress: 0 }
              : { kind: "unavailable" };
      this.set(pair, state);
      return state;
    } catch (error) {
      const state: PackState = { kind: "failed", error: String(error) };
      this.set(pair, state);
      return state;
    }
  }

  /**
   * Downloads the pack and builds a translator.
   *
   * MUST be called from a user gesture (a click handler). The caller is
   * responsible for that; the browser enforces it.
   */
  async enable(source: string, target: string): Promise<void> {
    const pair = pairKey(source, target);
    const existing = this.inflight.get(pair);
    if (existing) return existing;

    const api = translatorApi();
    if (!api) {
      this.set(pair, { kind: "unavailable" });
      return;
    }

    const task = (async (): Promise<void> => {
      this.set(pair, { kind: "downloading", progress: 0 });
      try {
        const instance = await api.create({
          sourceLanguage: source,
          targetLanguage: target,
          monitor: (m) => {
            m.addEventListener("downloadprogress", (event) => {
              const e = event as Event & { loaded?: number; total?: number };
              const total = e.total ?? 0;
              const progress = total > 0 ? (e.loaded ?? 0) / total : 0;
              this.set(pair, { kind: "downloading", progress });
            });
          },
        });
        this.translators.set(pair, instance);
        this.set(pair, { kind: "ready" });
      } catch (error) {
        this.set(pair, { kind: "failed", error: String(error) });
      } finally {
        this.inflight.delete(pair);
      }
    })();

    this.inflight.set(pair, task);
    return task;
  }

  /**
   * Translates, or returns null when the pack is not ready.
   *
   * Returning null rather than falling back to a cloud provider is the point:
   * a pending download must never become a silent cloud request for a pair that
   * was about to be free and local. Routing decides that, and it routes
   * `downloadable` to a prompt, not to DeepL.
   */
  async translate(source: string, target: string, text: string): Promise<string | null> {
    const pair = pairKey(source, target);
    let instance = this.translators.get(pair);

    if (!instance) {
      const api = translatorApi();
      if (!api) return null;
      // Only build one without a gesture if the pack is already present.
      const availability = await api.availability({
        sourceLanguage: source,
        targetLanguage: target,
      });
      if (availability !== "available") return null;
      instance = await api.create({ sourceLanguage: source, targetLanguage: target });
      this.translators.set(pair, instance);
      this.set(pair, { kind: "ready" });
    }

    return instance.translate(text);
  }

  dispose(): void {
    for (const t of this.translators.values()) t.destroy?.();
    this.translators.clear();
    this.states.clear();
    this.listeners.clear();
  }
}

/** Built-in language detection, shaped to core's injected `Detector`. */
export async function createDetector(): Promise<
  ((text: string) => Promise<{ lang: string; confidence: number }[]>) | null
> {
  const api = detectorApi();
  if (!api) return null;
  try {
    if ((await api.availability()) !== "available") return null;
    const detector = await api.create();
    return async (text: string) => {
      const results = await detector.detect(text);
      return results.map((r) => ({ lang: r.detectedLanguage, confidence: r.confidence }));
    };
  } catch {
    return null;
  }
}
