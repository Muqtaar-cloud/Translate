# Polyglot — a build plan for in-place chat translation

**Problem.** Group chats on Discord and Telegram routinely mix three or four
languages in one channel. Copy-pasting each message into a translator destroys
the flow, loses context, and is hopeless in a fast channel. I want to read every
message in my language without leaving the chat.

**v3.** Revised twice under review. §14 records what changed. The short version:
v1 validated the wrong risk and contradicted itself in three places; v2 fixed
that but generalized client-side economics to a server, fused a personal tool
with a public product, and set a quality gate I have no way to measure.

---

## 1. Two products, decided separately

The single most useful cut in this revision. v1 and v2 both described one thing.
There are two, with different requirements, different risks, and different
reasons to exist:

**A. A tool for me.** Discord web, English reading language, my machine,
unlisted. Success is that I read my channels. No store review, no onboarding, no
consent copy, no addressable market.

**B. A public product.** Everything in A plus Web Store review, arbitrary
reading languages, arbitrary hardware, other people's privacy, support.

**v1 ships A.** B is a separate decision, gated on §2 and taken after A has run
for a month. This is not a hedge — several things that look like risks in B cost
nothing in A, and several costs in B are unjustifiable until A proves the
product is worth using at all.

Consequences, spelled out because they were tangled before:

- **The `en ↔ N` pivot problem (§4.1) does not affect me.** My reading language
  is English; every pair I need is `N → en`, which the API supports natively
  with no pivot. The `"no provider for es→pt"` fallback state almost never
  fires in A. It becomes launch-blocking the moment a Spanish-reading user
  installs B. Carried forward as a **B-risk**, not a live v1 concern.
- **Consent copy, onboarding and privacy policy move to B.** The context-export
  bound in code (§5) stays in A — that's a real constraint on my own behaviour,
  not paperwork.
- **RTL (§4.7), honestly classified.** When source is Arabic and target is
  English, my injected layer is LTR — RTL is mostly a B-concern (users whose
  *reading* language is RTL). It bites A only where RTL fragments and restored
  DNT spans land inside an English layer. `dir="auto"` plus bidi isolation is
  cheap enough to keep in Phase 1 regardless, but v2 overstated its urgency.
- **A11y likewise**: `lang` attributes are nearly free and genuinely useful in A
  (font selection); the screen-reader double-read story is a B-concern.

---

## 2. The question that gates B, and has never been asked

Chrome/Edge desktop only, plus the hardware gate in §4.1. **What share of people
can actually run this?** Nobody has estimated it, through three drafts.

This is the input to a 4–8 week decision (§9, Phase 5). If the answer is a low
single-digit share of Chrome desktop users who *also* read multilingual group
chats, the right move is to stay unlisted, hand the zip to a few people, and
spend those weeks elsewhere.

**And it is answerable for free, so the question stops being rhetorical.** It
isn't externally knowable — Chrome doesn't publish it — but A has to call
`availability()` to function at all. Log the distribution of the four states
across real machines (counter only, no content, within §5), ship A to myself and
a handful of friends, and by the time the B decision comes up a month later there
are real numbers from real hardware instead of an inference from a documented
spec §4.1 already suspects is over-strict. One line in Phase 2 (§9).

**And the pre-install half is built: `tools/preflight`.** A single
self-contained page that reports browser, API presence and per-pair
availability, and downloads a pack on a click. It exists because the extension
fails closed — with no on-device path and no API key, it does nothing at all,
and 0a found nothing is `available` on a fresh profile, so a friend's first
sign of an unsupported machine would otherwise be a chat window that never
translates. It also answers §2 directly: run it on a handful of real machines
and the qualifying-share question has evidence instead of an inference from a
documented spec. Because language packs are a browser-level resource rather
than per-site data, downloading there warms the same packs the extension uses —
the nearest thing the platform allows to choosing your languages at install
time, since `create()` needs a user gesture and an install has none.

Note the interaction with §8: "spend the store weeks on the bot instead" is only
attractive if the bot has economics, which is exactly what §8 now questions.
**Taken together, §1 and §8 argue for a smaller v1 than either does alone** — the
extension, unlisted, for me and a handful of friends, with both the store and the
bot deferred behind evidence.

---

## 3. What is actually uncertain

1. **Quality.** Are machine translations of casual group chat good enough that
   reading them beats not reading them? Gated in Phase 0b (§6, §7).
2. **Economics.** Is there a free-or-cheap path for the common case? Client-side
   the answer looks yes (§4.1). Server-side, for the bot, it is **unanswered**
   (§8).
