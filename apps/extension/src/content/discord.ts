import type { AdapterHealth, ExtractedMessage, PlatformAdapter } from "./adapter.js";

/**
 * Discord web.
 *
 * Every selector here is an `id` prefix, a `data-*` attribute or a structural
 * relationship. None is a styling class: Discord's class names are build-time
 * hashes that change without notice, and selecting on them is how an adapter
 * breaks weekly instead of yearly.
 *
 * Keeping them in one table is deliberate — when Discord ships a redesign, this
 * is the only block that needs reading.
 */
const SEL = {
  /** Scroll container, in priority order. */
  roots: ['[data-list-id="chat-messages"]', 'main [role="log"]', 'main [role="list"]'],
  /** A message row. Discord renders `id="chat-messages-<channel>-<id>"`. */
  message: 'li[id^="chat-messages-"]',
  /** Body text. `id="message-content-<id>"`. */
  content: '[id^="message-content-"]',
  /** Embeds, link previews, poll bodies. Not translated in v1 (PLAN.md §4.6). */
  accessories: '[id^="message-accessories-"]',
  /** The inline quoted message on a reply. Inherits the quoted message's layer. */
  replyContext: '[id^="message-reply-context-"]',
  /** Author name, when the row carries one (grouped messages often don't). */
  username: '[id^="message-username-"]',
} as const;

/** `chat-messages-<channelId>-<messageId>` -> the message id. */
export function messageIdFrom(domId: string): string | null {
  const m = /^chat-messages-(?:\d+-)?(\d+)$/.exec(domId);
  return m?.[1] ?? null;
}

/** `/channels/<guild>/<channel>` -> a stable conversation key. */
export function conversationIdFrom(url: URL): string {
  const m = /^\/channels\/(@me|\d+)\/(\d+)/.exec(url.pathname);
  return m ? `discord:${m[1]}/${m[2]}` : "discord:unknown";
}

/** True for a DM or group DM, which PLAN.md §5 excludes from cloud by default. */
export function isDirectMessage(conversationId: string): boolean {
  return conversationId.startsWith("discord:@me/");
}

export class DiscordAdapter implements PlatformAdapter {
  readonly name = "discord";
  private url: () => URL;

  constructor(url: () => URL = () => new URL(globalThis.location.href)) {
    this.url = url;
  }

  matches(url: URL): boolean {
    return url.hostname === "discord.com" && url.pathname.startsWith("/channels/");
  }

  observeRoot(doc: Document): Element | null {
    for (const selector of SEL.roots) {
      const el = doc.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  findMessages(root: Element): HTMLElement[] {
    return [...root.querySelectorAll<HTMLElement>(SEL.message)];
  }

  extract(el: HTMLElement): ExtractedMessage | null {
    const id = messageIdFrom(el.id);
    if (!id) return null;

    const content = el.querySelector<HTMLElement>(SEL.content);
    if (!content) return null;

    // Clone so removing the parts we don't translate can't touch the live DOM.
    const clone = content.cloneNode(true) as HTMLElement;
    for (const selector of [SEL.accessories, SEL.replyContext]) {
      clone.querySelectorAll(selector).forEach((n) => n.remove());
    }
    // Our own layer must never become part of the next extraction.
    clone.querySelectorAll("polyglot-layer").forEach((n) => n.remove());

    const text = (clone.textContent ?? "").trim();
    if (text === "") return null;

    const author = el.querySelector<HTMLElement>(SEL.username)?.textContent?.trim();

    return {
      id,
      text,
      ...(author ? { author } : {}),
      conversationId: conversationIdFrom(this.url()),
    };
  }

  injectionPoint(el: HTMLElement): { parent: Element; before: Node | null } | null {
    const content = el.querySelector<HTMLElement>(SEL.content);
    if (!content?.parentElement) return null;
    // Immediately after the body text, and before any embed — the translation
    // belongs to the message, not to its link preview.
    return { parent: content.parentElement, before: content.nextSibling };
  }

  selfCheck(doc: Document): AdapterHealth {
    const root = this.observeRoot(doc);
    if (!root) {
      return {
        ok: false,
        rootFound: false,
        messagesFound: 0,
        extractableFound: 0,
        detail: "No message list found. Discord's layout may have changed.",
      };
    }

    const messages = this.findMessages(root);
    const extractable = messages.filter((m) => this.extract(m) !== null).length;

    // A root with messages but nothing extractable means the content selector
    // rotted while the list selector survived — the most likely partial break.
    const ok = messages.length === 0 || extractable > 0;

    return {
      ok,
      rootFound: true,
      messagesFound: messages.length,
      extractableFound: extractable,
      detail: ok
        ? `${extractable}/${messages.length} messages readable`
        : `Found ${messages.length} messages but could read none of them.`,
    };
  }
}
