import { mask, restore } from "@polyglot/core";
import type { PlatformAdapter } from "./adapter.js";
import { composerHandle, formatOutbound } from "./composer.js";

/**
 * Outbound translation: write in your language, send in theirs (PLAN.md §3.2).
 *
 * Two rules shape everything here.
 *
 * **It never sends.** The translation goes into the composer and stops. The
 * user presses Enter themselves, having read it. Nothing in this file
 * dispatches a key event, submits a form, or clicks a send button, and there is
 * a test that keeps it that way. Auto-sending text the user has not read, in a
 * language they cannot read, under their own name, is not a feature.
 *
 * **Back-translation is review, not a guarantee.** It catches gross failures —
 * flipped negation, wrong entity, nonsense — and it cannot catch the one that
 * matters most, because a fluent-but-wrong translation back-translates
 * fluently. The panel says so rather than presenting a green tick. The real
 * mitigation is appending the original (see `formatOutbound`), which is on by
 * default and lets any bilingual reader in the channel resolve a bad
 * translation themselves.
 *
 * Worth knowing: this direction is `en → N`, and the Phase 0b bake-off rates
 * `N → en`. Different direction, different failure profile, judged by different
 * people. Outbound quality is genuinely unmeasured.
 */

export interface OutboundQuota {
  remaining(): Promise<number>;
  record(chars: number): Promise<void>;
}

export interface OutboundDeps {
  adapter: PlatformAdapter;
  doc: Document;
  /** The language I write in. */
  sourceLanguage: string;
  /** Where to send it. Usually the channel's dominant language. */
  targetLanguage: () => string | null;
  translate(source: string, target: string, text: string): Promise<string>;
  /** Optional: the review pass. Absent means the panel simply omits it. */
  backTranslate?: (source: string, target: string, text: string) => Promise<string>;
  glossary: () => readonly string[];
  appendOriginal: () => boolean;
  quota?: OutboundQuota;
  /** Default Ctrl/Cmd+Shift+T. */
  hotkey?: (e: KeyboardEvent) => boolean;
}

