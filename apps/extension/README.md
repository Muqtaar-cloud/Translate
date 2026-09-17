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
| `src/content/loop.ts` | MutationObserver → extract → route → inject. Owns the edit/delete lifecycle. |
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

## Not built yet

Viewport gating and batching are Phase 2; `LoopDeps.shouldTranslate` is the seam
where the IntersectionObserver goes, wired now so adding it is a parameter
rather than a rewrite. IndexedDB caching, per-channel settings and the LLM
escalation button are also Phase 2. Cloud translation works but is off by
default and only DeepL is implemented.
