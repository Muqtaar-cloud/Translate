# Polyglot — a build plan for in-place chat translation

**Problem.** Group chats on Discord, Telegram and elsewhere routinely mix three
or four languages in one channel. Copy-pasting each message into a translator
destroys the flow, loses thread context, and is hopeless in a fast channel. I
want to read every message in my language without leaving the chat.

**Revision note (v2).** This plan was substantially rewritten after review. The
first version validated the wrong risk, contained a routing policy that
contradicted its own cost story, had a cache key incompatible with its context
feature, and scoped four platform adapters it could not maintain. §12 records
what changed and why.

---

## 1. What is actually uncertain

Three risks, in the order they can kill the product:

1. **Quality.** Are machine translations of casual group chat good enough that
   reading them beats not reading them? If the Spanish comes back as mush, a
   flawless mechanism is a failed product.
2. **Economics.** Is there a free-or-cheap path for the common case? If every
   message costs an LLM call, this is a cloud product with a cloud product's
   cost and privacy problem, not a local utility.
3. **Mechanism.** Can injected nodes stay attached and correct through a
   virtualized, frequently-redesigned chat UI?

Risk 3 is the most solved of the three — Discord exposes stable message ids,
and there is a decade of prior art in userscripts and client mods. It is a day
of work to confirm, not three. Risks 1 and 2 are the ones with no prior answer
for *this* use case, so they are validated first (§6).

---

## 2. Scope

**v1 is Discord web only.** One adapter, the platform with the best selectors
and the one I use daily.

This is a deliberate cut from the four adapters in v1 of this plan. Each adapter
carries a permanent maintenance cost against an unversioned, obfuscated,
frequently-shipped web app, and that cost is paid forever from the moment it
ships. Four adapters was the single biggest scope error in the previous draft.

Telegram is served by a **bot** (§8), not an adapter — a bot is sanctioned by
the Bot API, reaches every member on every device including mobile, carries no
DOM maintenance tax, and has a better consent story (§5). Building two Telegram
Web adapters for a platform better served another way was incoherent.

| Surface | v1 | Notes |
|---|---|---|
| Discord web | **Yes** | Stable `id="chat-messages-<id>"` |
| Telegram | Phase 3, **as a bot** | Not an adapter |
| WhatsApp Web | No | Obfuscated DOM, highest ToS risk of any target |
| Slack | No | Revisit only if the maintenance model proves out |
| Discord/Telegram desktop apps | Never | Electron/native, out of reach |
| Any mobile app | Never (via extension) | The bot route covers this |

**Browser scope: Chrome/Edge desktop only in v1.** See §4.1 — the free
translation path does not exist on Firefox, which makes Firefox a different
product with a different funnel, not a build-target checkbox.

**Non-goals:** voice/video, image OCR, auto-sending my messages without review.

---

## 3. Product shape

### 3.1 Inbound translation (the core)
Translations render **underneath** the original, dimmer and slightly indented,
with a language badge (`ES → EN`). The original is never replaced or hidden:
mistranslation is inevitable, and keeping the source visible lets me catch it
and lets bilingual readers ignore the layer.

Modes: auto (everything not in my known-languages list), on-demand (hover
button), and per-channel settings keyed by (platform, guild, channel).

### 3.2 Outbound translation
I type in English, press a hotkey, get a translation in the composer **for
review before sending** — never auto-send. A back-translation ("this says: …")
lets me sanity-check text I can't read.

### 3.3 Context handling
Generic MT fails on chat specifically. The intended wins:
- **Thread context** — the previous 3–5 messages, so short replies resolve.
- **Slang mode** — an LLM with a "casual group chat, preserve register" prompt.
- **Do-not-translate spans** — @mentions, `#channels`, `:emoji:`, code blocks,
  URLs, custom emoji. Masked before translation, restored after.

**This section is a hypothesis, not a commitment.** Phase 0b (§6) tests whether
thread context measurably improves output. If it doesn't, §3.3 shrinks to DNT
masking, and the cache (§4.4) and privacy story (§5) both get simpler. The
previous draft called context handling "the differentiator" without evidence.

---

## 4. Architecture

