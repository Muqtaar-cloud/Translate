import { SPOILER_MARK } from "@polyglot/core";
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
  /**
   * A spoiler. ARIA first, as everywhere else in this table; the class
   * substring is a deliberate exception to the no-styling-classes rule,
   * because missing a spoiler prints hidden text in the clear rather than
   * breaking something cosmetic. Matching both means a rename of either
   * does not leak. Whether a given match is *revealed* is decided in
   * `extract`, not here.
   */
  spoilers: '[role="button"][aria-expanded], [class*="spoiler" i]',
  /** Author name, when the row carries one (grouped messages often don't). */
  username: '[id^="message-username-"]',
  /**
   * The message box, in priority order. Discord's composer is a Slate editor;
   * `data-slate-editor` is its own marker and the most stable hook available.
   */
  composers: [
    '[data-slate-editor="true"]',
    'div[role="textbox"][contenteditable="true"]',
    'form div[role="textbox"]',
  ],
} as const;

/**
 * Elements that imply a line break around their contents.
 *
 * A tag list rather than computed styles: extraction runs against detached
 * clones and inside happy-dom, where layout does not exist.
 */
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  "DIV", "P", "LI", "UL", "OL", "BLOCKQUOTE", "PRE", "HR", "TABLE", "TR",
  "H1", "H2", "H3", "H4", "H5", "H6",
]);

/**
 * Text with line structure preserved.
 *
 * `textContent` concatenates text nodes and inserts nothing at `<br>` or at a
 * block boundary, so a two-line message arrives as one run with its lines
 * jammed together — "holaadios" — corrupting the engine's input before any
 * translation happens. Shift+Enter is ordinary in chat, so this is the normal
 * case rather than an edge one.
 */
export function textOf(node: Node): string {
  let out = "";
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === child.TEXT_NODE) {
      out += child.nodeValue ?? "";
      continue;
    }
    if (child.nodeType !== child.ELEMENT_NODE) continue;

    const el = child as HTMLElement;
    if (el.tagName === "BR") {
      out += "\n";
      continue;
    }

    const inner = textOf(el);
    if (!BLOCK_TAGS.has(el.tagName)) {
      out += inner;
      continue;
    }
    if (out !== "" && !out.endsWith("\n")) out += "\n";
    out += inner;
    if (!out.endsWith("\n")) out += "\n";
  }
  return out;
}

/** Trailing spaces and runs of blank lines go; deliberate breaks stay. */
const normalizeLines = (s: string): string =>
  s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

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

    // Unrevealed spoilers are replaced, not removed: dropping them would leave
    // "el final es" and read as a broken sentence, while keeping them would
    // print in the layer what Discord is deliberately hiding above it. A
    // spoiler the user has already opened is theirs to read, so it translates
    // normally — and because the revealed text changes the node key, the
    // reveal re-translates the message on its own.
    clone.querySelectorAll(SEL.spoilers).forEach((n) => {
      if (n.closest('[aria-expanded="true"]')) return;
      n.replaceWith(clone.ownerDocument.createTextNode(SPOILER_MARK));
    });

    const text = normalizeLines(textOf(clone));
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

  findComposer(doc: Document): HTMLElement | null {
    for (const selector of SEL.composers) {
      const el = doc.querySelector<HTMLElement>(selector);
      if (el) return el;
    }
    return null;
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
