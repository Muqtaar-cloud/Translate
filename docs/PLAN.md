# Polyglot — a build plan for in-place chat translation

**Problem.** Group chats on Discord, Telegram, WhatsApp and Slack routinely mix
three or four languages in the same channel. Copy-pasting each message into a
translator destroys the flow of the conversation, loses thread context, and is
hopeless in a fast-moving channel. I want to read every message in my language
without leaving the chat, and reply in mine while others read theirs.

This document is the plan: what to build, in what order, and what will bite.

---

## 1. Scope decision: why a browser extension (and where it stops)

A Manifest V3 browser extension is the right primary surface, with clear eyes
about its limits.

| Surface | Reachable by extension? | Notes |
|---|---|---|
| Discord web (`discord.com/app`) | Yes | React app, virtualized message list |
| Telegram Web A/K (`web.telegram.org`) | Yes | Two separate web clients, different DOM |
| WhatsApp Web (`web.whatsapp.com`) | Yes | Aggressively obfuscated class names |
| Slack web | Yes | Stable-ish `data-qa` attributes |
| Discord/Telegram **desktop apps** | No | Electron/native — out of reach |
| Any **mobile** app | No | Needs a different product entirely |

**Consequence to accept up front:** an extension covers desktop-browser usage
only. That is where most of my heavy group-chat reading happens, so it is the
right first bet — but "translate my chats everywhere" is not what v1 delivers,
and the roadmap (§8) says how the rest gets covered.

**Non-goals for v1:** voice/video translation, image OCR translation, mobile,
translating my own outgoing messages automatically without review.

---

## 2. Product shape

Three features, in priority order.

### 2.1 Inbound translation (the core)
Every message not in a language I read gets a translation rendered **underneath**
the original, in a visually distinct style — dimmer, slight indent, small
language badge (`ES → EN`). The original is never replaced or hidden. This
matters: mistranslation is inevitable, and keeping the source visible lets me
catch it and lets bilingual readers ignore the layer entirely.

Modes:
- **Auto** — translate everything not in my known-languages list.
- **On demand** — a small globe button on hover, per message.
- **Per-channel** — auto in `#general-es`, off in `#memes`. Settings are
  keyed by (platform, server/chat, channel), not global.

### 2.2 Outbound translation (compose)
I type in English, press a hotkey, get the translation into the channel's
dominant language in the composer for review before sending. Never auto-send.
Show a **back-translation** ("this says: …") so I can sanity-check what I'm
about to post in a language I can't read.

Optionally append the original: `¿Vienes mañana?\n\n> (EN) Are you coming tomorrow?`

### 2.3 Context handling (the differentiator)
Generic MT fails on chat specifically. The wins:
- **Thread context** — feed the previous 3–5 messages as context so pronouns
  and short replies ("sí, ese") resolve correctly.
- **Slang/idiom mode** — route short, informal, emoji-dense messages to an LLM
  with a "this is casual group-chat, preserve register and humour" prompt
  rather than a literal MT engine.
- **Do-not-translate spans** — usernames, @mentions, `#channels`, `:emoji:`,
  code blocks, inline code, URLs, custom emoji. Mask these before translation
  and restore after. Getting this wrong makes output look broken instantly.

---

## 3. Architecture

```
┌─ Content script (per platform) ──────────────────────────┐
│  Adapter: findMessages() · extractText() · injectNode()  │
│  MutationObserver → queue → IntersectionObserver gate    │
└───────────────┬──────────────────────────────────────────┘
                │ chrome.runtime port (batched)
┌───────────────▼─── Service worker (MV3) ─────────────────┐
│  Language detect → cache lookup → batch → provider       │
│  Rate limit · retry/backoff · quota accounting           │
└───────────────┬──────────────────────────────────────────┘
        ┌───────┴────────┬──────────────┬─────────────┐
   On-device MT      DeepL/Google      LLM (slang)   IndexedDB
   (Chrome API)      (cloud MT)        (Claude/GPT)   cache
```

### 3.1 Platform adapters
The only platform-specific code. Each adapter implements one interface:

```ts
interface PlatformAdapter {
  matches(url: URL): boolean;
  observeRoot(): Element;                    // scroll container
  findMessages(root: Element): MessageEl[];
  extract(el: MessageEl): {
    id: string;          // stable per-message id
    text: string;        // with DNT spans already masked
    author: string;
    conversationId: string;
  };
  inject(el: MessageEl, node: HTMLElement): void;  // where the layer goes
}
```

Everything else — detection, caching, batching, providers, UI — is shared.
Adding a platform is then a few hundred lines, not a fork.

**Message identity** is the subtle part. Discord exposes `id="chat-messages-<id>"`;
Telegram uses `data-mid`; WhatsApp uses `data-id`. Where no stable id exists,
fall back to `hash(author + text + timestamp)`. Identity drives the cache and
prevents re-translating on every re-render.

