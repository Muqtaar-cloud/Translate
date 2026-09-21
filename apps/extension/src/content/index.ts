import type { Availability, Detection } from "@polyglot/core";
import { conversationIdFrom, DiscordAdapter } from "./discord.js";
import { defaultGate } from "./gate.js";
import { MessagingCache } from "./cache.js";
import { RenderLoop } from "./loop.js";
import { showBrokenBanner } from "./banner.js";
import { createDetector, PackManager, builtInAvailable } from "./translator.js";
import { autoFor, loadSettings, watchSettings, type Settings } from "../shared/settings.js";
import type { ToBackground } from "../shared/messages.js";

const send = (message: ToBackground): void => {
  void chrome.runtime.sendMessage(message).catch(() => {
    // The worker may be asleep or the extension reloading. Counters are
    // best-effort by design; never let telemetry break translation.
  });
};

const adapter = new DiscordAdapter();
const packs = new PackManager();
const cache = new MessagingCache();

let loop: RenderLoop | null = null;
let detect: (text: string) => Promise<Detection[]> = async () => [];
let settings: Settings | null = null;
let currentConversation: string | null = null;

/**
 * Starts or stops translation for the conversation now on screen.
 *
 * Called on load, whenever settings change, and whenever Discord switches
 * channel. All three have to go through one place: a per-channel setting that
 * only took effect on reload would be the same as not working, and Discord is a
 * single-page app that changes channel without one.
 */
async function reconcile(): Promise<void> {
  if (!settings) return;

  const url = new URL(location.href);
  if (!adapter.matches(url)) {
    stop();
    return;
  }

  const conversationId = conversationIdFrom(url);

  if (!autoFor(settings, conversationId)) {
    stop();
    currentConversation = conversationId;
    return;
  }

  // Already running on this exact conversation.
  if (loop && currentConversation === conversationId) return;

  stop();
  currentConversation = conversationId;

  const root = await waitForRoot();
  const health = adapter.selfCheck(document);
  send({
    type: "report-adapter-health",
    adapter: adapter.name,
    ok: health.ok,
    detail: health.detail,
  });

  if (!root || !health.ok) {
    // A counter alone would leave the user with an extension that silently does
    // nothing after a Discord redesign. They have to be told.
    showBrokenBanner(document, health.detail);
    return;
  }

  loop = new RenderLoop({
    adapter,
    doc: document,
    target: settings.target,
    knownLanguages: settings.knownLanguages,
    detect,
    policy: {
      knownLanguages: settings.knownLanguages,
      cloudEnabled: settings.cloudEnabled,
      ...(settings.cloudProvider ? { cloudProvider: settings.cloudProvider } : {}),
      availability: (source, target) => availabilityFor(source, target),
    },
    translateOnDevice: (source, target, text) => packs.translate(source, target, text),
    translateCloud: async (provider, source, target, text) => {
      const reply = await chrome.runtime.sendMessage({
        type: "cloud-translate",
        provider,
        source,
        target,
        text,
      });
      if (reply?.type === "translation") return reply.text as string;
      throw new Error(reply?.message ?? "cloud translation failed");
    },
    translateLlm: async (request) => {
      const reply = await chrome.runtime.sendMessage({ type: "llm-translate", request });
      if (reply?.type === "translation") return reply.text as string;
      throw new Error(reply?.message ?? "LLM translation failed");
    },
    // The cost defence: nothing is translated until it is near the viewport.
    gate: defaultGate(),
    // Memory LRU here, IndexedDB in the worker.
    cache,
    onNeedsDownload: (source, target) => {
      // Reached from a real click in the layer, which is what the platform
      // requires: create() will not download a pack outside a user gesture.
      void packs.enable(source, target).then(() => void loop?.sync());
    },
  });

  loop.start();
}

function stop(): void {
  loop?.stop();
  loop = null;
}

/**
 * Discord changes channel without a page load, so the content script has to
 * notice by itself. `navigation` is the precise signal where it exists; the
 * popstate and mutation fallbacks cover browsers that lack it.
 */
function watchNavigation(onChange: () => void): void {
  const nav = (globalThis as { navigation?: EventTarget }).navigation;
  if (nav) {
    nav.addEventListener("navigatesuccess", onChange);
    return;
  }

  let last = location.href;
  const check = (): void => {
    if (location.href === last) return;
    last = location.href;
    onChange();
  };
  globalThis.addEventListener("popstate", check);
  new MutationObserver(check).observe(document, { childList: true, subtree: true });
}

async function waitForRoot(timeoutMs = 10_000): Promise<Element | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const root = adapter.observeRoot(document);
    if (root) return root;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Synchronous availability for the router, backed by the pack manager's cache.
 *
 * Unknown pairs prompt for a download for this pass and kick off a refresh; the
 * next sync sees the real state. Prompting rather than reporting "unavailable"
 * is the safe direction: "unavailable" with cloud enabled would mean a cloud
 * call for a pair that may well be free and local.
 */
function availabilityFor(source: string, target: string): Availability {
  const state = packs.stateOf(source, target);
  switch (state.kind) {
    case "ready":
      return "available";
    case "needs-download":
      return "downloadable";
    case "downloading":
      return "downloading";
    case "unavailable":
    case "failed":
      return "unavailable";
    case "unknown":
      void packs.refresh(source, target);
      return "downloadable";
  }
}

async function main(): Promise<void> {
  if (!adapter.matches(new URL(location.href))) return;

  settings = await loadSettings();

  const builtInDetect = await createDetector();
  if (builtInDetect) detect = (text) => builtInDetect(text);

  packs.onChange((pair, state) => {
    const reported: Availability | null =
      state.kind === "ready"
        ? "available"
        : state.kind === "needs-download"
          ? "downloadable"
          : state.kind === "downloading"
            ? "downloading"
            : state.kind === "unavailable"
              ? "unavailable"
              : null;
    if (reported) send({ type: "report-availability", pair, state: reported });
  });

  if (!builtInAvailable()) {
    showBrokenBanner(
      document,
      "Chrome's built-in translator isn't available here. Polyglot needs Chrome 138+ or Edge 148+ on desktop.",
    );
  }

  watchSettings((next) => {
    settings = next;
    // Force a rebuild: the target language or cloud settings may have changed
    // too, not just this channel's toggle.
    currentConversation = null;
    void reconcile();
  });

  watchNavigation(() => void reconcile());

  await reconcile();
}

void main();
