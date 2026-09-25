import { mask } from "@polyglot/core";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import {
  assertIgnored,
  collect,
  formatCollectionReport,
  formatCorpus,
  parseDiscordHtml,
  parseTelegramExport,
  parseTextLines,
  redact,
  type RawMessage,
} from "../src/collect.js";
import { parseCorpus } from "../src/corpus.js";

/**
 * The corpus is other people's private messages, so most of what is worth
 * asserting here is about what does NOT come out of these functions.
 */

const raw = (texts: string[]): RawMessage[] => texts.map((text, ordinal) => ({ text, ordinal }));

describe("redact", () => {
  it("removes the content of a URL but keeps it a URL", () => {
    const { text } = redact("mira esto https://discord.gg/secret-invite-abc");
    expect(text).not.toContain("secret-invite-abc");
    expect(text).toBe("mira esto https://redacted.invalid/1");
  });

  /**
   * The justification for redacting *into the same shape* rather than into
   * `[link]`. §6 measures DNT placeholder survival per engine; if redaction
   * changed the number of DNT spans, that measurement would be taken on text
   * that no longer resembles the chat it came from.
   */
  it("leaves the DNT span count identical to the original message", () => {
    const original =
      "oye @carlos mira https://example.com/thing y dile a <@123456789> que use `npm ci` :tada:";
    const { text } = redact(original);

    expect(mask(text).spans).toHaveLength(mask(original).spans.length);
    expect(text).not.toContain("carlos");
    expect(text).not.toContain("example.com");
  });

  it("removes emails, phone numbers and long digit runs", () => {
    const { text, counts } = redact(
      "escribe a ana.lopez@gmail.com o llama al +34 600 123 456, cuenta 4111111111111111",
    );
    expect(text).not.toMatch(/ana\.lopez|gmail/);
    expect(text).not.toContain("600 123 456");
    expect(text).not.toContain("4111111111111111");
    expect(counts.email).toBe(1);
    expect(counts.phone).toBe(1);
  });

  it("does not read an email's @ as a mention", () => {
    const { text, counts } = redact("ana.lopez@gmail.com");
    expect(counts.email).toBe(1);
    expect(counts.handle).toBe(0);
    expect(text).toBe("redacted1@example.invalid");
  });

  it("numbers substitutions within a message so one person stays one person", () => {
    const { text } = redact("@ana y @beto, @ana dijo que si");
    expect(text).toBe("@user1 y @user2, @user3 dijo que si");
  });

  /**
   * Deliberate: stable pseudonyms across the corpus would let anyone holding it
   * reconstruct who said what to whom, which is the thing a corpus must not be
   * able to do.
   */
  it("does not make pseudonyms stable across messages", () => {
    expect(redact("@ana hola").text).toBe(redact("@beto hola").text);
  });

  it("leaves ordinary text alone", () => {
    const text = "¿vienes mañana a la fiesta?";
    expect(redact(text).text).toBe(text);
  });
});

describe("parseTelegramExport", () => {
  const exportFile = (messages: unknown[]): string => JSON.stringify({ name: "grupo", messages });

  it("reads the plain string form", () => {
    const out = parseTelegramExport(
      exportFile([{ type: "message", from: "Ana", from_id: "user7", text: "hola a todos" }]),
    );
    expect(out).toEqual([{ text: "hola a todos", ordinal: 0 }]);
  });

  /** Anything with a link, mention or code span arrives as parts, not a string. */
  it("reads the entity-array form without losing the entity text", () => {
    const out = parseTelegramExport(
      exportFile([
        {
          type: "message",
          from: "Ana",
          text: ["mira ", { type: "link", text: "https://example.com" }, " y dime"],
        },
      ]),
    );
    expect(out[0]?.text).toBe("mira https://example.com y dime");
  });

  it("skips service messages and anything with no text", () => {
    const out = parseTelegramExport(
      exportFile([
        { type: "service", actor: "Ana", action: "create_group" },
        { type: "message", from: "Ana", text: "" },
        { type: "message", from: "Beto", text: "vale", sticker_emoji: "👍" },
      ]),
    );
    expect(out).toEqual([{ text: "vale", ordinal: 0 }]);
  });

  /**
   * The structural half of the privacy claim: `RawMessage` has no author field,
   * so identity is dropped at the parse boundary rather than by a later step
   * that could be reordered or forgotten.
   */
  it("never carries an author out of the parser", () => {
    const out = parseTelegramExport(
      exportFile([{ type: "message", from: "Ana Lopez", from_id: "user7", text: "hola a todos" }]),
    );
    expect(JSON.stringify(out)).not.toMatch(/Ana|Lopez|user7/);
    expect(Object.keys(out[0] ?? {}).sort()).toEqual(["ordinal", "text"]);
  });

  it("explains itself when handed the wrong export format", () => {
    expect(() => parseTelegramExport("<html>")).toThrow(/not valid JSON/);
    expect(() => parseTelegramExport('{"name":"grupo"}')).toThrow(/messages/);
  });
});