### 3.2 The render loop
1. `MutationObserver` on the scroll container catches new/changed messages.
2. New messages go into a queue, **not** translated immediately.
3. `IntersectionObserver` releases queue entries only when a message is at or
   near the viewport. Scrolling through 500 messages of backlog must not fire
   500 API calls.
4. Debounce ~150ms, then batch up to ~20 segments into one provider request.
5. Inject result; mark the node with `data-polyglot-done` so virtualized
   re-mounts re-inject from cache without a network call.

Virtualized lists (Discord, Slack) unmount off-screen messages and remount them
on scroll-back. Cache-on-id makes remount free. This is the single biggest
performance lever.

### 3.3 Language detection
Detecting the language is a prerequisite for "translate only what I can't read",
and chat messages are short and awkward.

- Primary: Chrome's built-in `LanguageDetector` API (on-device, free).
- Fallback: bundled CLD3/`franc` WASM.
- **Below ~15 characters, trust nothing.** "ok", "lol", "😂", "+1" — short
  messages get skipped unless the channel has a known dominant language, in
  which case inherit it.
- Sticky per-author hint: if someone's last 10 messages were Spanish, weight
  Spanish. Cheap, and fixes most short-message misfires.
- If detected language ∈ my known languages → skip entirely. Never pay to
  translate English into English.

### 3.4 Translation providers
Pluggable, with a routing policy rather than one engine.

| Provider | Use for | Cost | Privacy |
|---|---|---|---|
| Chrome built-in Translator API | Default, common pairs | Free | On-device |
| DeepL | Quality tier, European langs | ~$25/M chars | Cloud |
| Google Cloud Translation v3 | Breadth of languages | ~$20/M chars | Cloud |
| LLM (Claude/GPT) | Slang, idiom, context-heavy | ~$3–15/M tok | Cloud |

Routing policy:
```
if pair supported on-device and message is plain  → on-device
elif message is short/slangy/emoji-dense          → LLM with thread context
elif quality tier enabled and pair supported      → DeepL
else                                              → Google
```
On-device first means the common case is free, private, and offline-capable.
Cloud is the escape hatch, not the default.

**BYO keys.** Users paste their own API keys in v1. No backend, no key custody,
no per-user cost exposure. A hosted tier can come later (§8).

### 3.5 Caching
- **IndexedDB**, keyed `sha256(text + sourceLang + targetLang + provider)`.
- LRU, ~50MB cap, 30-day TTL.
- In-memory hot layer for the current conversation.
- Expect a high hit rate in practice: group chats repeat themselves constantly
  ("gm", "thanks", stock phrases, quoted replies), and scroll-back re-reads the
  same messages many times. The cache is what makes the cost model work.

---

## 4. The hard parts (and the answers)

**DOM fragility.** These are unversioned, obfuscated, frequently-shipped web
apps. WhatsApp Web class names are generated hashes.
→ Never select on styling classes. Prefer `data-*`, ARIA roles, structural
relationships. Keep selectors in one small per-adapter table. Ship a
self-check that runs on load and reports "adapter broken on platform X" to a
counter, so I find out from telemetry rather than from a user. Budget for
recurring maintenance — this is the ongoing tax of the whole product.

**Terms of service.** Reading the DOM and adding an overlay in *my own browser*
is ordinary extension behaviour and broadly accepted. What is not: automating
the account, injecting into the native desktop client, or anything resembling a
self-bot — Discord bans self-bots outright, and API-key-driven automation of a
user account violates Telegram's and WhatsApp's terms too. This plan stays on
the safe side: render-only, user-initiated, no message sending without an
explicit click. Sanctioned server-side alternatives exist and are the right
answer for whole-community translation (§8).

**Privacy.** Message content leaving the device is the central risk, and group
chats contain other people's words, not just mine.
→ On-device by default; cloud strictly opt-in, per-platform, with a one-time
explicit consent screen naming the provider. Never send: DMs (unless separately
enabled), messages in channels marked private, or anything from a platform the
user hasn't opted in for. No message content in logs or telemetry — ever. A
visible indicator when a cloud provider is in use. Ship a plain-language privacy
policy; Chrome Web Store review will ask, and the answer should be easy.

**Rate limits & cost runaway.** A busy Discord server can produce hundreds of
messages a minute.
→ Viewport gating (§3.2) is the main defence. Plus: hard daily character cap
with a user-visible meter, per-provider token bucket, exponential backoff on
429, and a circuit breaker that falls back to on-device or pauses with a clear
notice rather than silently burning the user's API budget.

