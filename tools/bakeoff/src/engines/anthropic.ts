import Anthropic from "@anthropic-ai/sdk";
import { mapLimit, type Engine, type EngineItem, type EngineOutput } from "./types.js";

/**
 * The LLM tier of the bake-off (PLAN.md §6).
 *
 * In the product this is a per-message user escalation, never the automatic
 * path (§4.3), and it is the only tier permitted to see thread context (§5.1).
 * The bake-off models it that way so the measured latency and cost belong to
 * the path that will actually bear them.
 *
 * Note for scoring: §6 forbids using an LLM to judge this tier — that would be
 * circular. LLM-as-judge is for the on-device and DeepL tiers only.
 */
export class AnthropicEngine implements Engine {
  readonly name: string;
  readonly usesContext = true;
  private client: Anthropic;
  private model: string;

  constructor(opts: { model?: string; name?: string } = {}) {
    this.client = new Anthropic();
    this.model = opts.model ?? "claude-opus-5";
    this.name = opts.name ?? `llm:${this.model}`;
  }

  async translate(items: EngineItem[]): Promise<EngineOutput[]> {
    return mapLimit(items, 4, (item) => this.one(item));
  }

  private async one(item: EngineItem): Promise<EngineOutput> {
    const context = item.context?.length
      ? `Preceding messages in the channel, oldest first:\n${item.context
          .map((c) => `- ${c}`)
          .join("\n")}\n\n`
      : "";

    const prompt =
      `${context}Translate this ${item.source} group-chat message into ${item.target}.\n\n` +
      `Message:\n${item.masked}\n\n` +
      `Rules:\n` +
      `- This is casual group chat. Preserve the register, tone and humour; do not formalise it.\n` +
      `- Placeholders that look like ⟦0⟧, ⟦1⟧ are mentions, emoji, code or URLs. ` +
      `Reproduce them exactly and in a sensible position. Never translate or renumber them.\n` +
      `- Output only the translation. No quotes, no notes, no preamble.`;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 2048, // chat messages are short; deliberately capped
        thinking: { type: "adaptive" },
        output_config: { effort: "low" },
        messages: [{ role: "user", content: prompt }],
      });

      if (response.stop_reason === "refusal") {
        return { id: item.id, output: "", error: "refusal" };
      }

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();

      return { id: item.id, output: text };
    } catch (error) {
      const message =
        error instanceof Anthropic.APIError
          ? `${error.status}: ${error.message}`
          : String(error);
      return { id: item.id, output: "", error: message };
    }
  }
}
