# Polyglot

In-place translation for multilingual group chats — read Discord in your
language without leaving the conversation.

Translations render *underneath* the original message, never replacing it.
On-device translation by default, so no message content leaves the machine on
the automatic path. Cloud engines are opt-in with your own API keys, and LLM
translation happens only when you ask for it, per message.

**Status:** planning, v3. See [docs/PLAN.md](docs/PLAN.md).

The plan describes two products and decides them separately: a tool for one
person (Discord web, unlisted) and a public product (store review, arbitrary
languages, other people's privacy). v1 is the first. A Telegram bot and a public
release are each gated on evidence the plan says how to collect — a translation
quality bake-off with bilingual raters, and an estimate of how many people can
actually run it.