3. **Mechanism.** Can injected nodes stay attached and correct through a
   virtualized, frequently-redesigned UI? Cheapest of the three; one day (§9).

---

## 3. Product shape

Restored in v3.1: the compression through v2→v3 dropped this section entirely,
leaving fourteen sections of justification for a product the document no longer
described. Each revision answered objections, and the parts nobody objected to
atrophied.

**Inbound (the core).** Translations render **underneath** the original message,
never replacing or hiding it — dimmer, slightly indented, with a language badge
(`ES → EN`). This is the most important decision in the document: mistranslation
is inevitable, so keeping the source visible is what makes it survivable, lets
bilingual readers ignore the layer, and is what gives §12's false-negative
criterion something to be false about.

**Modes.** Auto (everything not in my known-languages list), on-demand (hover
globe, available on *every* message — see §12), and per-channel settings keyed by
(platform, guild, channel).

**Outbound (Phase 4).** I type in English, hotkey, get the translation in the
composer **for review before sending** — never auto-send. See §9 Phase 4 for what
review can and cannot catch.

**Context handling** is a hypothesis, not a commitment: §6 tests whether thread
context measurably improves output, and §5.1 constrains where it may be used
regardless of the answer.

---

## 4. Architecture

```
┌─ Content script (Discord adapter) ───────────────────────┐
│  MutationObserver → queue → IntersectionObserver gate    │
│  Translator + LanguageDetector run HERE (§4.2)           │
│  Shadow-DOM Preact layer, dir/lang per node              │
└───────────────┬──────────────────────────────────────────┘
                │ port (cloud paths + settings only)
┌───────────────▼─── Service worker (MV3) ─────────────────┐
│  Cloud providers · token bucket · backoff · quota        │
│  IndexedDB cache (two-tier keys, §4.4)                   │
└──────────┬──────────────────┬────────────────────────────┘
      DeepL/Google        LLM (manual escalation only)
```

### 4.1 The on-device path — verified

Findings as of **2026-09-17**; re-verify, these move.

- **Chrome 138+ and Edge 148+, desktop only.** **Firefox and Safari: no
  equivalent web API** — which is why Firefox is out (no default provider there
  at all, plus a second, event-page-shaped background form).
- `availability()` → `available` / `downloadable` / `downloading` /
  `unavailable`, per pair. **`create()` requires a user gesture** when a pack
  isn't present — no silent warm-up; this needs a real per-pair download UX
  (§9, Phase 1).
- **Pairs are `en ↔ N`; non-English pairs pivot through English.** A B-risk, not
  an A-risk (§1).
- Cross-origin iframes need `allow="translator"`.
- **Hardware gate, precisely.** Language packs are ~25–50 MB each and the
  underlying models ~1.5–2 GB, but **Chrome still gates on ~22 GB free disk,
  16 GB+ RAM, 4+ cores**. So the barrier is *policy, not physics* — the disk a
  user needs free vastly exceeds what gets used, and Google could relax it.
  v2 implied the packs themselves were heavy; they aren't. The gate is still
  what determines who qualifies, so it remains the input to §2 — measure it on a
  low-spec machine in Phase 0a rather than trusting the documented figure.

**Measured 2026-09-17**, Playwright's bundled Chromium 1194 (headless=new, not
a real Chrome profile — treat as indicative, not as the 0a result):

- **Both `Translator` and `LanguageDetector` were present** on a sandbox machine
  nowhere near 22 GB free or 16 GB RAM. So the documented hardware gate does not
  gate *API presence*; it presumably gates the pack download, which a headless
  run cannot reach (no user gesture). The §2 question is therefore about who can
  complete a download, not who has the API — a narrower and more answerable
  question than the one the plan has been asking.
- **Every pair returned `downloadable`, including `es→pt`.** Non-English pairs
  are *offered* rather than rejected, so the `"no provider for es→pt"` state
  fires more rarely than §4.3 implies, even for a non-English reader. The pivot
  still happens underneath, so the quality concern stands and stays a B-risk —
  but the availability concern was overstated.
- **Nothing was `available` on a fresh profile.** The first foreign message in
  any channel hits the download prompt. The Phase 1 download UX is therefore
  not an edge case, it is the first-run experience for every user, and it
  should be designed as onboarding rather than as an error state.

### 4.2 Where translation runs
The built-in APIs are **not available in Web Workers** (Permissions Policy), so
they cannot run in the MV3 service worker. Translation and detection run in the
**content script**; the worker handles cloud calls, quota and cache. Phase 0a
confirms behaviour in an extension service worker and an offscreen document.

### 4.3 Provider routing