```
┌─ Content script (Discord adapter) ───────────────────────┐
│  MutationObserver → queue → IntersectionObserver gate    │
│  **Translator + LanguageDetector run HERE** (see 4.2)    │
│  Shadow-DOM Preact layer, dir/lang set per node          │
└───────────────┬──────────────────────────────────────────┘
                │ port (only for cloud paths + settings)
┌───────────────▼─── Service worker (MV3) ─────────────────┐
│  Cloud providers · token bucket · backoff · quota        │
│  IndexedDB cache (shared, two-tier keys)                 │
└──────────┬──────────────────┬────────────────────────────┘
      DeepL/Google        LLM (manual escalation only)
```

### 4.1 The on-device path — verified, and load-bearing

Everything free in this plan flows through Chrome's built-in `Translator` and
`LanguageDetector` APIs, so this was checked **first**. Findings as of
**2026-09-17** — re-verify before relying on them, these move:

- **Chrome 138+ (Jun 2025) and Edge 148+ (May 2026). Desktop only.** No mobile.
  **Firefox and Safari: unsupported, with no equivalent web API.**
- **Stated requirements: ~22 GB free disk on the profile volume, 16 GB+ RAM,
  4+ CPU cores**, Windows 10/11 / macOS 13+ / Linux / ChromeOS. (These are the
  shared built-in-AI requirements; whether Translator alone is gated this hard
  in practice is worth measuring on a low-spec machine in Phase 0a, but the
  documented gate is what determines the support matrix.) A meaningful share of
  users will not meet 22 GB free.
- `availability()` returns `available` / `downloadable` / `downloading` /
  `unavailable`, per language pair.
- **`create()` requires a user gesture when the pack isn't downloaded.** You
  cannot silently warm the translator on page load. This needs real UX: a
  first-run "enable translation for Spanish" button, per pair, and a visible
  download state. The previous draft had no UX for this at all.
- **Language pairs are `en ↔ N`: non-English pairs pivot through English.**
  So ES→PT costs quality twice, on exactly the pairs a multilingual channel
  produces. `chrome://on-device-translation-internals/` lists live pair status.
- Cross-origin iframes require `allow="translator"`.

**Consequence for Firefox:** there is no default provider. Every Firefox user
would have to paste a DeepL key on install or the extension does nothing. Plus
Firefox MV3 is event-page-shaped, not service-worker-shaped, needing a second
background form. Firefox is therefore out of v1 — not a checkbox, a separate
product decision.

### 4.2 Where translation runs — corrected

The built-in APIs are **not available in Web Workers** (Permissions Policy).
The previous draft's diagram put translation in the MV3 service worker, which
is a worker context. Translation and detection therefore run **in the content
script**; the service worker handles only cloud calls, quota and cache.

Phase 0a must confirm the exact behaviour in an extension service worker and in
an offscreen document, since that determines whether an offscreen document is
needed as a fallback host. Design defensively: content script first.

### 4.3 Provider routing — the LLM is an escape hatch, not the default

The previous draft claimed "on-device first, cloud is the escape hatch" while
routing short/slangy/emoji-dense messages to an LLM — and §3.3's whole premise
is that chat *is* short, slangy and emoji-dense. The modal message routed to the
LLM. The escape hatch was the default, which broke the cost claim, the latency
budget, and the cache. Resolved, explicitly:

```
detect → if known language                     → skip, no cost
       → elif pair available on-device         → on-device
       → elif quality tier enabled (BYO key)   → DeepL / Google
       → else                                  → show "no provider for es→pt"
```

**The LLM is never on the automatic path.** It is a per-message user action —
a "translate properly" button on the layer, used when the cheap path produced
something I can tell is mangled. That keeps the automatic path free, private,
fast and cacheable, and confines LLM cost, latency and context-export to
messages I explicitly chose.

If Phase 0b shows the cheap path is *usually* mush, that's a product-level
finding: it means this is a cloud product, and §4.3, §5 and §9 get rewritten
together to say so honestly. It does not mean quietly defaulting to the LLM.

### 4.4 Caching — fixed key, honest role

The previous key was `sha256(text + sourceLang + targetLang + provider)`, which
is incompatible with §3.3's thread context: the same text under different
context has a different correct translation, so the cache would serve "yes, that
one" into a thread needing "yeah, him." Two tiers:

- **Context-free translations** (the automatic path): keyed as above. Reusable
  across conversations.
- **Context-assisted translations** (LLM escalations): keyed with
  `+ sha256(contextWindow)`. Effectively unique, so it hits only on genuine
  repeats. That's fine — these are user-initiated and rare.

