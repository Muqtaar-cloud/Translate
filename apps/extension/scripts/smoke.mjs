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

/**
 * A tall channel: the six fixture messages plus enough filler that most of the
 * list starts well below the fold. Viewport gating is only observable against
 * real layout, which is exactly what the happy-dom tests cannot provide.
 */
const FILLER = 60;
const filler = Array.from({ length: FILLER }, (_, i) => {
  const id = 950000 + i;
  return `<li id="chat-messages-100-${id}" style="height:120px">
    <h3><span id="message-username-${id}">ana</span></h3>
    <div id="message-content-${id}">mensaje de relleno número ${i} para llenar el canal</div>
  </li>`;
}).join("");

// The filler must live INSIDE the observed container: the adapter only looks
// for messages within [data-list-id="chat-messages"], so anything outside it is
// invisible to the loop and would make the gating check vacuous.
const withFiller = fixture.replace(/<\/div>\s*$/, `${filler}</div>`);

const page_html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Discord</title>
<style>body{margin:0} li{margin:0 0 8px}</style></head>
<body>${withFiller}
<form><div data-slate-editor="true" contenteditable="true">are you coming tomorrow?</div></form>
</body></html>`;

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

/**
 * The service worker is checked explicitly because a bundling success is not a
 * runtime success: a dependency that reaches for a Node API blows up on import,
 * the top-level body never finishes, the message listener is never installed,
 * and every cache lookup silently falls back to a miss. That failure is
 * invisible from the page.
 */
let worker = context.serviceWorkers()[0];
if (!worker) {
  worker = await context.waitForEvent("serviceworker", { timeout: 15000 }).catch(() => null);
}
// Playwright's worker evaluation world does not expose chrome.runtime, so the
// worker reports its own readiness instead: the flag is set at the very end of
// the module body, and only gets set if nothing threw on the way there.
const workerAlive = worker
  ? await worker
      .evaluate(() => globalThis.__polyglotReady === true)
      .catch((e) => `evaluate failed: ${String(e)}`)
  : false;

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

const layerCount = () => page.locator("polyglot-layer").count();

const gatedBefore = await layerCount();
// Scroll to the bottom: everything previously below the fold comes into view.
await page.evaluate(() => globalThis.scrollTo(0, document.body.scrollHeight));
await page.waitForTimeout(1500);
const gatedAfter = await layerCount();

const report = {
  messagesRendered: await page.locator('li[id^="chat-messages-"]').count(),
  layersInjected: gatedAfter,
  gatedBefore,
  gatedAfter,
  bannerShown: (await page.locator("#polyglot-broken-banner").count()) > 0,
  bannerText: await page
    .locator("#polyglot-broken-banner")
    .first()
    .evaluate((el) => el.shadowRoot?.querySelector(".detail")?.textContent ?? "")
    .catch(() => ""),
  translatorApiPresent: await page.evaluate(() => "Translator" in globalThis),
  workerRegistered: Boolean(worker),
  workerAlive,
  escalateButtons: await page.locator("polyglot-layer").evaluateAll(
    (nodes) =>
      nodes.filter((n) => n.shadowRoot?.querySelector('[data-polyglot="escalate"]')).length,
  ),
};

console.log("Extension smoke test\n");
console.log(`  messages on page:      ${report.messagesRendered}`);
console.log(`  layers before scroll:  ${report.gatedBefore}   (viewport gating)`);
console.log(`  layers after scroll:   ${report.gatedAfter}`);
console.log(`  Translator API:        ${report.translatorApiPresent}`);
console.log(`  service worker:        registered=${report.workerRegistered} alive=${report.workerAlive}`);
console.log(
  `  escalation buttons:    ${report.escalateButtons}` +
    " (0 expected here: with no language packs every layer is in the download state,\n" +
    "                          which deliberately offers no LLM button — see below)",
);
console.log(`  broken/unavailable banner: ${report.bannerShown}`);
if (report.bannerText) console.log(`    "${report.bannerText.trim()}"`);
if (errors.length > 0) {
  console.log("\n  errors:");
  for (const e of errors) console.log(`    ${e}`);
}

// --- outbound composer ---------------------------------------------------
// Real Chromium honours execCommand("insertText") on a contenteditable, which
// happy-dom cannot, so this is where the write path is actually exercised.
await page.keyboard.down("Control");
await page.keyboard.down("Shift");
await page.keyboard.press("T");
await page.keyboard.up("Shift");
await page.keyboard.up("Control");
await page.waitForTimeout(1500);

const outbound = {
  panelShown: (await page.locator("polyglot-outbound").count()) > 0,
  panelText: await page
    .locator("polyglot-outbound")
    .first()
    .evaluate((el) => el.shadowRoot?.querySelector(".panel")?.textContent?.trim() ?? "")
    .catch(() => ""),
  composerUnchanged:
    (await page.locator("[data-slate-editor]").innerText()) === "are you coming tomorrow?",
};

console.log(`  outbound panel:        ${outbound.panelShown ? "opens on hotkey" : "did not open"}`);
if (outbound.panelText) {
  console.log(`    "${outbound.panelText.replace(/\s+/g, " ").slice(0, 100)}"`);
}
console.log(`  composer untouched until approved: ${outbound.composerUnchanged}`);

// --- popup ---------------------------------------------------------------
// Extension pages are only reachable at chrome-extension://<id>/..., and the
// id is only knowable at runtime. The service worker's URL carries it.
const extensionId = worker ? new URL(worker.url()).host : null;
let popup = { opened: false, text: "" };
if (extensionId) {
  const popupPage = await context.newPage();
  const popupErrors = [];
  popupPage.on("pageerror", (e) => popupErrors.push(String(e)));
  await popupPage.goto(`chrome-extension://${extensionId}/popup/index.html`);
  await popupPage.waitForTimeout(500);
  popup = {
    opened: true,
    text: (await popupPage.locator("body").innerText()).replace(/\s+/g, " ").trim(),
    errors: popupErrors,
  };
  await popupPage.close();
}