```
detect → known language                      → skip, no cost
       → availability 'available'            → on-device
       → availability 'downloadable' |
                      'downloading'          → PROMPT for pack download. STOP.
                                                Never falls through.
       → availability 'unavailable' and
         quality tier enabled (BYO key)      → DeepL / Google
       → else                                → "no provider for es→pt" (rare in A)
```

**`downloadable` is its own terminal branch, and this is safety-critical.**
§4.1 gives four availability states; collapsing them to a boolean means a user
who enabled cloud and hasn't yet clicked through a pack download would silently
have their messages sent to DeepL — on the automatic path, for a pair that was
going to be free and local. That is exactly the event §5 exists to bound,
reached by falling through a table rather than by anyone deciding it. Asserted
in a test (§12).

**The LLM is never on the automatic path.** It is a per-message "translate
properly" button on the layer, used when the cheap path produced something
visibly mangled. That confines LLM cost, latency and context-export to messages
I explicitly chose, and is what makes §5's bounding argument true.

### 4.4 Caching
Two tiers, because the same text under different context has a different correct
translation:

- **Context-free** (automatic path): `sha256(text + src + tgt + provider)`.
- **Context-assisted** (LLM escalations): `+ sha256(contextWindow)`. Effectively
  unique; hits only on genuine repeats, which is fine for a user-initiated path.

Never interchangeable; the tier is part of the key. **The cache is a latency
win. Viewport gating (§4.6) is the cost defence** — the stock phrases that would
drive a high hit rate are exactly the sub-15-character messages §4.5 skips.

### 4.5 Language detection
Built-in `LanguageDetector`, CLD3/`franc` WASM fallback. Below ~15 characters,
trust nothing — skip unless a channel's dominant language can be inherited.
Sticky per-author weighting.

**Code-switching: measured before it is built.** v2 committed to ranked-
confidence detection plus per-sentence segmentation — real Phase 2 work — on the
assumption that intra-message code-switching matters. The corpus is being
collected in 0b anyway, so **count it there**. Under ~5% of messages: drop
segmentation and the golden-set cases together. Over ~15%: build it, with
evidence. In between: single-language detection plus a manual re-translate
affordance. The answer is free and arrives before the work does.

### 4.6 Render loop and message lifecycle
MutationObserver → queue → IntersectionObserver releases near-viewport only →
debounce ~150ms → batch → inject → mark done. Scrolling past 500 backlog
messages must not fire 500 translations.

**Measured 2026-09-21** (built extension, real Chromium, 66-message channel):
10 messages translated on load, 18 after scrolling to the bottom, **48 never
touched**. Jumping to the end deliberately does not translate what was scrolled
past. Gating works, and it is the cost defence as claimed.

**Correction to "batch ~20 segments into one provider request".** That presumed
a batch endpoint. Chrome's built-in Translator has none — `translate()` takes
one string and returns one string — so on the automatic path batching cannot
reduce the number of calls. What it does buy is (a) **dedupe within the
window**, so six people typing "gm" in the same second cost one translation,
(b) a **concurrency ceiling**, so releasing a screenful of backlog does not fire
forty simultaneous model invocations at the main thread, and (c) the one place a
cloud provider *can* bundle, since DeepL takes an array. The batch size is a
coalescing and concurrency window on-device and a real request bundle on cloud.
Worth stating plainly, because "batching" implied a cost saving on the automatic
path that is not available there.

- **Edits:** key on `(messageId, hash(currentText))`, so an edit invalidates and
  a virtualized remount of unchanged text hits cache and re-injects free. One
  rule covers both, by construction.
- **Deletions:** observer removes the orphaned layer.
- **Quoted replies** masked as DNT, inheriting the quoted message's own layer.
  **Embeds, link previews, poll options and thread titles are explicitly not
  translated in v1** — decided here rather than discovered in Phase 1.
- **Spoilers are redacted, not read.** Discord hides spoiler text behind a
  click but leaves it in the DOM, so a `textContent` extraction reads it and
  the layer prints it in the clear underneath the still-hidden original —
  visible to anyone looking at the screen or on a screenshare. Unrevealed
  spoiler content is replaced with `SPOILER_MARK` (`▮▮▮`), which is a
  do-not-translate span like any other, so the sentence stays readable
  (*"el final es ▮▮▮"*) without leaking. A spoiler the user has opened is
  theirs to read and translates normally; because the revealed text changes
  the node key, opening one re-translates the message with no extra machinery.
  The selector is the one deliberate exception to the no-styling-classes rule
  (ARIA plus a `[class*="spoiler"]` fallback) — missing a spoiler leaks rather
  than breaking something cosmetic, so it is worth matching twice.
