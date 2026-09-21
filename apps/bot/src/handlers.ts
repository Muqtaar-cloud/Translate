import { detectLanguage, type Detector } from "./detect.js";
import type { Store } from "./store.js";
import type { TelegramClient, TelegramMessage, TelegramUpdate } from "./telegram.js";
import { BudgetExhausted, type TranslationService } from "./translate.js";

/**
 * Update handling.
 *
 * The bot's cost defence lives here, and it is the thing that does not carry
 * over from the extension. The extension gates on the viewport: it translates
 * what someone is actually looking at, so cost tracks attention. A bot has no
 * viewport and cannot know who is reading. Its equivalent is **demand gating**
 * — translate when someone asks, by replying `/tr` to a message.
 *
 * Eager mode (translate everything) exists, is per-chat, and is off by default.
 * Turning it on removes the only bound the bot has, so it says so when enabled.
 */

export const NOTICE = [
  "Polyglot is now in this chat.",
  "",
  "It translates messages on request: reply /tr to any message and I'll post a",
  "translation for everyone who has set a language with /lang.",
  "",
  "What you should know before using it: translated messages are sent to a",
  "translation service, and they pass through the server running this bot.",
  "That includes other people's messages, and they have not agreed to it —",
  "whoever added me made that choice on the group's behalf.",
  "",
  "The bot does not store message text. It stores only which language each",
  "person wants to read.",
  "",
  "/help for the rest.",
].join("\n");

export const HELP = [
  "/lang <code> — read this chat in that language (e.g. /lang en)",
  "/lang off — stop receiving translations here",
  "/tr — reply to a message to translate it",
  "/auto on|off — admins: translate every message (off by default)",
  "/status — what's set up in this chat",
].join("\n");

export interface HandlerDeps {
  client: TelegramClient;
  store: Store;
  service: TranslationService;
  botId: number;
  allowEager: boolean;
  detect?: Detector;
}

const LANG = /^[a-z]{2}(-[a-z]{2})?$/i;

export class Handlers {
  private deps: HandlerDeps;
  private detect: Detector;

  constructor(deps: HandlerDeps) {
    this.deps = deps;
    this.detect = deps.detect ?? detectLanguage;
  }

  async handle(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message?.chat) return;

    if (message.new_chat_members?.some((m) => m.id === this.deps.botId)) {
      await this.onJoin(message);
      return;
    }

    const text = message.text?.trim();
    if (!text) return;

    if (text.startsWith("/")) {
      await this.command(message, text);
      return;
    }

