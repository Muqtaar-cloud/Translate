import { mapLimit, type Engine, type EngineItem, type EngineOutput } from "./types.js";

/**
 * DeepL, the cloud-MT tier.
 *
 * DeepL exposes a `context` parameter — context is not translated and is not
 * billed. That is exactly why PLAN.md §5.1 states the context rule as a rule:
 * there is no cost pressure against quietly enabling it for every automatically
 * translated message, so nothing but a decision stops it.
 *
 * This engine therefore refuses to send context at all. The bake-off measures
 * the automatic path as the automatic path will actually run.
 */
export class DeepLEngine implements Engine {
  readonly name = "deepl";
  readonly usesContext = false;
  private key: string;
  private endpoint: string;

  constructor(key: string) {
    this.key = key;
    // Free keys end in ":fx" and use a different host.
    this.endpoint = key.endsWith(":fx")
      ? "https://api-free.deepl.com/v2/translate"
      : "https://api.deepl.com/v2/translate";
  }

  async translate(items: EngineItem[]): Promise<EngineOutput[]> {
    return mapLimit(items, 4, (item) => this.one(item));
  }

  private async one(item: EngineItem): Promise<EngineOutput> {
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `DeepL-Auth-Key ${this.key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: [item.masked],
          source_lang: item.source.toUpperCase(),
          target_lang: item.target.toUpperCase(),
          // Deliberately no `context` field. See the class comment.
        }),
      });

      if (!response.ok) {
        return { id: item.id, output: "", error: `${response.status} ${response.statusText}` };
      }

      const body = (await response.json()) as { translations?: { text: string }[] };
      return { id: item.id, output: body.translations?.[0]?.text ?? "" };
    } catch (error) {
      return { id: item.id, output: "", error: String(error) };
    }
  }
}