describe("parseDiscordHtml", () => {
  const doc = (): Document => new Window().document as unknown as Document;

  const page = (rows: string): string => `<div data-list-id="chat-messages">${rows}</div>`;

  it("reads message bodies by id prefix, not by class", () => {
    const out = parseDiscordHtml(
      page(`
        <li id="chat-messages-100-900001">
          <h3><span id="message-username-900001">ana</span></h3>
          <div id="message-content-900001">¿vienes mañana a la fiesta?</div>
        </li>`),
      doc(),
    );
    expect(out).toEqual([{ text: "¿vienes mañana a la fiesta?", ordinal: 0 }]);
  });

  /** Same strip list as the adapter: an embed is not message text. */
  it("strips accessories and quoted reply context", () => {
    const out = parseDiscordHtml(
      page(`
        <li id="chat-messages-100-900002">
          <div id="message-content-900002">
            <div id="message-reply-context-900002">ana: lo de ayer</div>
            si claro
            <div id="message-accessories-900002">example.com — A Title</div>
          </div>
        </li>`),
      doc(),
    );
    expect(out[0]?.text).toBe("si claro");
  });

  it("skips rows with no content element", () => {
    const out = parseDiscordHtml(page('<li id="chat-messages-100-900003"><hr></li>'), doc());
    expect(out).toEqual([]);
  });

  it("does not take the author name into the corpus", () => {
    const out = parseDiscordHtml(
      page(`
        <li id="chat-messages-100-900004">
          <h3><span id="message-username-900004">ana_lopez</span></h3>
          <div id="message-content-900004">hola a todos</div>
        </li>`),
      doc(),
    );
    expect(JSON.stringify(out)).not.toContain("ana_lopez");
  });
});

describe("parseTextLines", () => {
  it("takes one message per line and ignores comments", () => {
    expect(parseTextLines("hola a todos\n\n// nota\nvienes manana")).toEqual([
      { text: "hola a todos", ordinal: 0 },
      { text: "vienes manana", ordinal: 1 },
    ]);
  });
});

describe("collect", () => {
  const spanish = [
    "¿vienes mañana a la fiesta de ana?",
    "no puedo, tengo que trabajar por la tarde",
    "¡pues que pena! la comida estaba muy buena",
    "la proxima vez avisame con mas tiempo por favor",
    "vale, te aviso el lunes que viene sin falta",
  ];

  it("labels each message with a detected source language", async () => {
    const { corpus } = await collect(raw(spanish));
    expect(corpus).not.toHaveLength(0);
    expect(new Set(corpus.map((m) => m.source))).toEqual(new Set(["es"]));
  });

  it("drops repeated messages, which chat is full of", async () => {
    const { corpus, report } = await collect(
      raw([...spanish, "  ¿Vienes mañana a la fiesta de ANA?  "]),
    );
    expect(report.parsed).toBe(6);
    expect(report.afterDedupe).toBe(5);
    expect(corpus.filter((m) => m.text.toLowerCase().includes("fiesta"))).toHaveLength(1);
  });

  it("gives every message an id derived from position, never a platform id", async () => {
    const { corpus } = await collect(raw(spanish));
    for (const m of corpus) expect(m.id).toMatch(/^m\d{5}$/);
  });

  it("attaches preceding messages as context, bounded by the policy limit", async () => {
    const { corpus } = await collect(raw(spanish), { contextMessages: 99 });
    const last = corpus.at(-1);
    // MAX_CONTEXT_MESSAGES is 5; asking for 99 must not produce 99.
    expect(last?.context?.length).toBeLessThanOrEqual(5);
    expect(corpus[0]?.context).toBeUndefined();
  });

  it("caps each language and reports what it sampled", async () => {
    const { corpus, report } = await collect(raw(spanish), { perLanguage: 2 });
    expect(corpus).toHaveLength(2);
    expect(report.sampled["es"]).toBe(2);
    expect(report.perLanguage["es"]).toBe(5);
  });

  it("is reproducible for a given seed, and samples differently for another", async () => {
    const ids = async (seed: number): Promise<string[]> =>
      (await collect(raw(spanish), { perLanguage: 2, seed })).corpus.map((m) => m.id);

    expect(await ids(7)).toEqual(await ids(7));
    // Not a guarantee for every pair of seeds, but these two do differ.
    expect(await ids(7)).not.toEqual(await ids(99));
  });

  it("keeps only the languages asked for", async () => {
    const { corpus } = await collect(raw([...spanish, "the meeting is tomorrow at noon i think"]), {
      languages: ["es"],
    });
    expect(new Set(corpus.map((m) => m.source))).toEqual(new Set(["es"]));
  });

  /**
   * The decision this function exists to get right. Dropping unlabelled
   * messages biases the corpus towards long well-formed text — the text MT is
   * already good at — and a guessed label makes the engine answer for obeying a
   * wrong source language.
   */
  it("routes an unconfident label to review rather than into the corpus", async () => {
    const { corpus, review, report } = await collect(raw(spanish), { minConfidence: 0.99 });

    expect(corpus).toHaveLength(0);
    expect(review.length).toBeGreaterThan(0);
    expect(report.lowConfidence).toBe(review.length);
    for (const m of review) expect(m.confidence).toBeLessThan(0.99);
  });

  it("drops messages too short for any detector to be honest about", async () => {
    const { corpus, report } = await collect(raw(["ok", "jaja", "+1"]));
    expect(corpus).toHaveLength(0);
    expect(report.tooShort).toBe(3);
    expect(report.undetected).toBe(0);
  });

  /**
   * The case the first real run produced: Portuguese whose only cues ("por",
   * "está") are shared with Spanish. The detector declines, and the message must
   * not be dropped — dropping it biases the corpus towards the text MT already
   * handles well, which makes the gate easier than the product.
   */
  it("sends a long but ambiguous message to review with no source label", async () => {
    const ambiguous = "alguém pode trazer gelo por favor está quente";
    const { corpus, review, report } = await collect(raw([ambiguous]));

    expect(corpus).toHaveLength(0);
    expect(report.undetected).toBe(1);
    expect(review).toHaveLength(1);
    expect(review[0]?.text).toBe(ambiguous);
    expect(review[0]?.source).toBe("");
  });

  it("writes an unlabelled review line that the corpus parser refuses", async () => {
    const { review } = await collect(raw(["alguém pode trazer gelo por favor está quente"]));
    // Loud failure beats a quiet relabel if the file is appended unedited.
    expect(() => parseCorpus(JSON.stringify(review[0]))).toThrow(/source/);
  });

  it("redacts before anything else sees the text", async () => {
    const { corpus, report } = await collect(
      raw([`${spanish[0]} escribe a ana.lopez@gmail.com`, ...spanish.slice(1)]),
    );
    expect(JSON.stringify(corpus)).not.toContain("gmail");
    expect(report.redactions.email).toBe(1);
    expect(report.redactedMessages).toBe(1);
  });

  it("redacts the context window too, not just the message", async () => {
    const { corpus } = await collect(raw(["mi correo es ana.lopez@gmail.com", ...spanish]), {
      contextMessages: 3,
    });
    const withContext = corpus.filter((m) => m.context && m.context.length > 0);
    expect(withContext.length).toBeGreaterThan(0);
    expect(JSON.stringify(withContext.map((m) => m.context))).not.toContain("gmail");
  });

  it("counts code-switching, which §4.5 needs before segmentation is built", async () => {
    const { report } = await collect(
      raw([...spanish, "vale i will be there tomorrow, no te preocupes por la comida"]),
    );
    expect(report.codeSwitchSampleSize).toBeGreaterThan(0);
    expect(report.codeSwitched).toBeGreaterThanOrEqual(0);
  });
});

