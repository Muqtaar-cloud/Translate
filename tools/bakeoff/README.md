# Phase 0b harness — the quality gate

Nothing else in this project starts until this passes. See [PLAN.md §6](../../docs/PLAN.md).

The gate exists because the failure this product dies of is not a broken
mechanism, it is translations that are not good enough to be worth reading. The
harness exists because the person building it cannot read the source languages,
so the rating has to come from somewhere honest.

## Commands

```bash
# Phase 0a — what this machine can actually do (PLAN.md §4.1, §4.2)
npm run probe                     # or: ... cli.ts probe "es->en,pt->en"

# Build the corpus from an export the platform's own client produced
npm run collect telegram ~/Downloads/Telegram/result.json
npm run collect discord-html ~/saved-channel.html
LANGUAGES=es,pt PER_LANGUAGE=100 npm run collect telegram result.json

# Validate the pipeline before spending money or a rater's afternoon
npx tsx tools/bakeoff/src/cli.ts run corpus.jsonl echo

# The real run
npx tsx tools/bakeoff/src/cli.ts run corpus.jsonl ondevice,deepl,llm,selfhosted

# After raters fill in their sheets (one per language, one rater each)
npx tsx tools/bakeoff/src/cli.ts score filled.es.csv filled.pt.csv
```

`DEEPL_API_KEY` for the DeepL tier, `ANTHROPIC_API_KEY` (or an `ant auth login`
profile) for the LLM tier, `scripts/nllb_server.py` running for the self-hosted
tier.

## Corpus

JSONL, one message per line — see `fixtures/corpus.example.jsonl` for the shape.

```json
{"id":"m1","source":"es","text":"ya voy","context":["¿dónde estás?"]}
```

`collect` builds this from a file the platform's own client produced. **No
account is automated and no platform API is called** — §7 is explicit that
reading the DOM in my own browser is ordinary behaviour while driving an account
is not, and Discord bans self-bots. So the sources are:

| Source | Where the file comes from |
|---|---|
| `telegram` | Telegram Desktop → Settings → Advanced → Export, or one chat's "Export chat history", format **JSON** |
| `discord-html` | a channel page saved from your own browser (Ctrl+S) after scrolling back as far as you want |
| `text` | one message per line, pasted by hand |

**DiscordChatExporter is not supported on purpose.** It is the first thing a
search turns up and it drives your own account token against Discord's API,
which is exactly what §7 says not to do.

### What `collect` does with the messages

- **Authors never enter the pipeline.** The parsers discard identity at the
  boundary — there is no author field to forget to strip later.
- **Redaction runs before anything is written**, and substitutes *into the same
  shape*: a real URL becomes a fake URL, a mention becomes a mention. That keeps
  the DNT span count identical to real chat, so the placeholder-survival number
  is measured on text that still resembles its input.
- Substitutions are numbered within a message, never stable across the corpus —
  stable pseudonyms would let a holder reconstruct who said what to whom.
- **A message it cannot confidently label goes to a review file, not the
  corpus and not the bin.** Dropping biases the corpus towards long well-formed
  text, which MT already handles well, making the gate easier than the product.
  A guessed label is worse: engines are *told* the source language, so a wrong
  label makes the engine answer for obeying it. Messages under 15 characters are
  dropped and counted, because no label for them would be honest.
- Output must be in a git-ignored path, **enforced** rather than documented: a
  corpus reaches a public repository via `git add -A`, not via a decision.

What it cannot do: names in prose. "ana, vienes?" is a person's name in a message
body and no mechanical pass finds that reliably. Read the corpus before it goes
anywhere, treat "don't share it" as the default, and delete it once 0b is
decided.

## What the harness does and does not decide

**Does:** masks DNT spans with the real `@polyglot/core` code before any engine
sees the corpus, so engines are scored on translation rather than on an unmasked
baseline every one of them would mangle. Counts placeholder survival
mechanically. Builds a **blinded, shuffled** rating sheet so a rater cannot rate
the engine instead of the output. Computes Wilson intervals and a coarse verdict.

**Does not:** decide whether the translations are good. That is the rater's job,
and the method is fixed in §6 — bilingual raters first, LLM-as-judge only for
the non-LLM tiers (judging the LLM tier with an LLM is circular), and
back-translation rejected outright, because a fluent-but-wrong translation
back-translates fluently and that is precisely the failure being hunted.

## Gold rows: checking the rater, not just the engines

`run` writes one sheet per source language, since each rater reads one, and
mixes about 5% **gold rows** into each (at least 4, at most 20). A gold row is
message A's original beside message B's real translation. It reads fluently,
it sounds casual, and it says the wrong thing, so its known answer is
`meaning_preserved = n`. It is built this way because the person running the
harness cannot read the source language, so hand-written reference translations
are not an option. A mismatch can be built for any language.

Gold rows look like every other row. Only `rating-key.csv` marks them, and they
never count towards any engine's score. The rater instructions say that checks
exist without saying which rows they are.

`score` reports, per sheet, how many traps the rater caught. **If any rater
catches fewer than 80%, the gate is not decided.** It does not quietly drop that
language and score the rest, because that would change the verdict without
anyone deciding it should. Re-rate with another rater.

The gap: a rater who marks *everything* wrong passes every trap. Known-good
rows would catch that, but they need someone who reads the language to write
them. The report warns instead when a rater marked 95% or more of real rows
wrong, and asks for a 20-row spot-check before a FAIL is accepted.

Row ids follow display order (`es-1`, `es-2`, ...). They used to follow
generation order, which let anyone read engine groupings off the `row_id`
column and would have given away every gold row by its id.

## The verdict is deliberately coarse

At n≈100 the 95% interval on a proportion near 0.8 is about ±8 points, so "80%
versus 75%" is not a distinguishable difference and must not carry a ten-week
decision. The verdict is driven by the interval, not the point estimate:

| Verdict | Condition | Meaning |
|---|---|---|
| `good` | lower bound ≥ 75% | build |
| `bad` | upper bound ≤ 60% | stop |
| `marginal` | anything else | **stop** |

**Marginal is a stop, not a pass.** Marginal quality will not survive real use,
and it is the result most likely to be argued into a green light.

The gate is on the **automatic path**. A perfect LLM score cannot pass it — the
LLM is a per-message user escalation (§4.3), not the path most messages take.

## Two questions it answers for free

Both come off the same corpus, and both otherwise cost weeks:

- **Code-switching frequency** (§4.5) — under 5%, drop per-segment translation
  and the golden-set cases together; over 15%, build it, with evidence. Decided
  before the work, not after.
- **Self-hosted MT quality** (§8) — whether the Telegram bot is free at the
  margin or a paid cloud product. Eight weeks before Phase 3 would start.