**Performance.** The extension must not make the chat feel slow.
→ Targets: <16ms of main-thread work per injection, translation visible within
500ms p50 / 2s p95, no layout shift (reserve height before inserting), zero
observer work on background tabs.

---

## 5. Tech stack

- **TypeScript**, strict.
- **WXT** (or Plasmo) for the MV3 build — handles cross-browser manifests,
  HMR for content scripts, and the Chrome/Firefox packaging split.
- **Preact** for injected UI — small enough to inject without weighing down the
  host page; Shadow DOM for every injected node so host CSS can't touch it and
  our CSS can't break the chat.
- **Vitest** for units, **Playwright** for DOM-fixture integration tests.
- **Zod** for settings and provider-response validation.
- `chrome.storage.sync` for settings, IndexedDB for cache, `chrome.storage.session`
  for API keys (memory-only; never `sync` — keys must not leave the device).

---

## 6. Build phases

Each phase ends with something usable.

### Phase 0 — Spike (2–3 days)
Prove the risky assumption before building around it: can I reliably find,
identify and annotate messages in Discord web and Telegram web, across
virtualization and re-render? Throwaway code, one hardcoded language pair.
**Exit:** translated lines stay attached and correct through 5 minutes of
scrolling. If this is ugly, the whole plan changes shape.

### Phase 1 — Walking skeleton (1 week)
Extension scaffold; Discord adapter; on-device translation; IndexedDB cache;
options page; one target language.
**Exit:** I can read a Spanish Discord channel in English, locally, for free.

### Phase 2 — Make it good (1–2 weeks)
Language detection with short-message rules; DNT masking (mentions, emoji, code,
URLs); viewport gating and batching; per-channel settings; hover-to-translate;
error and "translation failed" states.
**Exit:** usable all day on a busy server without annoyance.

### Phase 3 — Breadth (1–2 weeks)
Telegram Web (both A and K); WhatsApp Web; cloud providers behind BYO keys with
the consent flow; quota meter.
**Exit:** covers my actual daily chat surface.

### Phase 4 — Outbound + context (1–2 weeks)
Composer translation with back-translation review; thread-context prompting;
LLM slang mode; glossary of never-translate terms (project names, in-jokes,
handles).
**Exit:** I can participate, not just read.

### Phase 5 — Ship (1 week)
Chrome Web Store + Firefox AMO submission; privacy policy; onboarding; adapter
self-check telemetry (counters only, no content); crash reporting; landing page.

**Realistic total: 6–9 weeks** for one person working steadily. Phases 2 and 3
are the ones that slip — DOM adapters always take longer than they look.

---

## 7. Testing

- **Adapter fixture tests** — saved HTML snapshots of real message lists per
  platform, replayed in Playwright. Catches DOM breakage without a live account.
- **Canary run** — a weekly scheduled job loads each platform and runs the
  adapter self-check; a failure opens an issue. This is how I learn about a
  Discord redesign before users complain.
- **Translation quality** — a golden set of ~200 real multilingual chat messages
  (slang, emoji, mixed-script, code-switching within one sentence) with expected
  behaviour. Not BLEU — human spot-check on a rubric: meaning preserved,
  register preserved, DNT spans intact.
- **Performance budget** in CI — fail the build if injection cost regresses.

---

## 8. Beyond the extension

The extension can't reach mobile or desktop apps. The honest answers:

- **Telegram** has a first-class Bot API. A bot added to a group can post
  translations as replies, sanctioned, reaching every member on every device.
  This is strictly better than the extension *for Telegram groups* and is
  probably the highest-value follow-up.
- **Discord** likewise: a proper bot app with per-user language preferences,
  posting translations ephemerally or in a thread. Fully within ToS, unlike
  client modification.
- **Slack** has an Apps/Events API with the same shape.
- **Mobile browsers** — Safari iOS and Firefox Android support extensions; a
  reduced build is feasible. Native mobile apps are not addressable and should
  be served by the bot route instead.

Sequence: extension proves the product and the translation quality; bots take it
to where the extension can't go. The provider/routing/cache layer (§3.4, §3.5) is
shared between both, so build it as a standalone package from the start.

---

## 9. Success criteria

I'd call this working if:
- I read a mixed-language channel for an hour without opening a translator tab.
- Translation appears before I finish reading the message above it.
- I never notice it on English messages (no flicker, no cost, no layer).
- An adapter break is detected by the canary, not by me mid-conversation.
- Running it all day on on-device translation costs nothing.

---

## 10. First actions

1. Phase 0 spike on Discord web — one afternoon, answers the riskiest question.
2. Same spike on Telegram Web K.
3. Check Chrome built-in Translator API availability and language-pair coverage
   on the target browser version; it determines how often the free path applies.
4. Collect the golden-set messages from real group chats now, while the
   annoyance is fresh — they're the quality benchmark for everything after.
