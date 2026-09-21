// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { ContextPolicyError, MAX_CONTEXT_MESSAGES } from "@polyglot/core";
import { fixture } from "./fixture.js";
import { DiscordAdapter } from "../src/content/discord.js";
import { buildEscalation, collectContext } from "../src/content/escalate.js";

const FIXTURE = fixture("discord-messages.html");
let adapter: DiscordAdapter;
let root: Element;

beforeEach(() => {
  document.body.innerHTML = FIXTURE;
  adapter = new DiscordAdapter(() => new URL("https://discord.com/channels/555/100"));
  root = adapter.observeRoot(document)!;
});

describe("collectContext", () => {
  it("returns the messages before the target, oldest first", () => {
    expect(collectContext(adapter, root, "900003")).toEqual([
      "¿vienes mañana a la fiesta?",
      "jajaja <@123> otra vez con lo mismo :facepalm: https://example.com/a",
    ]);
  });

  it("is empty for the first message in the channel", () => {
    expect(collectContext(adapter, root, "900001")).toEqual([]);
  });

  it("stops at the target rather than including it or anything after", () => {
    const context = collectContext(adapter, root, "900002");
    expect(context).toEqual(["¿vienes mañana a la fiesta?"]);
  });

  // PLAN.md §5.1: "N messages, no media, no author ids, hard-bounded."
  it("never exceeds the bound, however long the channel is", () => {
    const list = document.querySelector('[data-list-id="chat-messages"]')!;
    for (let i = 0; i < 40; i++) {
      const li = document.createElement("li");
      li.id = `chat-messages-100-96${String(i).padStart(4, "0")}`;
      li.innerHTML = `<div id="message-content-96${String(i).padStart(4, "0")}">relleno ${i}</div>`;
      list.insertBefore(li, list.querySelector('li[id$="-900003"]'));
    }

    expect(collectContext(adapter, root, "900003")).toHaveLength(MAX_CONTEXT_MESSAGES);
  });

  it("carries message bodies only — no author names, ids or timestamps", () => {
    // Each line is exactly the message body. The author ("ana") appears in the
    // DOM beside every one of these and must not be carried along with it.
    // Asserting equality rather than absence, because "ana" is a substring of
    // "mañana" and a naive contains-check would pass for the wrong reason.
    expect(collectContext(adapter, root, "900003")).toEqual([
      "¿vienes mañana a la fiesta?",
      "jajaja <@123> otra vez con lo mismo :facepalm: https://example.com/a",
    ]);
  });

  it("excludes embeds, since extraction already does", () => {
    const context = collectContext(adapter, root, "900005");
    expect(context.join(" ")).not.toContain("Embedded article title");
  });
});

describe("buildEscalation", () => {
  const base = { text: "sí, ese" };

  it("marks the request as user-initiated", () => {
    const request = buildEscalation(base, "es", "en", ["¿quién viene?"]);
    expect(request.initiation).toBe("user");
    expect(request.contextWindow).toEqual(["¿quién viene?"]);
  });

  it("truncates an oversized context to the bound rather than rejecting it", () => {
    const long = Array.from({ length: 20 }, (_, i) => `m${i}`);
    const request = buildEscalation(base, "es", "en", long);
    expect(request.contextWindow).toHaveLength(MAX_CONTEXT_MESSAGES);
    // Keeps the most recent, which is the context that actually disambiguates.
    expect(request.contextWindow?.at(-1)).toBe("m19");
  });

  it("builds a valid request with no context at all", () => {
    expect(() => buildEscalation(base, "es", "en", [])).not.toThrow();
  });

  // The guard exists to catch the one drift that would go unnoticed: this path
  // being wired to something automatic, which would start sending the preceding
  // messages off-device on every translation.
  it("the policy guard rejects context on an automatic request", async () => {
    const { assertContextPolicy } = await import("@polyglot/core");
    expect(() =>
      assertContextPolicy({
        text: "sí, ese",
        source: "es",
        target: "en",
        initiation: "automatic",
        contextWindow: ["¿quién viene?"],
      }),
    ).toThrow(ContextPolicyError);
  });
});