- **Line structure is preserved.** `textContent` inserts nothing at `<br>` or
  a block boundary, so a two-line message reaches the engine as
  `"primera líneasegunda línea"` — corrupted before translation begins.
  Extraction walks the tree emitting newlines, and the layer renders
  `white-space: pre-wrap`. Shift+Enter is ordinary in chat, so this was the
  normal case being handled as an edge one.
- **Markdown formatting is flattened, deliberately.** Bold, italic,
  strikethrough, headers and blockquotes do not survive extraction. Rebuilding
  markup around translated text is an alignment problem worth real effort, and
  the original directly above already carries its own formatting. Stated here
  so it is a decision rather than an artefact of `textContent`.

### 4.7 Rendering correctness
`dir="auto"` plus `unicode-bidi: isolate` on every injected node; `lang` set
correctly; `aria-label` marking the layer as a translation. See §1 for which of
these are A-concerns and which are B-concerns.

---

## 5. Privacy

**Group chats contain other people's words.** Every remedy that governs *my*
consent — a consent screen, an opt-in, an indicator — answers the wrong party.
The third parties whose messages get shipped to DeepL or Anthropic consent to
nothing, and me clicking "I agree" does not obtain it for them. Under GDPR that
arguably makes me a controller exporting others' personal data. Not a blocker —
IMEs, screen readers and browser translate sit in the same position — but a
residual risk **I** carry, stated rather than dissolved.

Minimisation, which is what's actually on offer:
- On-device by default: **no message content leaves the machine on the automatic
  path.** The strongest mitigation, and the main reason to keep the LLM off that
  path (§4.3).
- Cloud opt-in per provider; DMs excluded by default; no content in logs or
  telemetry, ever; visible indicator when a cloud provider is live.

**Built, and two things it turned up.** The options page states, at the toggle:
that the provider is DeepL by name; that the messages sent include other
people's, who have not agreed and on whose behalf the user cannot agree; that a
merely `downloadable` pack never becomes a cloud request; that DMs are gated
separately and why; and that *translate properly* also sends the few preceding
messages as context, text only, and does nothing while cloud is off. Consent is
recorded (provider and date) rather than merely displayed, dropped when cloud is
switched off, and re-asked for a different provider — consent was given about a
named company, so it does not transfer.

Writing it exposed a gap: **a DeepL-translated layer was rendered identically to
an on-device one**, so the §5 promise of a visible indicator was not kept for
cloud MT — only for LLM escalations. A cloud result is now marked `· cloud`,
keyed off `leavesDevice()`, the same predicate these rules are written against.
Copy that describes a product honestly is a test of the product, and this one
failed it.

### 5.1 The context rule — decided now, before the tempting result arrives

§3 makes thread context a hypothesis that 0b will test. If 0b says context
helps, the obvious next move is to switch it on for the automatic cloud path,
and **DeepL's API has a `context` parameter for exactly this — context is not
translated and, verified, is not billed.** So the usual brake does not exist:
using context on the automatic path is *free*. Only a rule stops it.

**The rule: context is permitted only on user-initiated paths.** Never on the
automatic path, whatever 0b returns. If that is ever revisited, §5 must be
rewritten in the same commit, because the moment context rides the automatic
path, surrounding messages leave the machine for every cloud-translated message
and the bounding argument is gone — silently, without anyone deciding to remove
it.

In code: N messages, no media, no author ids, hard-bounded.

### 5.2 The benchmark is the first export
0b runs real messages from private group chats through several engines. That is
itself an instance of the problem. Use a channel I'd be comfortable exporting,
strip authors, and don't treat the corpus as exempt for being "just a test."

---

## 6. Phase 0b — the gate, and how it is actually measured

Everything depends on this phase, and v2 specified a rubric I cannot apply:
"meaning preserved, register preserved" — **in languages I can't read.** That is
the premise of the whole product. A gate I can't measure honestly returns
whatever number I was hoping for.

**Method, in priority order:**

1. **Bilingual raters — primary.** One friend per language, for the two
   languages that dominate my channels. This is the only method that credibly
   rates *register*, which for casual chat matters as much as meaning. One
   afternoon each, and the cheapest honest option by a wide margin.

   **With a paid fallback, because two unpaid favours is a single point of
   failure for a 7–8 week project.** If the friends don't materialise or drift,
   Prolific or Upwork will buy a couple of hundred careful ratings in a common
   pair for roughly $50–100. Against 7–8 weeks that is nothing, and it converts
   a dependency on goodwill into a purchase.

   **If rater time is the constraint, invert the order.** The sentence-level
   pass needs hours of rater attention; the comprehension check (3, below) needs
   about one — a bilingual person reads the same hour of channel and says what
   happened, and I compare it against my notes from the translated version. It
   also tests the product claim directly rather than a proxy. Run comprehension
   first, and go to sentence-level only when it comes back ambiguous.
