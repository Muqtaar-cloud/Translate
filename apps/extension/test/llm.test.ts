import { describe, expect, it, vi } from "vitest";
import type { TranslationRequest } from "@polyglot/core";
import { translateWithLlm } from "../src/background/llm.js";

async function promptFor(source: string): Promise<string> {
  let body = "";
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    body = String(init?.body ?? "");
    return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 });
  });
  const request: TranslationRequest = { text: "kya kar rahe ho", source, target: "en", initiation: "user" };
  await translateWithLlm(request, "test-key", fetchImpl as unknown as typeof fetch);
  return (JSON.parse(body) as { messages: { content: string }[] }).messages[0]?.content ?? "";
}

describe("the LLM prompt", () => {
  it("names a detected source language", async () => {
    expect(await promptFor("es")).toContain("Translate this es group-chat message into en.");
  });

  /** Romanised or mixed text is exactly what the detector cannot place. */
  it("asks the model to identify an undetected language, mentioning romanised text", async () => {
    const prompt = await promptFor("auto");
    expect(prompt).not.toContain("Translate this auto");
    expect(prompt).toContain("identify it yourself");
    expect(prompt).toContain("Latin letters");
  });
});
