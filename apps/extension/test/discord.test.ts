// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { fixture } from "./fixture.js";
import {
  conversationIdFrom,
  DiscordAdapter,
  isDirectMessage,
  messageIdFrom,
} from "../src/content/discord.js";

const FIXTURE = fixture("discord-messages.html");

const at = (path: string): URL => new URL(`https://discord.com${path}`);

let adapter: DiscordAdapter;

beforeEach(() => {
  document.body.innerHTML = FIXTURE;
  adapter = new DiscordAdapter(() => at("/channels/555/100"));
});

describe("id parsing", () => {
  it("pulls the message id out of Discord's compound dom id", () => {
    expect(messageIdFrom("chat-messages-100-900001")).toBe("900001");
    expect(messageIdFrom("chat-messages-900001")).toBe("900001");
  });

  it("rejects ids that are not messages", () => {
    expect(messageIdFrom("chat-messages-")).toBeNull();
    expect(messageIdFrom("message-content-900001")).toBeNull();
  });

  it("builds a stable conversation key from the URL", () => {
    expect(conversationIdFrom(at("/channels/555/100"))).toBe("discord:555/100");
    expect(conversationIdFrom(at("/channels/@me/42"))).toBe("discord:@me/42");
    expect(conversationIdFrom(at("/store"))).toBe("discord:unknown");
  });

  // PLAN.md §5: DMs are excluded from cloud translation by default.
  it("identifies direct messages", () => {
    expect(isDirectMessage("discord:@me/42")).toBe(true);
    expect(isDirectMessage("discord:555/100")).toBe(false);
  });
});

describe("matches", () => {
  it("claims Discord channel pages and nothing else", () => {
    expect(adapter.matches(at("/channels/555/100"))).toBe(true);
    expect(adapter.matches(at("/store"))).toBe(false);
    expect(adapter.matches(new URL("https://example.com/channels/1/2"))).toBe(false);
  });
});

describe("findMessages", () => {
  it("finds the scroll container and every message in it", () => {
    const root = adapter.observeRoot(document);
    expect(root).not.toBeNull();
    expect(adapter.findMessages(root!)).toHaveLength(6);
  });

  it("returns null root when the page is not a chat view", () => {
    document.body.innerHTML = "<div>loading</div>";
    expect(adapter.observeRoot(document)).toBeNull();
  });
});

describe("extract", () => {
  const byId = (id: string): HTMLElement =>
    document.querySelector<HTMLElement>(`li[id$="-${id}"]`)!;

  it("pulls body text and author", () => {
    const m = adapter.extract(byId("900001"));
    expect(m).toEqual({
      id: "900001",
      text: "¿vienes mañana a la fiesta?",
      author: "ana",
      conversationId: "discord:555/100",
    });
  });

  // PLAN.md §4.6: embeds are explicitly not translated in v1.
  it("excludes embeds and link previews", () => {
    const m = adapter.extract(byId("900006"));
    expect(m?.text).toBe("mirad esto");
    expect(m?.text).not.toContain("Embedded article title");
  });

  it("excludes the quoted message on a reply", () => {
    const m = adapter.extract(byId("900005"));
    expect(m?.text).toBe("perfecto, te esperamos entonces");
    expect(m?.text).not.toContain("ya voy");
  });

  // Without this the layer's own text is re-extracted on the next mutation and
  // translated again, compounding on every pass.
  it("never re-reads its own injected layer", () => {
    const el = byId("900001");
    const layer = document.createElement("polyglot-layer");
    layer.textContent = "are you coming tomorrow?";
    el.querySelector("[id^=message-content-]")!.append(layer);

    expect(adapter.extract(el)?.text).toBe("¿vienes mañana a la fiesta?");
  });

  it("returns null for a message with no readable body", () => {
    const el = byId("900001");
    el.querySelector("[id^=message-content-]")!.remove();
    expect(adapter.extract(el)).toBeNull();
  });
});

describe("injectionPoint", () => {
  it("places the layer directly after the body and before any embed", () => {
    const el = document.querySelector<HTMLElement>('li[id$="-900006"]')!;
    const point = adapter.injectionPoint(el)!;
    const marker = document.createElement("polyglot-layer");
    point.parent.insertBefore(marker, point.before);

    const order = [...point.parent.children].map((c) => c.id || c.tagName.toLowerCase());
    expect(order.indexOf("polyglot-layer")).toBeLessThan(
      order.indexOf("message-accessories-900006"),
    );
    expect(order.indexOf("message-content-900006")).toBeLessThan(
      order.indexOf("polyglot-layer"),
    );
  });
});

// PLAN.md §10: breakage has to be detected, and the user has to be told.
describe("selfCheck", () => {
  it("is healthy on a normal page", () => {
    const health = adapter.selfCheck(document);
    expect(health.ok).toBe(true);
    expect(health.messagesFound).toBe(6);
    expect(health.extractableFound).toBe(6);
  });

  it("reports a missing message list", () => {
    document.body.innerHTML = "<div>something else entirely</div>";
    const health = adapter.selfCheck(document);
    expect(health.ok).toBe(false);
    expect(health.rootFound).toBe(false);
    expect(health.detail).toMatch(/may have changed/);
  });

  // The likeliest partial break: the list selector survives a redesign while
  // the content selector rots. Silently translating nothing is the failure.
  it("catches messages it can find but cannot read", () => {
    document.querySelectorAll("[id^=message-content-]").forEach((n) => {
      n.id = "msg-body-renamed";
    });
    const health = adapter.selfCheck(document);
    expect(health.ok).toBe(false);
    expect(health.rootFound).toBe(true);
    expect(health.messagesFound).toBe(6);
    expect(health.extractableFound).toBe(0);
  });

  it("does not call an empty channel broken", () => {
    document.querySelectorAll("li").forEach((n) => n.remove());
    expect(adapter.selfCheck(document).ok).toBe(true);
  });
});
