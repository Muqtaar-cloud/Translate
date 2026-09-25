import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { mapLimit, type Engine, type EngineItem, type EngineOutput } from "./types.js";

/**
 * Chrome's built-in Translator API, driven through a real browser.
 *
 * This is the engine the whole economic argument rests on (PLAN.md §4.1), and
 * it is also the Phase 0a capability probe: `probe()` reports what this machine
 * can actually do rather than what the documentation says it should.
 *
 * Two things it cannot paper over, both verified:
 *
 * 1. The API is unavailable in Web Workers, so it runs in page context here,
 *    exactly as it must run in a content script rather than the extension's
 *    service worker (§4.2).
 * 2. `create()` requires a user gesture when a language pack is not yet
 *    present. A headless run therefore cannot trigger a download — it can only
 *    report `downloadable`. That is a real property of the platform, not a
 *    limitation of this harness, and it is why Phase 1 needs a per-pair
 *    download UX instead of a silent warm-up.
 */
/**
 * Finds a full Chromium.
 *
 * The built-in AI APIs are not in the headless shell Playwright downloads by
 * default, so a bare `chromium.launch({})` fails on a machine that only has the
 * shell — which is what `npm run probe` did until this was measured, making the
 * first command in the plan the first one to break.
 *
 * Order: an explicit override, then whatever the sandbox has, then Playwright's
 * own install. Returns undefined for the last case so the caller can ask for the
 * `chromium` channel by name.
 *
 * This is deliberately a second copy of the resolver in
 * `apps/extension/scripts/smoke.mjs`, not a shared helper: that one is plain
 * `.mjs` run straight by node, this is a composite TS project with
 * `rootDir: "."`, and neither can import the other without reshaping the build
 * to share twenty lines. If a third consumer appears, share it properly.
 */
function resolveChromium(): string | undefined {
  const override = process.env["CHROMIUM_PATH"];
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`CHROMIUM_PATH is set to ${override} but nothing is there`);
    }
    return override;
  }

  const pool = "/opt/pw-browsers";
  if (existsSync(pool)) {
    const candidate = readdirSync(pool)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort()
      .reverse()
      .map((d) => resolve(pool, d, "chrome-linux/chrome"))
      .find((f) => existsSync(f));
    if (candidate) return candidate;
  }

  return undefined;
}

export interface ProbeResult {
  apiPresent: boolean;
  detectorPresent: boolean;
  pairs: Record<string, string>;
  note?: string;
}

export class OnDeviceEngine implements Engine {
  readonly name = "chrome-builtin";
  readonly usesContext = false;
  private browser: Browser | undefined;
  private page: Page | undefined;

  async open(): Promise<Page> {
    if (this.page) return this.page;
    const executablePath = resolveChromium();
    this.browser = await chromium.launch(
      executablePath
        ? { executablePath, headless: false, args: ["--headless=new", "--no-sandbox"] }
        : { channel: "chromium", headless: false, args: ["--headless=new", "--no-sandbox"] },
    );
    const context = await this.browser.newContext();
    this.page = await context.newPage();
    // about:blank has no origin and the API needs one, but reaching the real
    // network would make the probe depend on egress. Serve a stub at a real
    // https origin instead.
    await this.page.route("https://polyglot.invalid/**", (r) =>
      r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>probe</title>" }),
    );
    await this.page.goto("https://polyglot.invalid/");
    return this.page;
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = undefined;
    this.page = undefined;
  }

  /** Phase 0a. Run this before trusting any of §4.1 on this machine. */
  async probe(pairs: { source: string; target: string }[]): Promise<ProbeResult> {
    const page = await this.open();
    const result = await page.evaluate(async (pairList) => {
      const g = globalThis as unknown as {
        Translator?: { availability(o: unknown): Promise<string> };
        LanguageDetector?: unknown;
      };
      const out: Record<string, string> = {};
      if (g.Translator) {
        for (const p of pairList) {
          try {
            out[`${p.source}->${p.target}`] = await g.Translator.availability({
              sourceLanguage: p.source,
              targetLanguage: p.target,
            });
          } catch (e) {
            out[`${p.source}->${p.target}`] = `error: ${String(e)}`;
          }
        }
      }
      return {
        apiPresent: Boolean(g.Translator),
        detectorPresent: Boolean(g.LanguageDetector),
        pairs: out,
      };
    }, pairs);

    return {
      ...result,
      ...(result.apiPresent
        ? {}
        : {
            note:
              "Translator API absent. Expected on any Chromium without the built-in AI " +
              "components — including CI and most sandboxes. Run this on a real Chrome " +
              "138+ / Edge 148+ desktop profile before drawing conclusions about §4.1.",
          }),
    };
  }

  async translate(items: EngineItem[]): Promise<EngineOutput[]> {
    const page = await this.open();
    return mapLimit(items, 1, async (item) => {
      const r = await page.evaluate(
        async ({ masked, source, target }) => {
          const g = globalThis as unknown as {
            Translator?: {
              availability(o: unknown): Promise<string>;
              create(o: unknown): Promise<{ translate(t: string): Promise<string> }>;
            };
          };
          if (!g.Translator) return { output: "", error: "Translator API not present" };

          const availability = await g.Translator.availability({
            sourceLanguage: source,
            targetLanguage: target,
          });
          if (availability !== "available") {
            // Cannot be resolved headlessly: create() needs a user gesture.
            return { output: "", error: `availability=${availability}` };
          }

          try {
            const translator = await g.Translator.create({
              sourceLanguage: source,
              targetLanguage: target,
            });
            return { output: await translator.translate(masked) };
          } catch (e) {
            return { output: "", error: String(e) };
          }
        },
        { masked: item.masked, source: item.source, target: item.target },
      );
      return { id: item.id, output: r.output, ...(r.error ? { error: r.error } : {}) };
    });
  }
}