    await this.onPlainMessage(message, text);
  }

  private async onJoin(message: TelegramMessage): Promise<void> {
    // Posted once, and it is the consent story: an admin added the bot
    // visibly, on the group's behalf. That is better than the extension can
    // offer — and the notice also says what it costs, because members' messages
    // now pass through someone's server.
    if (this.deps.store.chat(message.chat.id).noticeShown) return;
    await this.deps.client.sendMessage(message.chat.id, NOTICE);
    this.deps.store.markNoticeShown(message.chat.id);
  }

  private async command(message: TelegramMessage, text: string): Promise<void> {
    // Strip the @botname suffix Telegram adds in groups.
    const [rawCommand = "", ...args] = text.split(/\s+/);
    const command = rawCommand.split("@")[0]?.toLowerCase() ?? "";
    const chatId = message.chat.id;
    const userId = message.from?.id;

    switch (command) {
      case "/start":
      case "/help":
        await this.deps.client.sendMessage(chatId, HELP, message.message_id);
        return;

      case "/lang": {
        if (!userId) return;
        const value = (args[0] ?? "").toLowerCase();

        if (value === "off" || value === "") {
          this.deps.store.clearLanguage(chatId, userId);
          await this.deps.client.sendMessage(
            chatId,
            "You'll no longer get translations here.",
            message.message_id,
          );
          return;
        }
        if (!LANG.test(value)) {
          await this.deps.client.sendMessage(
            chatId,
            `"${value}" doesn't look like a language code. Try /lang en or /lang pt.`,
            message.message_id,
          );
          return;
        }

        this.deps.store.setLanguage(chatId, userId, value);
        await this.deps.client.sendMessage(
          chatId,
          `Reading this chat in ${value}. Reply /tr to any message to translate it.`,
          message.message_id,
        );
        return;
      }

      case "/tr":
        await this.onDemand(message);
        return;

      case "/auto": {
        if (!this.deps.allowEager) {
          await this.deps.client.sendMessage(
            chatId,
            "Eager translation is disabled on this instance.",
            message.message_id,
          );
          return;
        }
        const on = (args[0] ?? "").toLowerCase() === "on";
        this.deps.store.setEager(chatId, on);
        await this.deps.client.sendMessage(
          chatId,
          on
            ? "Translating every message in this chat. This removes the only limit on " +
                "what the bot costs and how much leaves the chat — /auto off to stop."
            : "Back to on-request only. Reply /tr to a message to translate it.",
          message.message_id,
        );
        return;
      }

      case "/status": {
        const chat = this.deps.store.chat(chatId);
        const targets = this.deps.store.targetLanguages(chatId);
        await this.deps.client.sendMessage(
          chatId,
          [
            `Mode: ${chat.eager ? "every message" : "on request (/tr)"}`,
            `Languages wanted here: ${targets.length > 0 ? targets.join(", ") : "none yet"}`,
            `People set up: ${this.deps.store.memberCount(chatId)}`,
          ].join("\n"),
          message.message_id,
        );
        return;
      }

      default:
        return; // Not ours. Other bots live here too.
    }
  }

  /** The demand gate: someone asked for this specific message. */
  private async onDemand(message: TelegramMessage): Promise<void> {
    const target = message.reply_to_message;
    const chatId = message.chat.id;

    if (!target?.text) {
      await this.deps.client.sendMessage(
        chatId,
        "Reply /tr to the message you want translated.",
        message.message_id,
      );
      return;
    }

    const targets = this.deps.store.targetLanguages(chatId);
    if (targets.length === 0) {
      await this.deps.client.sendMessage(
        chatId,
        "Nobody here has set a language yet. Try /lang en.",
        message.message_id,
      );
      return;
    }

    await this.translateAndPost(chatId, target, targets);
  }

  private async onPlainMessage(message: TelegramMessage, text: string): Promise<void> {
    if (!this.deps.allowEager) return;
    if (!this.deps.store.chat(message.chat.id).eager) return;
    if (message.from?.is_bot) return; // never translate our own output back

    const targets = this.deps.store.targetLanguages(message.chat.id);
    if (targets.length === 0) return;

    await this.translateAndPost(message.chat.id, { ...message, text }, targets);
  }

  private async translateAndPost(
    chatId: number,
    message: TelegramMessage,
    targets: string[],
  ): Promise<void> {
    const text = message.text ?? "";
    const detected = this.detect(text)[0];

    if (!detected) {
      await this.deps.client.sendMessage(
        chatId,
        "I can't tell what language that is — too short, or not one I recognise.",
        message.message_id,
      );
      return;
    }

    try {
      const results = await this.deps.service.translateFor(
        text,
        detected.lang,
        targets,
        chatId,
      );

      if (results.length === 0) return; // everyone already reads the source

      const body = results
        .map((r) => `${r.target.toUpperCase()}: ${r.text}`)
        .join("\n");
      await this.deps.client.sendMessage(chatId, body, message.message_id);
    } catch (error) {
      if (error instanceof BudgetExhausted) {
        await this.deps.client.sendMessage(
          chatId,
          "Daily translation budget spent. It resets tomorrow.",
          message.message_id,
        );
        return;
      }
      await this.deps.client.sendMessage(
        chatId,
        "Translation failed. The translator may be down.",
        message.message_id,
      );
    }
  }
}
