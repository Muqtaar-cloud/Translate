import { beforeEach, describe, expect, it, vi } from "vitest";
import { Handlers, NOTICE } from "../src/handlers.js";
import { Store } from "../src/store.js";
import { TelegramClient, type TelegramMessage, type Transport } from "../src/telegram.js";
import { TranslationService, type Provider } from "../src/translate.js";

/**
 * Everything here runs against a fake transport: no token, no network, and no
 * real group's messages. The bot is the one consumer that handles other
 * people's words on someone else's behalf, so its tests should not need any.
 */
const BOT_ID = 4242;

let sent: { chatId: number; text: string; replyTo?: number }[];
let store: Store;
let handlers: Handlers;
let translateCalls: { text: string; source: string; target: string }[];

function fakeTransport(): Transport {
  return async (method, payload) => {
    if (method === "sendMessage") {
      const p = payload as { chat_id: number; text: string; reply_to_message_id?: number };
      sent.push({
        chatId: p.chat_id,
        text: p.text,
        ...(p.reply_to_message_id ? { replyTo: p.reply_to_message_id } : {}),
      });
      return { message_id: sent.length };
    }
    if (method === "getMe") return { id: BOT_ID, username: "polyglotbot" };
    return [];
  };
}

class FakeProvider implements Provider {
  constructor(
    readonly name: string,
    readonly metered: boolean,
  ) {}
  async translate(text: string, source: string, target: string): Promise<string> {
    translateCalls.push({ text, source, target });
    return `${target.toUpperCase()}(${text})`;
  }
}

function build(
  opts: { allowEager?: boolean; providers?: Provider[]; dailyCharLimit?: number } = {},
): void {
  sent = [];
  translateCalls = [];
  store = new Store(":memory:");
  const providers = opts.providers ?? [new FakeProvider("nllb-selfhosted", false)];
  handlers = new Handlers({
    client: new TelegramClient(fakeTransport()),
    store,
    service: new TranslationService({
      providers,
      store,
      dailyCharLimit: opts.dailyCharLimit ?? 100_000,
    }),
    botId: BOT_ID,
    allowEager: opts.allowEager ?? false,
  });
}

const msg = (over: Partial<TelegramMessage> = {}): TelegramMessage => ({
  message_id: 1,
  chat: { id: -100, type: "supergroup" },
  from: { id: 7, first_name: "ana" },
  ...over,
});

const update = (message: TelegramMessage) => ({ update_id: 1, message });
const lastText = (): string => sent.at(-1)?.text ?? "";

beforeEach(() => build());

describe("joining a chat", () => {
  it("posts the consent notice once", async () => {
    const join = msg({ new_chat_members: [{ id: BOT_ID }] });
    await handlers.handle(update(join));
    await handlers.handle(update(join));

    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe(NOTICE);
  });

  // The bot's consent story is better than the extension's — an admin added it
  // visibly — but its custody story is worse, and the notice has to say both.
  it("states that messages pass through the server and that members did not agree", async () => {
    await handlers.handle(update(msg({ new_chat_members: [{ id: BOT_ID }] })));
    expect(lastText()).toMatch(/pass through the server/);
    expect(lastText()).toMatch(/have not agreed/);
    expect(lastText()).toMatch(/does not store message text/);
  });

  it("ignores other people joining", async () => {
    await handlers.handle(update(msg({ new_chat_members: [{ id: 99 }] })));
    expect(sent).toHaveLength(0);
  });
});