console.log(`  popup:                 ${popup.opened ? "loads" : "NOT REACHABLE"}`);
console.log(
  "    (opened as a tab, so its own tab is the active one and it correctly reports\n" +
    "     'not a Discord channel'. What this proves is that it loads and runs clean;\n" +
    "     the channel-detection path is covered by the unit tests instead.)",
);
if (popup.text) console.log(`    "${popup.text.slice(0, 90)}"`);
if (popup.errors?.length) console.log(`    errors: ${popup.errors.join("; ")}`);

// --- SPA channel switch ---------------------------------------------------
// Discord changes channel without a page load. If the content script does not
// notice, a per-channel setting silently applies to the wrong channel.
await page.evaluate(() => {
  history.pushState({}, "", "/channels/555/999");
  dispatchEvent(new PopStateEvent("popstate"));
});
await page.waitForTimeout(1500);
const survivedNavigation = (await page.locator("polyglot-layer").count()) > 0;
console.log(`  survives channel switch: ${survivedNavigation}`);

await context.close();

// The content script must inject and reach a decision. Without the built-in
// Translator (as in any sandbox or CI Chromium) the correct outcome is the
// banner, not silence — that is the §10 rule applied to itself.
const gatingWorks =
  report.gatedBefore < report.messagesRendered && report.gatedAfter > report.gatedBefore;

console.log(
  `  gating suppressed work: ${gatingWorks ? "yes" : "NO — everything translated up front"}`,
);

const ok =
  report.messagesRendered === 6 + FILLER &&
  gatingWorks &&
  report.workerAlive === true &&
  popup.opened &&
  (popup.errors?.length ?? 0) === 0 &&
  survivedNavigation &&
  outbound.composerUnchanged &&
  (report.translatorApiPresent ? report.layersInjected > 0 : report.bannerShown);

console.log(`\n  ${ok ? "PASS" : "FAIL"}`);
process.exit(ok ? 0 : 1);