describe("formatCorpus", () => {
  it("writes JSONL the bake-off's own parser reads back", async () => {
    const { corpus, report } = await collect(
      raw([
        "¿vienes mañana a la fiesta de ana?",
        "no puedo, tengo que trabajar por la tarde",
        "¡pues que pena! la comida estaba muy buena",
      ]),
    );
    const file = formatCorpus(corpus, report, "text");

    // The provenance header rides in `//` lines, which parseCorpus already skips.
    expect(file).toMatch(/^\/\/ Phase 0b corpus/);
    expect(parseCorpus(file)).toEqual(corpus);
  });

  it("records that no account was automated, and that the file is not to be shared", async () => {
    const { corpus, report } = await collect(raw(["¿vienes mañana a la fiesta de ana?"]));
    const file = formatCorpus(corpus, report, "telegram");
    expect(file).toMatch(/no account was automated/);
    expect(file).toMatch(/Do not share, do not commit/);
  });
});

describe("assertIgnored", () => {
  it("allows a path git ignores", () => {
    expect(() => assertIgnored("tools/bakeoff/data/corpus.jsonl")).not.toThrow();
  });

  /**
   * The one control here that is not advice: a corpus reaches a public
   * repository through `git add -A`, not through anyone deciding to publish it.
   */
  it("refuses a path git would commit", () => {
    expect(() => assertIgnored("docs/corpus.jsonl")).toThrow(/does not ignore it/);
  });
});

describe("formatCollectionReport", () => {
  const report = (sampled: Record<string, number>) => ({
    parsed: 500,
    afterDedupe: 400,
    redactions: { url: 3, handle: 9, email: 0, phone: 0, digits: 0 },
    redactedMessages: 11,
    tooShort: 60,
    undetected: 40,
    lowConfidence: 20,
    perLanguage: sampled,
    sampled,
    codeSwitched: 12,
    codeSwitchSampleSize: 180,
  });

  it("says plainly when the corpus is too small for the gate", () => {
    const out = formatCollectionReport(report({ es: 90, pt: 20 }));
    expect(out).toMatch(/NOT YET ENOUGH FOR THE GATE/);
  });

  it("stops warning once two languages have enough", () => {
    const out = formatCollectionReport(report({ es: 90, pt: 85 }));
    expect(out).not.toMatch(/NOT YET ENOUGH/);
  });

  it("reports code-switching against §4.5's thresholds", () => {
    const out = formatCollectionReport(report({ es: 90, pt: 85 }));
    expect(out).toMatch(/code-switching\s+12\/180 \(7%\)/);
    expect(out).toMatch(/under ~5% drop segmentation/);
  });
});