They are never interchangeable, and the tier is part of the key, not a flag.

**The cache is a latency win, not the cost defence.** The previous draft's
examples — "gm", "thanks", stock phrases — are exactly the sub-15-character
messages §4.5 says to skip, and scroll-back re-reads are already free via
id-keyed re-injection. **Viewport gating (§4.6) is the cost defence.** IndexedDB,
LRU, ~50MB, 30-day TTL.

### 4.5 Language detection
Built-in `LanguageDetector`, with bundled CLD3/`franc` WASM as fallback.

- **Below ~15 characters, trust nothing** — "ok", "lol", "😂" get skipped
  unless the channel has a known dominant language to inherit.
- Sticky per-author hint: weight by that author's recent messages.
- **Code-switching within one message** ("vamos to the store mañana") is in the
  §10 golden set, so the design must be able to express it: detection returns a
  *ranked list with confidence*, and where the top two are close and the message
  is long enough, segment by sentence and detect per segment. The previous draft
  returned one language per message and would have tested for something the
  design couldn't represent. If Phase 0b shows segmentation isn't worth it,
  drop the golden-set cases too — don't leave the mismatch.

### 4.6 The render loop
MutationObserver → queue → **IntersectionObserver releases only near-viewport
messages** → debounce ~150ms → batch → inject → mark `data-polyglot-done`.

Scrolling past 500 backlog messages must not fire 500 translations. This is the
main cost and performance lever.

**Message lifecycle — previously missing entirely:**
- **Edits.** Discord edits constantly. The node must be keyed on
  `(messageId, hash(currentText))`, not `messageId` alone, so an edit
  invalidates the layer and re-translates. Note the previous design failed
  *differently* per id strategy — stable ids showed a stale translation, the
  `hash(author+text+timestamp)` fallback silently orphaned and re-translated.
  One rule for both.
- **Deletions.** Observer must remove the orphaned layer.
- **Quoted replies, embeds, link previews, poll options, thread titles.** The
  adapter's `extract()` returns the message body only; quoted content is masked
  as DNT and inherits the quoted message's own layer if it has one. Embeds are
  out of scope for v1 and explicitly not translated — decided here rather than
  discovered in Phase 1.

### 4.7 Rendering correctness — previously missing
- **RTL.** Arabic, Hebrew and Persian are among the likeliest sources. Every
  injected node sets `dir="auto"` and wraps in bidi isolation (`unicode-bidi:
  isolate`), or mixed text renders scrambled inside Discord's LTR layout. Cheap
  in Phase 1, expensive to retrofit.
- **`lang` attribute** set on every injected node — drives font selection, TTS
  and screen-reader pronunciation.
- **Accessibility.** Screen readers will otherwise read every message twice.
  The layer gets an `aria-label` naming it a translation, and an option to mark
  the *original* `aria-hidden` when auto-translation is on.

---

## 5. Privacy — naming the right party

The sharp version, which the previous draft raised and then answered at the
wrong person: **group chats contain other people's words.** Every remedy in that
draft — consent screen, per-platform opt-in, an indicator — governs *my*
consent. The third parties whose messages get shipped to DeepL or Anthropic
consent to nothing, and me clicking "I agree" does not obtain it for them.

Stated plainly: **using a cloud provider sends other people's messages to a
third party.** Under GDPR that arguably makes the user a controller exporting
others' personal data, and it is the question a Chrome Web Store reviewer asks.
This is not a blocker — IMEs, screen readers and browser translate features all
sit in the same position — but it is a residual risk the *user* carries, and the
product should say so rather than imply consent was obtained.

Minimisation, which is what's actually on offer:
- On-device by default; **no message content leaves the machine on the automatic
  path.** This is the single strongest mitigation and the main argument for
  keeping the LLM off that path (§4.3).
- Cloud strictly opt-in, per-provider, one-time explicit consent naming the
  provider and stating the above in plain language.
- DMs excluded by default, separately enabled.
- No message content in logs or telemetry, ever. Counters only.
- Visible indicator whenever a cloud provider is in use.

**Bounded context export.** §3.3's thread context means translating one message
also sends the previous 3–5. The consent UI implies per-message or per-channel
choice; the implementation exports a rolling window. This must be stated in the
consent copy, hard-bounded in code (N messages, no media, no author ids), and
is a further reason the LLM path is user-initiated.

