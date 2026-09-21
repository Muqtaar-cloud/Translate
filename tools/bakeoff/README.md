# Phase 0b harness — the quality gate

Nothing else in this project starts until this passes. See [PLAN.md §6](../../docs/PLAN.md).

The gate exists because the failure this product dies of is not a broken
mechanism, it is translations that are not good enough to be worth reading. The
harness exists because the person building it cannot read the source languages,
so the rating has to come from somewhere honest.

## Commands

```bash
# Phase 0a — what this machine can actually do (PLAN.md §4.1, §4.2)
npx tsx tools/bakeoff/src/cli.ts probe "es->en,pt->en"

# Validate the pipeline before spending money or a rater's afternoon
npx tsx tools/bakeoff/src/cli.ts run corpus.jsonl echo

# The real run
npx tsx tools/bakeoff/src/cli.ts run corpus.jsonl ondevice,deepl,llm,selfhosted

# After raters fill in the sheet
npx tsx tools/bakeoff/src/cli.ts score tools/bakeoff/data/rating-sheet-filled.csv
```

`DEEPL_API_KEY` for the DeepL tier, `ANTHROPIC_API_KEY` (or an `ant auth login`
profile) for the LLM tier, `scripts/nllb_server.py` running for the self-hosted
tier.

## Corpus

JSONL, one message per line — see `fixtures/corpus.example.jsonl` for the shape.

```json
{"id":"m1","source":"es","text":"ya voy","context":["¿dónde estás?"]}
```

Real corpora go in `tools/bakeoff/data/`, which is gitignored. **These are other
people's messages** (PLAN.md §5.2): collect from a channel you would be
comfortable exporting, strip authors, and don't treat the corpus as exempt from
§5 for being "just a test". The benchmark is the first instance of the problem
§5 is about.

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
