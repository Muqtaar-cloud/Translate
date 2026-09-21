# Polyglot bot (Phase 3)

A Telegram bot that translates on request. Sanctioned by the Bot API, reaches
every member on every device, and needs no DOM maintenance.

```bash
export TELEGRAM_BOT_TOKEN=...          # from @BotFather
export NLLB_URL=http://127.0.0.1:8765  # self-hosted; free at the margin
# or: export DEEPL_API_KEY=...         # paid per character
npx tsx apps/bot/src/index.ts
```

`ALLOW_EAGER=true` permits per-chat eager mode. `DB_PATH`, `DAILY_CHAR_LIMIT`
tune the rest. The bot refuses to start with no translator configured — on a
server there is no free local fallback to quietly rely on.

## Commands

| | |
|---|---|
| `/lang <code>` | Read this chat in that language |
| `/lang off` | Stop receiving translations here |
| `/tr` | Reply to a message to translate it |
| `/auto on\|off` | Admins: translate every message (off by default) |
| `/status` | What's set up in this chat |

## What does not carry over from the extension

**There is no viewport, so there is no viewport gating.** The extension
translates what someone is looking at, so cost tracks attention. A bot cannot
know who is reading. Its cost defence is **demand gating**: translate when
someone replies `/tr`. Eager mode exists, is per-chat, off by default, and says
what it removes when you turn it on.

**There is no on-device translator.** Every translation is self-hosted or paid.
`SelfHostedProvider` (NLLB-200, see `tools/bakeoff/scripts/nllb_server.py`) is
what makes the bot free at the margin; without it every message is billed.

**There is no language detector.** The browser hands the extension one. A
server has none, and NLLB needs an explicit source language, so `detect.ts` is a
hand-rolled heuristic — script ranges plus stopwords plus orthographic cues.
It is weaker than the browser's, and weakest on short messages, which is most of
chat. That is a real quality gap between the two products.

**Fan-out is bounded by distinct languages, not members.** A 40-person group
reading five languages costs four translations per message, not forty.

**It is infrastructure.** A process, a database, a schema, an uptime story.
None of that existed when the browser owned the lifecycle.

## Privacy: better consent, worse custody

An admin adds the bot visibly, on the group's behalf — better consent than the
extension can offer. But members' messages then pass through whoever runs the
server, and they did not agree to that. The join notice says both, in those
words.

The bot stores who reads what. It does not store message text, anywhere, and
there is a test asserting the tables cannot hold any.

## Not resolved

The plan gates Phase 3 on the bake-off: if self-hosted MT does not clear the
same bar as the on-device path, the bot is a paid cloud product and needs a
decision it has not been given. That gate has not run. The self-hosted provider
is wired and tested against a fake; its **translation quality is unmeasured**,
and so is whether the economics work.
