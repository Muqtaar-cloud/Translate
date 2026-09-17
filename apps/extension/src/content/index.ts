import type { Availability, Detection } from "@polyglot/core";
import { DiscordAdapter } from "./discord.js";
import { RenderLoop } from "./loop.js";
import { showBrokenBanner } from "./banner.js";
import { createDetector, PackManager, builtInAvailable } from "./translator.js";
import { autoFor, loadSettings } from "../shared/settings.js";
import type { ToBackground } from "../shared/messages.js";

const send = (message: ToBackground): void => {
  void chrome.runtime.sendMessage(message).catch(() => {
    // The worker may be asleep or the extension reloading. Counters are
    // best-effort by design; never let telemetry break translation.
  });
};

async function main(): Promise<void> {
  const adapter = new DiscordAdapter();
  if (!adapter.matches(new URL(location.href))) return;

  const settings = await loadSettings();
  const packs = new PackManager();

  // Discord renders the message list asynchronously; wait for it rather than
  // deciding the adapter is broken because we arrived early.
  const root = await waitForRoot(adapter);

  const health = adapter.selfCheck(document);
  send({ type: "report-adapter-health", adapter: adapter.name, ok: health.ok, detail: health.detail });

  if (!root || !health.ok) {
    // A counter alone would leave the user with an extension that silently
    // does nothing after a Discord redesign. They have to be told.
    showBrokenBanner(document, health.detail);
    return;
  }

  const conversationId = adapter.extract(adapter.findMessages(root)[0] ?? document.createElement("li"))
    ?.conversationId;
  if (conversationId && !autoFor(settings, conversationId)) return;

  const builtInDetect = await createDetector();
  const detect: (text: string) => Promise<Detection[]> = builtInDetect
    ? (text) => builtInDetect(text)
    : async () => [];

  const loop = new RenderLoop({
    adapter,
    doc: document,
    target: settings.target,
    knownLanguages: settings.knownLanguages,
    detect,
    policy: {
      knownLanguages: settings.knownLanguages,
      cloudEnabled: settings.cloudEnabled,
      ...(settings.cloudProvider ? { cloudProvider: settings.cloudProvider } : {}),
      availability: (source, target) => availabilityFor(packs, source, target),
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
    onNeedsDownload: (source, target) => {
      // Reached from a real click in the layer, which is what the platform
      // requires: create() will not download a pack outside a user gesture.
      void packs.enable(source, target).then(() => void loop.sync());
    },
  });

  // Warm the availability cache for the pairs we are likely to need, and report
  // the distribution. Read-only — this never starts a download.
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

  loop.start();
}

/** Discord mounts the list after first paint; poll briefly rather than guess. */
async function waitForRoot(
  adapter: DiscordAdapter,
  timeoutMs = 10_000,
): Promise<Element | null> {
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
 * Unknown pairs report "unavailable" for this pass and kick off a refresh; the
 * next sync sees the real state. Reporting "unavailable" while we genuinely do
 * not know is the safe direction only because cloud is off by default — with
 * cloud on it would mean a cloud call for a pair that may be free and local, so
 * the refresh has to be prompt.
 */
function availabilityFor(packs: PackManager, source: string, target: string): Availability {
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
      return "downloadable"; // prompt rather than silently reach for cloud
  }
}

void main();