describe("/lang", () => {
  it("records a language and confirms", async () => {
    await handlers.handle(update(msg({ text: "/lang en" })));
    expect(store.languageOf(-100, 7)).toBe("en");
    expect(lastText()).toContain("Reading this chat in en");
  });

  it("accepts the @botname suffix Telegram adds in groups", async () => {
    await handlers.handle(update(msg({ text: "/lang@polyglotbot pt" })));
    expect(store.languageOf(-100, 7)).toBe("pt");
  });

  it("rejects something that is not a language code", async () => {
    await handlers.handle(update(msg({ text: "/lang klingon" })));
    expect(store.languageOf(-100, 7)).toBeNull();
    expect(lastText()).toMatch(/doesn't look like a language code/);
  });

  it("turns translations off for one person", async () => {
    await handlers.handle(update(msg({ text: "/lang en" })));
    await handlers.handle(update(msg({ text: "/lang off" })));
    expect(store.languageOf(-100, 7)).toBeNull();
  });
});

describe("demand gating — the bot's cost defence", () => {
  const spanish = msg({ message_id: 50, text: "¿vienes mañana a la fiesta?" });

  beforeEach(async () => {
    await handlers.handle(update(msg({ text: "/lang en" })));
    sent = [];
    translateCalls = [];
  });

  // The extension gates on the viewport. A bot has none, so this is the only
  // thing standing between it and translating every message in every chat.
  it("translates nothing until someone asks", async () => {
    await handlers.handle(update(spanish));
    expect(translateCalls).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("translates the replied-to message on /tr", async () => {
    await handlers.handle(
      update(msg({ message_id: 51, text: "/tr", reply_to_message: spanish })),
    );

    expect(translateCalls).toHaveLength(1);
    expect(translateCalls[0]?.source).toBe("es");
    expect(lastText()).toContain("EN(¿vienes mañana a la fiesta?)");
  });

  it("replies to the message being translated, not the command", async () => {
    await handlers.handle(
      update(msg({ message_id: 51, text: "/tr", reply_to_message: spanish })),
    );
    expect(sent.at(-1)?.replyTo).toBe(50);
  });

  it("explains itself when /tr is not a reply", async () => {
    await handlers.handle(update(msg({ text: "/tr" })));
    expect(translateCalls).toHaveLength(0);
    expect(lastText()).toMatch(/Reply \/tr to the message/);
  });

  it("says so when nobody has set a language", async () => {
    store.clearLanguage(-100, 7);
    await handlers.handle(
      update(msg({ message_id: 51, text: "/tr", reply_to_message: spanish })),
    );
    expect(translateCalls).toHaveLength(0);
    expect(lastText()).toMatch(/Nobody here has set a language/);
  });

  it("declines to guess when it cannot tell the language", async () => {
    await handlers.handle(
      update(
        msg({
          message_id: 51,
          text: "/tr",
          reply_to_message: msg({ message_id: 52, text: "ok" }),
        }),
      ),
    );
    // A wrong source language produces confident nonsense, in public.
    expect(translateCalls).toHaveLength(0);
    expect(lastText()).toMatch(/can't tell what language/);
  });
});

describe("fan-out", () => {
  // Bounded by distinct languages, not by member count: this is what keeps the
  // bot's cost scaling with diversity instead of with membership.
  it("translates once per distinct language, not once per person", async () => {
    for (const [userId, lang] of [
      [1, "en"],
      [2, "en"],
      [3, "en"],
      [4, "pt"],
    ] as const) {
      store.setLanguage(-100, userId, lang);
    }
    sent = [];

    const spanish = msg({ message_id: 50, text: "¿vienes mañana a la fiesta?" });
    await handlers.handle(
      update(msg({ message_id: 51, text: "/tr", reply_to_message: spanish })),
    );

    expect(translateCalls.map((c) => c.target).sort()).toEqual(["en", "pt"]);
    expect(store.memberCount(-100)).toBe(4);
  });

  it("does not translate a message into its own language", async () => {
    store.setLanguage(-100, 1, "es");
    const spanish = msg({ message_id: 50, text: "¿vienes mañana a la fiesta?" });
    await handlers.handle(
      update(msg({ message_id: 51, text: "/tr", reply_to_message: spanish })),
    );
    expect(translateCalls).toHaveLength(0);
  });
});

describe("eager mode", () => {
  it("is refused when the instance disallows it", async () => {
    await handlers.handle(update(msg({ text: "/auto on" })));
    expect(store.chat(-100).eager).toBe(false);
    expect(lastText()).toMatch(/disabled on this instance/);
  });

  it("warns about what it removes when enabled", async () => {
    build({ allowEager: true });
    await handlers.handle(update(msg({ text: "/auto on" })));
    expect(store.chat(-100).eager).toBe(true);
    expect(lastText()).toMatch(/removes the only limit/);
  });

  it("translates plain messages once on", async () => {
    build({ allowEager: true });
    await handlers.handle(update(msg({ text: "/lang en" })));
    await handlers.handle(update(msg({ text: "/auto on" })));
    translateCalls = [];

    await handlers.handle(update(msg({ message_id: 60, text: "¿vienes mañana a la fiesta?" })));
    expect(translateCalls).toHaveLength(1);
  });

  it("never translates its own output back", async () => {
    build({ allowEager: true });
    await handlers.handle(update(msg({ text: "/lang en" })));
    await handlers.handle(update(msg({ text: "/auto on" })));
    translateCalls = [];

    await handlers.handle(
      update(
        msg({
          message_id: 61,
          text: "¿vienes mañana a la fiesta?",
          from: { id: BOT_ID, is_bot: true },
        }),
      ),
    );
    expect(translateCalls).toHaveLength(0);
  });

  it("stays off by default even when the instance allows it", async () => {
    build({ allowEager: true });
    await handlers.handle(update(msg({ text: "/lang en" })));
    translateCalls = [];
    await handlers.handle(update(msg({ message_id: 60, text: "¿vienes mañana a la fiesta?" })));
    expect(translateCalls).toHaveLength(0);
  });
});

describe("budget", () => {
  it("stops before spending past the daily limit, and says so", async () => {
    build({ providers: [new FakeProvider("deepl", true)], dailyCharLimit: 5 });
    await handlers.handle(update(msg({ text: "/lang en" })));

    const spanish = msg({ message_id: 50, text: "¿vienes mañana a la fiesta?" });
    await handlers.handle(
      update(msg({ message_id: 51, text: "/tr", reply_to_message: spanish })),
    );

    expect(translateCalls).toHaveLength(0);
    expect(lastText()).toMatch(/budget spent/);
  });

  it("does not meter a self-hosted translator", async () => {
    await handlers.handle(update(msg({ text: "/lang en" })));
    const spanish = msg({ message_id: 50, text: "¿vienes mañana a la fiesta?" });
    await handlers.handle(
      update(msg({ message_id: 51, text: "/tr", reply_to_message: spanish })),
    );
    // Free at the margin is the entire argument for the bot existing.
    expect(store.usageToday(new Date().toISOString().slice(0, 10))).toBe(0);
  });
});

describe("resilience", () => {
  it("reports a translator failure instead of going quiet", async () => {
    const broken: Provider = {
      name: "nllb-selfhosted",
      metered: false,
      translate: vi.fn(async () => {
        throw new Error("connection refused");
      }),
    };
    build({ providers: [broken] });
    await handlers.handle(update(msg({ text: "/lang en" })));

    const spanish = msg({ message_id: 50, text: "¿vienes mañana a la fiesta?" });
    await handlers.handle(
      update(msg({ message_id: 51, text: "/tr", reply_to_message: spanish })),
    );
    expect(lastText()).toMatch(/Translation failed/);
  });

  it("ignores commands meant for other bots", async () => {
    await handlers.handle(update(msg({ text: "/weather london" })));
    expect(sent).toHaveLength(0);
  });

  it("ignores messages with no text", async () => {
    await handlers.handle(update(msg({})));
    expect(sent).toHaveLength(0);
  });
});