**The benchmark has the same problem.** Phase 0b runs 200 real messages from
private group chats through three engines — that is itself the first instance of
exporting other people's messages. Use a channel I'd be comfortable exporting,
strip authors, and don't treat the corpus as exempt because it's "just a test."

**The bot has a better story.** A Telegram bot is added to a group by an admin,
visibly, with the group's knowledge — consent at the group level by someone
entitled to give it. That's a genuine advantage over the extension, not just a
reach advantage.

---

## 6. Phases

Reordered so the cheapest, most decisive checks come first.

### Phase 0a — Capability check (half a day)
Mostly done; see §4.1. Remaining: measure real behaviour on a low-spec machine,
confirm Translator availability in an extension service worker vs content script
vs offscreen document (§4.2), and pull the live pair list from
`chrome://on-device-translation-internals/` for my actual languages.
**Exit:** I know whether the free path covers my channels, and where it runs.

### Phase 0b — Quality bake-off (one afternoon) ← *the real gate*
Collect ~200 real messages from my group chats, with their preceding context.
Run each through: built-in Translator, DeepL, and an LLM with thread context.
Rate on a rubric — meaning preserved, register preserved, DNT spans intact.
**Exit criterion: ≥80% of the cheap path rated meaning-preserved.** Below that,
the automatic path doesn't carry the product and §4.3 needs rewriting before
anything is built. Also settles whether thread context earns its cost (§3.3).

Nothing else starts until this passes. The previous draft had no phase gated on
output quality anywhere.

### Phase 0c — DOM spike (one day)
Discord only. Can injected nodes stay attached and correct through virtualized
scrolling, edits and deletes? Throwaway code.
**Exit:** layers survive 5 minutes of scrolling plus an edit and a delete.

### Phase 1 — Walking skeleton (1.5 weeks)
Extension scaffold; Discord adapter; on-device path with the pack-download UX
(§4.1); two-tier cache; RTL/`lang`/a11y from the start (§4.7); edit and delete
handling; options page.
**Exit:** I read a Spanish channel in English, locally, free.

### Phase 2 — Make it good (2 weeks)
Detection with short-message and code-switching rules; DNT masking; viewport
gating and batching; per-channel settings; hover translate; LLM escalation
button; error and adapter-broken states (§7).
**Exit:** usable all day on a busy server without annoyance.

### Phase 3 — Telegram bot (2 weeks)
Bot API, per-user language preferences, translations as replies or ephemeral
messages. Shares the provider/cache package (§11).
**Exit:** my Telegram groups are covered, on every device, within ToS.

### Phase 4 — Outbound + polish (2 weeks)
Composer translation with back-translation; glossary of never-translate terms;
quota meter; consent flows.
**Exit:** I can participate, not just read.

### Phase 5 — Public release (4–8 weeks, mostly waiting)
Chrome Web Store submission, privacy policy, onboarding, landing page.

Budgeted separately and honestly: store review for an extension requesting host
permissions on a major chat origin **and** handling user API keys is a
multi-round process, and a rejection resets the clock. This is calendar time,
not work time.

### Timeline
- **Working for me: ~8–10 weeks.** (Previous draft: 6–9 weeks for four
  adapters, four providers, two stores and everything in §10 — off by roughly
  3x. One adapter plus one bot makes the number close to honest.)
- **Publicly shipped: +4–8 weeks**, mostly review latency.
- **Standing cost: ~10% of every week, forever, from Phase 1 onward**, for
  adapter repair. The previous draft named this "the ongoing tax of the whole
  product" and then allocated zero time to it in any phase.

---

## 7. Adapter breakage — detection *and* recovery

Fixture tests on saved HTML, plus a weekly canary that loads Discord, runs the
adapter self-check and opens an issue on failure.

Two things the previous draft missed:

- **Users must see it.** Breakage reported only to a counter means users get an
  extension that silently does nothing. Needs an in-product state: "Polyglot
  can't read this page — Discord may have changed. Check for an update."
- **The fix is slow, and that's the real tax.** The natural fast fix —
  remotely updatable selectors — collides with Chrome Web Store's
  remotely-hosted-code policy. Selectors-as-config is arguably data, not code,
  but it is a grey area and reviewers are strict; assume every adapter break is
  a full store review cycle. This is the strongest argument for few adapters,
  and it is why §2 cut three of them.

