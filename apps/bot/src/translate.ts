import { mask, restore, route, today, type Availability, type RoutingPolicy } from "@polyglot/core";
import type { Store } from "./store.js";

/**
 * Translation for the bot.
 *
 * This is where the shared package's neutrality gets tested. The bot has no
 * built-in translator, no viewport, and no user paying for their own reading —
 * so it exercises exactly the assumptions the extension could have baked in
 * without noticing.
 *
 * The mapping that makes `@polyglot/core` work here: **"local" means free at
 * the margin for whoever is asking.** In the extension that is a downloaded
 * language pack. Here it is a self-hosted model on the same box. Same
 * economics, different mechanism, and the routing code does not need to know
 * which.
 */

export interface Provider {
  readonly name: string;
  /** True when this provider costs money per character. */
  readonly metered: boolean;
  translate(text: string, source: string, target: string): Promise<string>;
}

/**
 * Self-hosted NLLB-200 (see tools/bakeoff/scripts/nllb_server.py).
 *
 * The whole argument for the bot's viability: pay for the box, not per
 * character. If its quality does not clear the Phase 0b bar, the bot is a paid
 * cloud product and needs a decision it has not been given.
 */
export class SelfHostedProvider implements Provider {
  readonly name = "nllb-selfhosted";
  readonly metered = false;
  private baseUrl: string;
  private fetchImpl: typeof fetch;

  constructor(baseUrl: string, fetchImpl: typeof fetch = fetch) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
  }

  async translate(text: string, source: string, target: string): Promise<string> {
    const response = await this.fetchImpl(`${this.baseUrl}/translate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, source, target }),
    });
    if (!response.ok) throw new Error(`self-hosted translator: ${response.status}`);
    const body = (await response.json()) as { translation?: string };
    return body.translation ?? "";
  }

  async healthy(): Promise<boolean> {
    try {
      return (await this.fetchImpl(`${this.baseUrl}/health`)).ok;
    } catch {
      return false;
    }
  }
}

export class DeepLProvider implements Provider {
  readonly name = "deepl";
  readonly metered = true;
  private key: string;
  private endpoint: string;
  private fetchImpl: typeof fetch;

  constructor(key: string, fetchImpl: typeof fetch = fetch) {
    this.key = key;
    this.endpoint = key.endsWith(":fx")
      ? "https://api-free.deepl.com/v2/translate"
      : "https://api.deepl.com/v2/translate";
    this.fetchImpl = fetchImpl;
  }

  async translate(text: string, source: string, target: string): Promise<string> {
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: { Authorization: `DeepL-Auth-Key ${this.key}`, "content-type": "application/json" },
      body: JSON.stringify({
        text: [text],
        source_lang: source.toUpperCase(),
        target_lang: target.toUpperCase(),
        // No `context` field, for the same reason as everywhere else: context is
        // unbilled, so only a rule stops it riding along on every message.
      }),
    });
    if (!response.ok) throw new Error(`deepl: ${response.status}`);
    const body = (await response.json()) as { translations?: { text: string }[] };
    return body.translations?.[0]?.text ?? "";
  }
}

export interface TranslationResult {
  target: string;
  text: string;
  provider: string;
  /** Characters billed. Zero for a self-hosted or cached translation. */
  billed: number;
}

export class TranslationService {
  private providers: Provider[];
  private store: Store;
  private dailyCharLimit: number;
  private glossary: readonly string[];
  /** Keyed by provider + pair + text. Deduplicates a repeated message. */
  private cache = new Map<string, string>();

  constructor(opts: {
    providers: Provider[];
    store: Store;
    dailyCharLimit: number;
    glossary?: readonly string[];
  }) {
    this.providers = opts.providers;
    this.store = opts.store;
    this.dailyCharLimit = opts.dailyCharLimit;
    this.glossary = opts.glossary ?? [];
  }

  private free(): Provider | undefined {
    return this.providers.find((p) => !p.metered);
  }

  private paid(): Provider | undefined {
    return this.providers.find((p) => p.metered);
  }

  /**
   * `knownLanguages` means "languages the reader already reads", and that is an
   * extension-shaped assumption: there is one reader there, so one list.
   *
   * A bot has many readers with different lists, so no single value is correct.
   * Passing the source language here — the obvious-looking choice — makes
   * `route` skip every translation, because it reads as "the reader already
   * reads Spanish" rather than "this message is Spanish". The per-recipient
   * version of that check is the `target !== sourceLanguage` filter in
   * `translateFor`, so the list is empty here on purpose.
   */
  private policy(): RoutingPolicy {
    const free = this.free();
    const paid = this.paid();
    return {
      knownLanguages: [],
      cloudEnabled: Boolean(paid),
      ...(paid ? { cloudProvider: paid.name } : {}),
      // "available" here means a free-at-the-margin provider can serve the
      // pair — the bot's analogue of a downloaded pack. There is no
      // `downloadable` state on a server: a model is either running or not.
      availability: (): Availability => (free ? "available" : "unavailable"),
    };
  }

  /**
   * Translates one message into every language the chat actually needs.
   *
   * Bounded by *distinct target languages*, not by member count. A 40-person
   * group reading five languages costs up to four translations per message,
   * not forty — which is the difference between cost scaling with diversity
   * and cost scaling with membership.
   */
  async translateFor(
    text: string,
    sourceLanguage: string,
    targets: readonly string[],
    chatId: number,
  ): Promise<TranslationResult[]> {
    const wanted = [...new Set(targets)].filter((t) => t !== sourceLanguage);
    const results: TranslationResult[] = [];

    for (const target of wanted) {
      const decision = route(
        { text, source: sourceLanguage, target, initiation: "automatic" },
        this.policy(),
      );

      if (decision.kind === "skip" || decision.kind === "unsupported") continue;
      // A server never sees `needs-pack-download`; if it somehow did, the same
      // rule applies as everywhere else — it is not a licence to spend money.
      if (decision.kind === "needs-pack-download") continue;

      const provider =
        decision.kind === "local"
          ? this.free()
          : this.providers.find((p) => p.name === decision.provider);
      if (!provider) continue;

      const { masked, spans } = mask(text, { protect: this.glossary });
      const key = `${provider.name}|${sourceLanguage}|${target}|${masked}`;

      const cached = this.cache.get(key);
      if (cached !== undefined) {
        results.push({
          target,
          text: restore(cached, spans).text,
          provider: provider.name,
          billed: 0,
        });
        continue;
      }

      if (provider.metered) {
        const day = today();
        // Checked before the request. A budget enforced afterwards is a report.
        if (this.store.usageToday(day) + masked.length > this.dailyCharLimit) {
          throw new BudgetExhausted(chatId);
        }
      }

      const raw = await provider.translate(masked, sourceLanguage, target);
      this.cache.set(key, raw);

      const billed = provider.metered ? masked.length : 0;
      if (billed > 0) this.store.recordUsage(today(), billed);

      results.push({ target, text: restore(raw, spans).text, provider: provider.name, billed });
    }

    return results;
  }
}

export class BudgetExhausted extends Error {
  constructor(public chatId: number) {
    super("daily translation budget exhausted");
    this.name = "BudgetExhausted";
  }
}