2. **LLM-as-judge on (original, translation) — supporting, for the on-device and
   DeepL tiers only.** Defensible there because the judge is a different system.
   **Explicitly not used to rate the LLM tier** — that's circular.
3. **End-to-end comprehension — complementary.** Read a translated channel for
   an hour, write down what I understood happened, have a bilingual rater mark
   it. This tests the actual product claim ("reading them beats not reading
   them") rather than sentence-level quality, and I can run it myself.
4. **Back-translation — explicitly rejected as a primary measure.** It hides
   precisely the failure that matters: a fluent-but-wrong translation
   back-translates fluently.

**Sizing, honestly.** v2's "200 messages × 3 engines × 3 criteria, one
afternoon" is ~1,800 judgments. Done in an afternoon, the number is noise. Cut
to **~80–100 messages per language, two languages**, rated carefully.

**The gate is coarse, because the measurement is.** At n≈100 the confidence
interval on a proportion near 0.8 is roughly ±8 points, so v2's "≥80%" versus
75% is not a distinguishable difference and must not carry a 10-week decision.
Instead:

- **Obviously good** → build.
- **Obviously bad** → stop.
- **Marginal** → *stop.* Marginal quality will not survive real use, and
  "marginal" is the result most likely to be argued into a green light.

**DNT spans must be masked before the corpus reaches any engine.** §12 requires
100% of DNT spans intact, but masking is Phase 2 work and 0b would otherwise run
raw messages through raw engines: every engine mangles `@handles`,
`:custom_emoji:` and code spans when nothing is masking them, so a rater would
mark all four candidates down for the unmasked baseline rather than for anything
the engines did. Masking is cheap and already needed, so 0b runs the real
masking code (`@polyglot/core`) over the corpus and measures placeholder
survival separately from translation quality. The rubric rates **meaning and
register only**; DNT is a mechanical pass/fail counted by the harness.

Also counted in this phase, free: **code-switching frequency** (§4.5) and
**self-hosted MT quality** (§8).

---

## 7. Terms of service

Reading the DOM and overlaying in my own browser is ordinary extension
behaviour. Automating the account is not — Discord bans self-bots, and
API-driven automation of a user account breaks Telegram's and WhatsApp's terms.
Render-only; nothing sent without an explicit click. WhatsApp is out of scope
partly for this reason.

---

## 8. The Telegram bot — economics, which it did not have

v2 moved the bot from "future work" into Phase 3 on reach, ToS and consent. All
three arguments hold. But **every economic and privacy argument in this document
is client-side, and none of them survive the move to a server.** v2 quietly
generalized them. Stated properly:

- **There is no on-device branch.** No built-in Translator API on a VPS. The
  free default — the thing §4.1 was checked first to establish — does not exist
  for the bot. Every translation is a paid call, or a model I host.
- **There is no viewport.** The cost defence (§4.4) is gating on what someone
  actually looks at. A bot sees no one looking, so eager translation means
  translating every message whether or not anyone reads it.
- **Fan-out multiplies.** A 40-person group with five reading languages needs
  each message translated once per *distinct target*, not per member — but
  that's still up to 4× every message, against 1× for what one extension user
  scrolls past.
- **BYO keys does not transfer.** The extension's cleanest structural decision —
  no backend, no key custody, no per-user cost exposure — works because each
  user pays for their own reading. When an admin adds a bot, whose key pays for
  500 messages/day × 40 members? "The admin's" is a hard sell; "mine" is a
  business.
- **It is infrastructure.** Hosting, deploys, secrets, a database of per-user
  preferences, uptime. "No store review to ship a fix" is real, and is traded
  for "something I now operate."
- **And it inverts the privacy story I credited it with.** v2 said the bot has
  a better consent story — true, an admin adds it visibly on the group's behalf.
  But group members' messages now flow through **my server**, making me a
  processor holding other people's chat content. Better consent, worse custody.
  Both, not just the flattering half.

**The two answers, and how they get decided early:**

1. **Demand gating instead of viewport gating.** The bot translates on request —
   a reply command or a reaction — not eagerly. This is the direct analogue of
   §4.6 and it is what makes the cost bounded by *interest* rather than by
   traffic. Eager translation is the unaffordable mode; treat it as opt-in per
   group, off by default.
2. **Self-hosted MT** on a small box, restoring free-at-the-margin — pay for the
   box, not per character. It also keeps content off third-party APIs, though
   not off my server.

   **NLLB and Opus-MT are not interchangeable, and the difference is the
   hosting story:**

   | | NLLB-200 distilled (600M) | Opus-MT |
   |---|---|---|
   | Shape | One multilingual model | One model per pair |
   | Resident | ~2.5 GB | ~300 MB each |
   | Non-English pairs | Direct | Per-pair, or pivot |
   | Unpredictable language mix | Handles it | Preload a matrix, or eat cold starts |

   A bot's whole premise is arbitrary groups with arbitrary language mixes, so
   **take NLLB for the bake-off** unless the target languages turn out to be
   known and few.

**Decided in Phase 0b, eight weeks early, for the cost of one afternoon:** add
self-hosted NLLB/Opus-MT as a fourth engine in the bake-off. If it clears the
same bar as the on-device path, the bot is viable and roughly free at the
margin. If it doesn't, the bot is a paid cloud product, and building it as a
personal tool needs a decision it has never been given.

**Re-budgeted: 3–4 weeks, not 2** — self-hosted inference, hosting, a
preferences database and deploys are not two weeks — **and gated on 0b.**

**Built 2026-09-21, ahead of that gate. Two asymmetries this section missed:**

*There is no language detector on a server.* The browser hands the extension one
free. NLLB needs an explicit source language, and "translate into everyone's
language" is meaningless without knowing the source, so the bot has to bring its
own — a hand-rolled heuristic, weaker than the browser's and weakest on short
messages, which is most of chat. A real quality gap between the two products,
and something the bake-off should measure before Phase 3 is trusted.

*`knownLanguages` is an extension-shaped idea.* It means "languages the reader
already reads", which assumes one reader. A bot has many, with different lists,
so no single value is right — and the obvious-looking choice (the source
language) makes routing skip every translation. The shared package survived the
second consumer, but not without exposing where its vocabulary came from: the
route formerly called `on-device` is now `local`, because what is free and local
is a downloaded pack in one consumer and a self-hosted model in the other.

---

## 9. Phases

### Phase 0a — Capability check (half a day)
Mostly done (§4.1). Remaining: real behaviour on a low-spec machine (§2 depends
on it); Translator availability in extension service worker vs content script vs
offscreen document (§4.2); live pair list from
`chrome://on-device-translation-internals/`.

### Phase 0b — Quality bake-off (2–3 days) ← *the gate*
Per §6: ~80–100 messages × 2 languages, four engines (built-in, DeepL, LLM with
context, self-hosted MT), bilingual raters. Also counts code-switching frequency
(§4.5). v2 said "one afternoon"; with real raters and an honest corpus it is not.
**Nothing else starts until this passes.**

### Phase 0c — DOM spike (one day)
Discord only, throwaway. Do layers survive virtualized scrolling, an edit and a
delete? Confirms the `(messageId, hash(text))` key.

### Phase 1 — Walking skeleton (2.5–3 weeks)
Scaffold; Discord adapter; on-device path; **per-pair pack-download UX** — a
state machine over four availability states, gated behind a user gesture, with
progress, failure and retry; two-tier cache; edit/delete handling; `dir`/`lang`;
options page.

*v2 called this 1.5 weeks — v1's one-week estimate nudged, while four
workstreams were added to it. The download UX alone is most of a week.*

### Phase 2 — Make it good (2 weeks)
Detection rules; DNT masking; viewport gating and batching; per-channel
settings; hover translate **on every message including skipped ones** (§12);
LLM escalation button; context bound in code (§5.1); adapter-broken state (§10);
**`availability()` distribution telemetry** (§2) — counter only, no content,
fully within §5.

### Phase 3 — Telegram bot (3–4 weeks, **gated on §8**)
Only if 0b showed self-hosted MT clears the bar, or I accept a paid cloud
product. Demand-gated by default.

### Phase 4 — Outbound (2 weeks) — *the honest cut if the timeline slips*
Composer translation; glossary; quota meter.

**Back-translation review is not a safety guarantee, and the plan must not
pretend otherwise.** §6 rejects back-translation as a *measurement* because a
fluent-but-wrong translation back-translates fluently. Per-message
sanity-checking is a softer use — it does catch gross failures like flipped
negation, wrong entity and nonsense — but it misses exactly the fluent-wrong
case, while being the only review step between me and publishing text under my
name, to a group, in a language I cannot read. So: **outbound will occasionally
post something wrong that back-translation passed.**

The mitigation, restored from v1 where the same compression dropped it:
**append the original.**

```
¿Vienes mañana?

> (EN) Are you coming tomorrow?
```

Any bilingual reader in the group then sees both and resolves it. That is
strictly better than back-translation, costs nothing, and makes a bad
translation self-correcting rather than silently wrong. On by default.

**Built 2026-09-21, with three things worth recording.**

*The composer cannot be written to by assigning DOM text.* Discord's message box
is a Slate editor: setting `textContent` updates the view while React's model
keeps the old value, so the message that sends is the one the user typed rather
than the translation they approved — silently, under their name, which is the
exact outcome the review step exists to prevent. The write goes through
`execCommand("insertText")` with a synthetic-paste fallback, and is **verified
by reading the editor back** rather than assumed. A refused write says so and
tells the user to copy manually.

*Outbound is `en → N`, which is the direction the built-in packs support
natively.* Inbound for a non-English pair pivots through English (§4.1);
outbound does not. So outbound is more often free and local than inbound is —
the opposite of what one would assume from it being the "extra" feature.

*The no-fallthrough rule applies here too.* A pack that is merely `downloadable`
must never become a silent cloud request on the outbound path either. It is
tempting to let it through — the user is staring at a panel and an error feels
unhelpful — and that is precisely how content starts leaving the machine without
anyone deciding it.

**Why this is the cut.** §1 defines A's success as *"I read my channels"*, and
§3's uncertainties don't include writing. Two of A's 7–8 weeks go to the one
feature A isn't justified by. It is also the direction 0b doesn't test — 0b
rates `N → en`; outbound is `en → N`, a different direction with a different
failure profile, judged by people who aren't in the bake-off.

### Phase 5 — Public release (**decision, then 4–8 weeks**)
Not automatic. Gated on §2: estimate the qualifying share of users first. If
small, stay unlisted and stop here. If it proceeds: consent flows, privacy
policy, onboarding, a11y completion, store submission — multi-round review for
an extension with host permissions on a major chat origin and user API keys, and
a rejection resets the clock. Calendar time, not work time.

### Timeline, re-derived from scope rather than nudged
- **Tool for me (0a–0c, 1, 2, 4): ~7–8 weeks.**
- **Plus the bot, if 0b clears it: +3–4 weeks.**
- **Plus public release, if §2 justifies it: +4–8 weeks**, mostly waiting.
- **Standing: ~10% of every week, forever, from Phase 1** — adapter repair.

---

## 10. Adapter breakage
Fixture tests on saved HTML (including edited, deleted, quoted, RTL messages),
plus a weekly canary that opens an issue on failure.

- **Users must see it** — a counter alone means an extension that silently does
  nothing: "Polyglot can't read this page — Discord may have changed."
- **The fix is slow.** Remotely updatable selectors collide with Chrome Web
  Store's remotely-hosted-code policy; selectors-as-config is arguably data, not
  code, but reviewers are strict, so assume every break is a review cycle. This
  is the strongest argument for few adapters — and note it is a **B-cost**: in A,
  unlisted, I just reload the extension.

---

## 11. Stack and the shared package

TypeScript strict; WXT for MV3; Preact in Shadow DOM; Vitest + Playwright; Zod.
`chrome.storage.sync` for settings, IndexedDB for cache, **`chrome.storage.local`
for API keys** — `session` is cleared on browser restart, `sync` must never carry
keys.

**Measured 2026-09-21: `@anthropic-ai/sdk` cannot be used in the MV3 service
worker.** It bundles cleanly and then breaks the worker at runtime — the module
body never completes, so `chrome.runtime.onMessage` is never registered and
every message, including every cache lookup, silently degrades to a no-op. With
the SDK the bundle is 511 kB and the worker is dead; without it, 11.5 kB and
alive. The LLM escalation therefore calls the Messages API over `fetch`. The
SDK remains the right default everywhere it runs; shipping a dead service
worker to honour a default would be worse. Bundle size matters here
independently, since this worker is woken by every cache lookup.

The provider/routing/cache package is shared by the extension and the bot — but
v2 asserted that on day one without noticing that **its primary branch doesn't
exist in one consumer and its cost assumptions hold in only one** (§8). So, as a
constraint rather than a committed interface — the second consumer may never
exist (§8), and designing its API now would be building for a hypothetical:

- **No `if (onDevice)` inside the package.** The provider set is passed in and
  may not contain an on-device provider at all.
- **No assumption that gating already happened.** The caller decides whether a
  message is worth translating (viewport for the extension, demand for the bot).

---

## 12. Success criteria

- Phase 0b clears the **coarse** bar in §6 — obviously good, not marginal.
- **False negatives, which are the failure I'd actually feel:** in auto mode a
  skipped Spanish "ya voy" is visually identical to an English message — I never
  learn it happened, it just reads as a gap. So: **≤5% of foreign-language
  golden-set messages left untranslated**, and the hover globe is available on
  **every** message in **all** modes, not only on-demand mode. That affordance is
  what makes the sub-15-character skip rule safe. (v2 measured only the inverse —
  layers where none belonged — which is the failure I'd notice anyway.)
- **100%** of golden-set DNT spans intact.
- Adapter canary green **≥28 of 30 days**.
- Translation visible **<500ms p50 / <2s p95 on the on-device path only**.
- **$0** for a full day of on-device-only use.
- **Cloud character count 0 while cloud is disabled** — asserted in a test.
- **Context window size 0 on every automatic-path request** — asserted in a
  test, because §5.1 is a rule and rules need enforcement.

---

## 13. First actions

1. Finish 0a: low-spec behaviour, worker-context confirmation, live pair list.
2. Line up **two bilingual raters** (§6) — the long-lead item everything waits
   on. Start the paid fallback in parallel rather than after they fall through.
3. Collect the corpus **with context**, authors stripped, from a channel I'm
   comfortable exporting (§5.2). Mask it with `@polyglot/core` before it reaches
   any engine (§6).
4. Stand up **self-hosted NLLB-200 distilled** as the fourth bake-off engine
   (§8). Budget **one to two days**, not an afternoon: model download, Python
   env, CTranslate2 conversion, tokenizer setup, a working inference loop. Still
   eight weeks early, but it isn't a checkbox.
5. Run the bake-off. **Marginal means stop.**

---

## 14. Revision history

**v1 → v2.** Phase 0 re-gated on translation quality rather than DOM attachment;
scope cut from four adapters to Discord-only with Telegram moved to a bot;
Firefox dropped (no built-in API); LLM demoted from automatic route to manual
escalation, resolving a contradiction where the "escape hatch" was the modal
path and broke the cost, latency and cache claims at once; cache split into two
tiers so thread context couldn't poison context-free hits; translation moved out
of the service worker (built-in APIs are unavailable in worker contexts —
found by checking the API first, which the reordering was supposed to justify on
other grounds); API keys moved from `storage.session` to `storage.local`; edits,
deletes, RTL, a11y, embeds specified; numeric criteria replaced "I'd notice."

**v3 → v3.1 (inline fixes, no restructure).** Restored §3 Product shape, deleted
by compression — the render-underneath decision, the modes and the badge had
stopped appearing anywhere. Phase 4 now states that back-translation does not
catch the errors §6 says it doesn't, and restores *append the original* as the
real mitigation; noted as the honest cut since A isn't justified by writing.
`downloadable` given its own terminal routing branch in §4.3 — collapsing four
availability states to a boolean silently routed free-and-local pairs to DeepL.
0b masks DNT with the real code instead of penalising every engine for an
unmasked baseline. Paid rater fallback and an inverted cheap-first order added to
§6. §2's question now routes its own answer back via `availability()` telemetry.
NLLB and Opus-MT separated, NLLB taken, re-budgeted to one to two days. §11's
speculative interface reduced to the two constraints it was carrying.

**v2 → v3.**

| v2 | v3 |
|---|---|
| One product | **Two** (§1): a tool for me, and a public product decided later |
| Store release assumed | **Gated on who can actually run it** (§2) — never asked before |
| Bot justified on reach/ToS/consent | **§8: no on-device branch, no viewport, fan-out, no key model, it's infrastructure** — and I become a processor of others' messages |
| Bot = 2 weeks, unconditional | **3–4 weeks, gated on 0b**, with self-hosted MT as a 4th bake-off engine to decide it 8 weeks early |
| Shared package asserted | **Policy injected** (§11) — the package can't assume on-device or a viewport |
| Rubric I can't apply | **Named raters** (§6): bilingual primary, LLM-judge non-circular only, back-translation rejected |
| "≥80%, one afternoon" | **Coarse gate, 2–3 days** — ±8pp at n≈100 can't carry a 10-week call; **marginal = stop** |
| Context = open question | **Rule now** (§5.1): user-initiated paths only. DeepL's `context` is free and unbilled, so only a rule stops it |
| Code-switching design committed | **Counted in 0b first** (§4.5) — the measurement was already scheduled |
| Pivot as live risk | **B-risk**: every pair I need is `N → en`, no pivot |
| Packs implied heavy | **~25–50 MB packs, 1.5–2 GB models, 22 GB gate** — policy, not physics (§4.1) |
| Measured false positives | **False negatives too** (§12), plus the affordance that makes skipping safe |
| Phase 1 = 1.5 weeks | **2.5–3 weeks** — v1's number had been nudged, not re-derived |
| "Slang mode" (auto route) | Deleted — it contradicted the §4.3 decision it survived |