const defaultHotkey = (e: KeyboardEvent): boolean =>
  (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "t";

const STYLE = `
:host { all: initial; }
.panel {
  font: 13px/1.45 system-ui, sans-serif;
  background: #2b2d31; color: #f2f3f5;
  border: 1px solid #4a4d54; border-radius: 8px;
  padding: 12px 14px; margin-bottom: 8px;
  box-shadow: 0 6px 24px rgba(0,0,0,.45);
}
h2 { font-size: 11px; letter-spacing: .06em; text-transform: uppercase;
     opacity: .6; margin: 0 0 8px; font-weight: 600; }
.block { margin: 8px 0; }
.label { font-size: 11px; opacity: .55; text-transform: uppercase; letter-spacing: .05em; }
.text { unicode-bidi: isolate; white-space: pre-wrap; margin-top: 2px; }
.caveat { font-size: 12px; opacity: .6; margin-top: 4px; font-style: italic; }
.row { display: flex; gap: 8px; align-items: center; margin-top: 12px; }
.spacer { flex: 1; }
.quota { font-size: 11px; opacity: .55; }
button { font: inherit; cursor: pointer; background: transparent; color: inherit;
         border: 1px solid currentColor; border-radius: 4px; padding: 3px 10px; opacity: .85; }
button:hover { opacity: 1; }
button.primary { background: #5865f2; border-color: #5865f2; opacity: 1; }
.error { color: #f0b232; }
`;

export class OutboundComposer {
  private deps: OutboundDeps;
  private host: HTMLElement | null = null;
  private onKeyDown: ((e: KeyboardEvent) => void) | null = null;

  constructor(deps: OutboundDeps) {
    this.deps = deps;
  }

  attach(): void {
    const matches = this.deps.hotkey ?? defaultHotkey;
    this.onKeyDown = (e: KeyboardEvent): void => {
      if (!matches(e)) return;
      e.preventDefault();
      void this.open();
    };
    this.deps.doc.addEventListener("keydown", this.onKeyDown, true);
  }

  detach(): void {
    if (this.onKeyDown) {
      this.deps.doc.removeEventListener("keydown", this.onKeyDown, true);
      this.onKeyDown = null;
    }
    this.close();
  }

  close(): void {
    this.host?.remove();
    this.host = null;
  }

  get isOpen(): boolean {
    return this.host !== null;
  }

  /** Reads the composer, translates, and shows the review panel. */
  async open(): Promise<void> {
    const { adapter, doc } = this.deps;

    const el = adapter.findComposer(doc);
    if (!el) return;

    const composer = composerHandle(el);
    const original = composer.read();
    if (original === "") return;

    const target = this.deps.targetLanguage();
    const source = this.deps.sourceLanguage;

    this.close();
    const panel = this.mount(el);

    if (!target) {
      this.renderError(
        panel,
        "No language detected for this channel yet. Read a few messages first.",
      );
      return;
    }
    if (target === source) {
      this.renderError(panel, `This channel already reads ${source}.`);
      return;
    }

    this.renderPending(panel, "translating…");

    // The glossary is applied here as well as inbound: a project name is just
    // as wrong translated on the way out.
    const { masked, spans } = mask(original, { protect: this.deps.glossary() });

    if (this.deps.quota) {
      const left = await this.deps.quota.remaining();
      if (left < masked.length) {
        this.renderError(
          panel,
          `Daily translation budget spent (${left} characters left). It resets tomorrow.`,
        );
        return;
      }
    }

    let translated: string;
    try {
      translated = restore(await this.deps.translate(source, target, masked), spans).text;
      await this.deps.quota?.record(masked.length);
    } catch (error) {
      this.renderError(panel, `Translation failed: ${String(error)}`);
      return;
    }

    let back: string | null = null;
    if (this.deps.backTranslate) {
      try {
        const maskedBack = mask(translated, { protect: this.deps.glossary() });
        back = restore(
          await this.deps.backTranslate(target, source, maskedBack.masked),
          maskedBack.spans,
        ).text;
        await this.deps.quota?.record(maskedBack.masked.length);
      } catch {
        back = null; // A failed review pass must not block the translation.
      }
    }

    this.renderReview(panel, { original, translated, back, source, target, composer });
  }

  private mount(composerEl: HTMLElement): ShadowRoot {
    const doc = this.deps.doc;
    this.host = doc.createElement("polyglot-outbound");
    this.host.setAttribute("data-polyglot", "outbound");
    const root = this.host.attachShadow({ mode: "open" });

    const style = doc.createElement("style");
    style.textContent = STYLE;
    const panel = doc.createElement("div");
    panel.className = "panel";
    root.append(style, panel);

    // Above the composer: the thing being reviewed should sit next to where it
    // is going, not in a corner of the screen.
    const anchor = composerEl.closest("form") ?? composerEl.parentElement ?? doc.body;
    anchor.parentElement?.insertBefore(this.host, anchor) ?? doc.body.append(this.host);

    return root;
  }

  private panelOf(root: ShadowRoot): HTMLElement {
    return root.querySelector(".panel") as HTMLElement;
  }

  private renderPending(root: ShadowRoot, message: string): void {
    const panel = this.panelOf(root);
    panel.replaceChildren();
    const el = this.deps.doc.createElement("div");
    el.className = "caveat";
    el.textContent = message;
    panel.append(el);
  }

  private renderError(root: ShadowRoot, message: string): void {
    const panel = this.panelOf(root);
    panel.replaceChildren();

    const el = this.deps.doc.createElement("div");
    el.className = "error";
    el.textContent = message;

    const row = this.deps.doc.createElement("div");
    row.className = "row";
    const close = this.deps.doc.createElement("button");
    close.textContent = "Close";
    close.addEventListener("click", () => this.close());
    row.append(close);

    panel.append(el, row);
  }

  private renderReview(
    root: ShadowRoot,
    ctx: {
      original: string;
      translated: string;
      back: string | null;
      source: string;
      target: string;
      composer: ReturnType<typeof composerHandle>;
    },
  ): void {
    const doc = this.deps.doc;
    const panel = this.panelOf(root);
    panel.replaceChildren();

    const heading = doc.createElement("h2");
    heading.textContent = `Send in ${ctx.target.toUpperCase()} — review before sending`;

    const block = (label: string, text: string, lang: string): HTMLElement => {
      const wrap = doc.createElement("div");
      wrap.className = "block";
      const l = doc.createElement("div");
      l.className = "label";
      l.textContent = label;
      const t = doc.createElement("div");
      t.className = "text";
      t.textContent = text;
      t.setAttribute("dir", "auto");
      t.setAttribute("lang", lang);
      wrap.append(l, t);
      return wrap;
    };

    panel.append(heading, block(`${ctx.target.toUpperCase()} — will be sent`, ctx.translated, ctx.target));

    if (ctx.back !== null) {
      const backBlock = block("Back-translation", ctx.back, ctx.source);
      const caveat = doc.createElement("div");
      caveat.className = "caveat";
      // Deliberately not a green tick. §6 rejects back-translation as a
      // measurement for exactly this reason, and the same limit applies when
      // it is used as a per-message check.
      caveat.textContent =
        "A rough check. It catches nonsense and flipped meaning, but a wrong " +
        "translation that reads well will read well here too.";
      backBlock.append(caveat);
      panel.append(backBlock);
    }

    const row = doc.createElement("div");
    row.className = "row";

    const insert = doc.createElement("button");
    insert.className = "primary";
    insert.textContent = "Put in message box";
    insert.addEventListener("click", () => {
      const text = formatOutbound(
        ctx.translated,
        ctx.original,
        ctx.source,
        this.deps.appendOriginal(),
      );
      // Writes and stops. Sending is the user's keystroke, never ours.
      if (ctx.composer.write(text)) {
        this.close();
      } else {
        this.renderError(
          root,
          "Couldn't write to the message box — Discord's composer may have changed. " +
            "The translation is above; copy it manually.",
        );
      }
    });

    const cancel = doc.createElement("button");
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => this.close());

    const spacer = doc.createElement("div");
    spacer.className = "spacer";

    row.append(insert, cancel, spacer);

    if (this.deps.quota) {
      const quota = doc.createElement("span");
      quota.className = "quota";
      void this.deps.quota.remaining().then((left) => {
        quota.textContent = `${left.toLocaleString()} characters left today`;
      });
      row.append(quota);
    }

    panel.append(row);
  }
}
