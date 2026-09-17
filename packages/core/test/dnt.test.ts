import { describe, expect, it } from "vitest";
import { mask, restore, survivalRate } from "../src/dnt.js";

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
