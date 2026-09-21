import { mapLimit, type Engine, type EngineItem, type EngineOutput } from "./types.js";

/**
 * Self-hosted MT — the engine that decides whether the Telegram bot exists.
 *
 * PLAN.md §8: on a server there is no built-in Translator API and no viewport
 * to gate on, so every bot translation is a paid call unless a model is hosted.
 * If this tier clears the same bar as the on-device path, the bot is roughly
 * free at the margin and Phase 3 is viable; if it doesn't, the bot is a paid
 * cloud product and needs a decision it has never been given.
 *
 * Take NLLB-200 distilled rather than Opus-MT: one multilingual model handles
 * an arbitrary language mix directly, where per-pair models mean preloading a
 * matrix or eating cold starts — and arbitrary mixes are the bot's whole
 * premise. See scripts/nllb_server.py.
 */
export class SelfHostedEngine implements Engine {
  readonly name: string;
  readonly usesContext = false;
  private baseUrl: string;

  constructor(baseUrl = "http://127.0.0.1:8765", name = "nllb-200-distilled") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.name = name;
  }

  async translate(items: EngineItem[]): Promise<EngineOutput[]> {
    return mapLimit(items, 2, (item) => this.one(item));
  }

  private async one(item: EngineItem): Promise<EngineOutput> {
    try {
      const response = await fetch(`${this.baseUrl}/translate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: item.masked, source: item.source, target: item.target }),
      });

      if (!response.ok) {
        return { id: item.id, output: "", error: `${response.status} ${response.statusText}` };
      }

      const body = (await response.json()) as { translation?: string };
      return { id: item.id, output: body.translation ?? "" };
    } catch (error) {
      return {
        id: item.id,
        output: "",
        error: `${String(error)} (is scripts/nllb_server.py running?)`,
      };
    }
  }
}
