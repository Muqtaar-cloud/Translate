import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

/**
 * Loads the built extension into a real Chromium and points it at a fake
 * Discord page.
 *
 * The fixture tests check the adapter against saved HTML in happy-dom. This
 * checks the things those cannot: that the manifest is valid, that the content
 * script actually injects on a matching URL, and that the real MutationObserver
 * and Shadow DOM behave. It routes discord.com to local HTML rather than
 * reaching the network or needing an account.
 *
 * Not part of `npm test` — it needs a browser, and the unit suite should stay
 * runnable anywhere.
 */
const here = dirname(fileURLToPath(import.meta.url));
const extensionPath = resolve(here, "../dist");
const fixture = readFileSync(resolve(here, "../fixtures/discord-messages.html"), "utf8");

const page_html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Discord</title></head><body>${fixture}</body></html>`;

// Extensions need the full Chromium binary, not the headless shell, and they
// only load in headed or new-headless mode.
const executablePath =
  process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const context = await chromium.launchPersistentContext("", {
  executablePath,
  headless: false,
  args: [
    "--headless=new",
    "--no-sandbox",
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ],
});

const errors = [];
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text()}`);
});

await page.route("https://discord.com/**", (r) =>
  r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: page_html }),
);

await page.goto("https://discord.com/channels/555/100");
await page.waitForTimeout(3000);

const report = {
  messagesRendered: await page.locator('li[id^="chat-messages-"]').count(),
  layersInjected: await page.locator("polyglot-layer").count(),
  bannerShown: (await page.locator("#polyglot-broken-banner").count()) > 0,
  bannerText: await page
    .locator("#polyglot-broken-banner")
    .first()
    .evaluate((el) => el.shadowRoot?.querySelector(".detail")?.textContent ?? "")
    .catch(() => ""),
  translatorApiPresent: await page.evaluate(() => "Translator" in globalThis),
};

console.log("Extension smoke test\n");
console.log(`  messages on page:      ${report.messagesRendered}`);
console.log(`  layers injected:       ${report.layersInjected}`);
console.log(`  Translator API:        ${report.translatorApiPresent}`);
console.log(`  broken/unavailable banner: ${report.bannerShown}`);
if (report.bannerText) console.log(`    "${report.bannerText.trim()}"`);
if (errors.length > 0) {
  console.log("\n  errors:");
  for (const e of errors) console.log(`    ${e}`);
}

await context.close();

// The content script must inject and reach a decision. Without the built-in
// Translator (as in any sandbox or CI Chromium) the correct outcome is the
// banner, not silence — that is the §10 rule applied to itself.
const ok =
  report.messagesRendered === 6 &&
  (report.translatorApiPresent ? report.layersInjected > 0 : report.bannerShown);

console.log(`\n  ${ok ? "PASS" : "FAIL"}`);
process.exit(ok ? 0 : 1);
