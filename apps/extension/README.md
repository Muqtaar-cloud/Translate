# Polyglot extension (Phase 1)

MV3, Discord web, Chrome/Edge desktop.

```bash
npm run build:ext   # -> apps/extension/dist
npm run smoke       # loads dist into real Chromium against a fake Discord page
```

Then `chrome://extensions` → Developer mode → Load unpacked → `apps/extension/dist`.

## Shape

| File | Does |
|---|---|
| `src/content/discord.ts` | The only platform-specific code. Selectors, extraction, injection point, self-check. |
| `src/content/loop.ts` | MutationObserver → extract → gate → cache → batch → inject. Owns the edit/delete lifecycle. |
| `src/content/gate.ts` | Viewport gating. The cost defence. |
| `src/content/batch.ts` | Coalescing, debounce and the concurrency ceiling. |
| `src/content/cache.ts` | Memory LRU in front of the worker's IndexedDB. |
| `src/background/idb.ts` | The durable cache: 30-day TTL, 50MB LRU. |
| `src/content/layer.ts` | The Shadow-DOM node that renders under the message. |
| `src/content/translator.ts` | Built-in Translator/LanguageDetector, and the per-pair pack lifecycle. |
| `src/content/banner.ts` | "Polyglot can't read this page" — breakage the user can see. |
| `src/background/` | Settings, cloud calls, counters. **No on-device translation** (worker context). |

## Three things that are not arbitrary

**Selectors are `id` prefixes and `data-*` attributes only.** Discord's class
names are build-time hashes. Selecting on them is how an adapter breaks weekly
instead of yearly. They all live in one table at the top of `discord.ts`.

**The node key is `(messageId, hash(text))`.** Message id alone leaves a stale
translation under an edited message; a content hash alone orphans the layer on
edit and silently re-translates. Both together fix both, and make a virtualized
remount of unchanged text free by construction.

**`downloadable` never falls through to cloud.** Chrome reports four
availability states. Collapsing them to a boolean means a user who enabled cloud
but hasn't clicked through a pack download silently ships their messages to
DeepL — for a pair that was about to be free and local. It is its own terminal
route, and there is a test that keeps it that way.

**Gating comes before everything that costs anything.** No cache lookup, no
layer, no translation until a message is near the viewport. Measured on a
66-message channel in real Chromium: 10 translated on load, 18 after scrolling
to the bottom, 48 never touched.

**The durable cache lives in the worker, not the content script.** A content
script's IndexedDB belongs to *discord.com's* origin — Discord can clear it and
no other tab can share it. The worker runs on the extension origin.

**Batching does not reduce calls on the automatic path.** The built-in
Translator has no batch endpoint. Batching buys dedupe within the window and a
concurrency ceiling; request bundling only applies to cloud. See `batch.ts`.

## Not built yet

Per-channel settings UI and the LLM escalation button. Cloud translation works
but is off by default and only DeepL is implemented.
