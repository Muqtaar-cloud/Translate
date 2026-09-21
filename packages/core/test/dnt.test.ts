import { describe, expect, it } from "vitest";
import { mask, restore, survivalRate, SPOILER_MARK } from "../src/dnt.js";

describe("DNT masking (§3, §12)", () => {
  it("masks and restores a Discord-flavoured message unchanged", () => {
    const text = "hey <@123> check <#456> and :tada: at https://x.com/a?b=1#c `npm i`";
    const { masked, spans } = mask(text);

    expect(masked).not.toContain("<@123>");
    expect(masked).not.toContain("https://");
    expect(spans.length).toBeGreaterThanOrEqual(5);

    const { text: out, missing } = restore(masked, spans);
    expect(out).toBe(text);
    expect(missing).toEqual([]);
  });

  it("keeps fenced code intact, including its contents", () => {
    const text = "try:\n```js\nconst a = `x`;\n```\nok?";
    const { masked, spans } = mask(text);
    expect(spans[0]).toBe("```js\nconst a = `x`;\n```");
    expect(restore(masked, spans).text).toBe(text);
  });

  it("does not mistake a URL fragment for a channel reference", () => {
    const { spans } = mask("see https://example.com/docs#install");
    expect(spans).toEqual(["https://example.com/docs#install"]);
  });

  it("reports which spans an engine dropped", () => {
    const { masked, spans } = mask("ping <@1> and <@2>");
    // Simulate an engine that ate the second placeholder.
    const mangled = masked.replace("⟦1⟧", "");
    const result = restore(mangled, spans);
    expect(result.missing).toEqual([1]);
    expect(survivalRate(result, spans.length)).toBe(0.5);
  });

  it("survives text with no DNT spans", () => {
    const { masked, spans } = mask("buenos días a todos");
    expect(spans).toEqual([]);
    expect(restore(masked, spans).text).toBe("buenos días a todos");
    expect(survivalRate(restore(masked, spans), 0)).toBe(1);
  });

  it("accepts an alternative placeholder style, since which one survives is empirical", () => {
    const opts = { placeholder: (i: number) => `<x${i}/>` };
    const { masked, spans } = mask("hi <@7>", opts);
    expect(masked).toBe("hi <x0/>");
    expect(restore(masked, spans, opts).text).toBe("hi <@7>");
  });
});

describe("glossary protection", () => {
  it("protects a literal term from translation", () => {
    const { masked, spans } = mask("ship Polyglot on friday", { protect: ["Polyglot"] });
    expect(masked).not.toContain("Polyglot");
    expect(spans).toContain("Polyglot");
    expect(restore(masked, spans).text).toBe("ship Polyglot on friday");
  });

  it("matches case-insensitively but restores what was written", () => {
    const { masked, spans } = mask("ship polyglot now", { protect: ["Polyglot"] });
    expect(masked).not.toContain("polyglot");
    expect(restore(masked, spans).text).toBe("ship polyglot now");
  });

  // Otherwise a shorter term eats the start of a longer one and the rest of the
  // phrase gets translated anyway.
  it("protects the longest matching term first", () => {
    const { masked, spans } = mask("the Polyglot Core team", {
      protect: ["Polyglot", "Polyglot Core"],
    });
    expect(spans).toContain("Polyglot Core");
    expect(restore(masked, spans).text).toBe("the Polyglot Core team");
  });

  it("treats terms as literals, not patterns", () => {
    const { masked, spans } = mask("costs $5 (roughly)", { protect: ["$5 (roughly)"] });
    expect(restore(masked, spans).text).toBe("costs $5 (roughly)");
  });

  it("ignores blank glossary entries", () => {
    expect(mask("hola", { protect: ["", "   "] }).spans).toEqual([]);
  });

  it("coexists with the built-in DNT patterns", () => {
    const text = "ping <@1> about Polyglot at https://x.com";
    const { masked, spans } = mask(text, { protect: ["Polyglot"] });
    expect(masked).not.toContain("Polyglot");
    expect(masked).not.toContain("<@1>");
    expect(restore(masked, spans).text).toBe(text);
  });
});

// The adapter substitutes SPOILER_MARK for hidden text. If an engine translates
// or drops it, the redaction turns into a word or vanishes, and the layer stops
// showing that something was withheld.
describe("spoiler mark", () => {
  it("is masked like any other do-not-translate span", () => {
    const text = `el final es ${SPOILER_MARK}`;
    const { masked, spans } = mask(text);
    expect(masked).not.toContain(SPOILER_MARK);
    expect(spans).toContain(SPOILER_MARK);
    expect(restore(masked, spans).text).toBe(text);
  });

  it("survives an engine that reorders the sentence", () => {
    const { masked, spans } = mask(`el final es ${SPOILER_MARK}`);
    const asIfTranslated = masked.replace("el final es ", "the ending is ");
    const out = restore(asIfTranslated, spans);
    expect(out.text).toBe(`the ending is ${SPOILER_MARK}`);
    expect(out.missing).toEqual([]);
  });

  it("is reported missing when an engine eats it", () => {
    const { spans } = mask(`el final es ${SPOILER_MARK}`);
    expect(restore("the ending is", spans).missing).toEqual([0]);
  });
});