---

## 8. Telegram bot (Phase 3, not "future work")

The Bot API is first-class: a bot in a group posts translations as replies,
reaching every member on every device, fully sanctioned. No DOM to maintain, no
store review to ship a fix, and the consent story in §5.

Discord has the same shape via a bot app with per-user language preferences and
ephemeral responses — fully within ToS, unlike client modification. Worth doing
after Telegram proves the pattern.

---

## 9. Terms of service

Reading the DOM and adding an overlay in my own browser is ordinary extension
behaviour. Automating the account is not: Discord bans self-bots outright, and
API-driven automation of a user account breaks Telegram's and WhatsApp's terms
too. This plan stays render-only — no message sent without an explicit click.
WhatsApp is out of scope partly for this reason.

---

## 10. Testing

- **Adapter fixture tests** — saved HTML snapshots replayed in Playwright,
  including edited, deleted, quoted and RTL messages.
- **Weekly canary** (§7).
- **Golden set** — the ~200 messages from Phase 0b become the standing quality
  regression, re-rated whenever a provider or prompt changes. Cases must match
  what the design can express (§4.5).
- **Performance budget in CI** — fail on injection-cost regression.

---

## 11. Stack

TypeScript strict; WXT for MV3; Preact in Shadow DOM; Vitest + Playwright; Zod
for settings and provider responses.

Storage: `chrome.storage.sync` for settings, IndexedDB for cache, and
**`chrome.storage.local` for API keys** — the previous draft said
`storage.session`, which is cleared when the browser session ends and would make
the user re-paste their DeepL key on every restart. `local` also never leaves
the device; `sync` is correctly ruled out because keys must not sync.

The provider/routing/cache layer is a **standalone package from day one**, since
the extension and the bot both consume it.

---

## 12. Success criteria — falsifiable

The previous draft's criteria were "I'd notice / I wouldn't notice." Numbers:

- **≥80%** of the golden set rated meaning-preserved on the automatic path;
  **≥90%** including LLM escalation.
- **100%** of golden-set DNT spans (mentions, emoji, code, URLs) intact.
- **0** translation layers rendered on messages already in a known language.
- Adapter canary green **≥28 of 30 days**.
- p95 injection cost within CI budget; translation visible **<500ms p50 /
  <2s p95** on the on-device path (the automatic path only — this budget was
  previously claimed for an LLM path where it was unachievable).
- **$0** for a full day of on-device-only use.
- Cloud provider character count **0** while cloud is disabled — asserted in a
  test, not assumed.

---

## 13. What changed from v1, and why

| v1 | v2 |
|---|---|
| Phase 0 spiked DOM attachment | Phase 0b gates on **translation quality**; DOM spike demoted to 0c, one day |
| Four adapters (Discord, Telegram ×2, WhatsApp, Slack) | **Discord only**; Telegram becomes a bot in Phase 3 |
| LLM auto-routed for short/slangy messages | **LLM is a manual escalation**; automatic path stays on-device/cloud-MT |
| Cache key ignored thread context | **Two-tier key**, context hashed into the LLM tier |
| Cache framed as the cost defence | **Viewport gating** is the cost defence; cache is latency |
| Translator API checked at step 3 of §10 | **Checked first** (§4.1), with findings that changed the architecture |
| Translation in the MV3 service worker | **In the content script** — built-in APIs aren't available in workers |
| Firefox shipped in Phase 5 | **Out of v1** — no built-in API means no default provider there |
| Privacy answered with user consent | Names the **third parties** who never consented; bounds context export |
| `chrome.storage.session` for keys | **`chrome.storage.local`** |
| Edits, deletes, RTL, a11y, embeds unmentioned | **Specified** (§4.6, §4.7) |
| Breakage reported to a counter | Plus **user-facing state**, and the store-review cost named |
| 6–9 weeks | **8–10 weeks to working**, +4–8 to shipped, +10%/week forever |
| "I'd notice / I wouldn't" | **Numeric thresholds** (§12) |

---

## 14. First actions

1. Finish Phase 0a: low-spec behaviour, worker-context confirmation, live pair
   list for my languages.
2. Collect the 200-message corpus **with context**, from a channel I'm
   comfortable exporting, authors stripped (§5).
3. Run the bake-off. **If it fails, stop and rethink §4.3 before building.**
