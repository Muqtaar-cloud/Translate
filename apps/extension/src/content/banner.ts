/**
 * The "Polyglot can't read this page" state.
 *
 * Reporting adapter breakage to a counter only would leave the user with an
 * extension that silently does nothing after a Discord redesign — they would
 * assume it worked and quietly mistrust it. The counter tells the maintainer;
 * this tells the user.
 *
 * Worth knowing what it costs to fix: the natural fast path — remotely
 * updatable selectors — collides with Chrome Web Store's remotely-hosted-code
 * policy, so a public build treats every adapter break as a review cycle.
 * Unlisted, it is a reload.
 */
const ID = "polyglot-broken-banner";

export function showBrokenBanner(doc: Document, detail: string): void {
  if (doc.getElementById(ID)) return;

  const host = doc.createElement("div");
  host.id = ID;
  host.style.cssText =
    "position:fixed;bottom:16px;right:16px;z-index:2147483647;max-width:320px";
  const root = host.attachShadow({ mode: "open" });

  const style = doc.createElement("style");
  style.textContent = `
    .box {
      font: 13px/1.4 system-ui, sans-serif;
      background: #2b2d31; color: #f2f3f5;
      border: 1px solid #4a4d54; border-left: 3px solid #f0b232;
      border-radius: 6px; padding: 10px 12px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    }
    .title { font-weight: 600; margin-bottom: 4px; }
    .detail { opacity: 0.8; }
    button {
      margin-top: 8px; font: inherit; cursor: pointer;
      background: transparent; color: inherit;
      border: 1px solid currentColor; border-radius: 4px; padding: 2px 8px;
    }
  `;

  const box = doc.createElement("div");
  box.className = "box";

  const title = doc.createElement("div");
  title.className = "title";
  title.textContent = "Polyglot can't read this page";

  const body = doc.createElement("div");
  body.className = "detail";
  body.textContent = `${detail} Check for an extension update.`;

  const dismiss = doc.createElement("button");
  dismiss.textContent = "Dismiss";
  dismiss.addEventListener("click", () => host.remove());

  box.append(title, body, dismiss);
  root.append(style, box);
  doc.body.append(host);
}
