/**
 * The translation layer: what actually renders under a message.
 *
 * The single most important product decision lives here — the translation goes
 * *underneath* the original and never replaces or hides it. Mistranslation is
 * inevitable, so keeping the source visible is what makes it survivable, lets
 * bilingual readers ignore the layer entirely, and gives the false-negative
 * criterion something to be false about.
 *
 * Plain DOM rather than Preact. The plan names Preact for injected UI, and it
 * earns its place in the options page — but this node is one line of text, a
 * badge and a button, injected potentially thousands of times per session.
 * A component runtime per message is cost without a benefit. Noted as a
 * deliberate deviation.
 *
 * Shadow DOM in both directions: Discord's CSS cannot reach in, and ours cannot
 * leak out and break the chat.
 */

export type LayerState =
  | {
      kind: "translated";
      text: string;
      source: string;
      target: string;
      /** Which tier produced this. "llm" is only ever reached by a user action. */
      via?: "auto" | "llm";
    }
  | { kind: "pending" }
  | { kind: "escalating" }
  | { kind: "needs-download"; source: string; target: string }
  | { kind: "downloading"; progress: number }
  | { kind: "failed"; reason: string }
  /** Nothing rendered, but the hover affordance stays — see `idle` below. */
  | { kind: "idle" };

export interface LayerCallbacks {
  /** Hover globe. Available on EVERY message, including ones detection skipped. */
  onTranslateRequest(): void;
  /** Pack download. Fires from a real click, which the browser requires. */
  onEnablePack(source: string, target: string): void;
  /**
   * "Translate properly" — the LLM escalation (PLAN.md §4.3).
   *
   * Only ever reached from a click. This is the one path permitted to send
   * thread context, and being user-initiated is what makes that bound true.
   */
  onEscalate?(): void;
}

const STYLE = `
:host { display: block; }
.wrap {
  margin-top: 2px;
  padding-left: 8px;
  border-left: 2px solid var(--pg-rule, rgba(127,127,127,0.35));
  font-size: 0.94em;
  line-height: 1.35;
  opacity: 0.82;
}
.badge {
  font-size: 0.72em;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  opacity: 0.7;
  margin-right: 6px;
  white-space: nowrap;
}
/* pre-wrap, because a multi-line message translates to multi-line text and
   would otherwise collapse onto one line. */
.text { unicode-bidi: isolate; white-space: pre-wrap; }
.muted { opacity: 0.65; font-style: italic; }
button {
  font: inherit;
  font-size: 0.85em;
  cursor: pointer;
  background: transparent;
  border: 1px solid currentColor;
  border-radius: 4px;
  padding: 1px 6px;
  color: inherit;
  opacity: 0.8;
}
button:hover { opacity: 1; }
.bar { height: 3px; background: currentColor; opacity: 0.3; border-radius: 2px; margin-top: 4px; }
.bar > i { display: block; height: 100%; background: currentColor; border-radius: 2px; }
`;

export class TranslationLayer {
  readonly host: HTMLElement;
  private root: ShadowRoot;
  private wrap: HTMLDivElement;
  private callbacks: LayerCallbacks;

  constructor(doc: Document, callbacks: LayerCallbacks) {
    this.callbacks = callbacks;
    this.host = doc.createElement("polyglot-layer");
    this.host.setAttribute("data-polyglot", "layer");
    this.root = this.host.attachShadow({ mode: "open" });

    const style = doc.createElement("style");
    style.textContent = STYLE;
    this.wrap = doc.createElement("div");
    this.wrap.className = "wrap";
    this.root.append(style, this.wrap);
  }

  render(state: LayerState): void {
    const doc = this.host.ownerDocument;
    this.wrap.replaceChildren();

    switch (state.kind) {
      case "translated": {
        const badge = doc.createElement("span");
        badge.className = "badge";
        badge.textContent = `${state.source} → ${state.target}`;

        const text = doc.createElement("span");
        text.className = "text";
        text.textContent = state.text;
        // dir="auto" plus isolation in the stylesheet: without both, an RTL
        // translation or an RTL fragment renders scrambled inside Discord's
        // LTR layout. Cheap here, expensive to retrofit.
        text.setAttribute("dir", "auto");
        // Drives font selection, text-to-speech and screen-reader pronunciation.
        text.setAttribute("lang", state.target);

        this.wrap.append(badge, text);

        if (state.via === "llm") {
          // Worth distinguishing: this one cost an API call and sent the
          // preceding few messages off the machine. The user chose that, and
          // the layer should not pretend it was the same as the free path.
          const mark = doc.createElement("span");
          mark.className = "badge";
          mark.textContent = " · ai";
          mark.title = "Translated with context by an LLM, at your request";
          this.wrap.append(mark);
        } else if (this.callbacks.onEscalate) {
          const escalate = doc.createElement("button");
          escalate.textContent = "translate properly";
          escalate.title =
            "Re-translate with an LLM using the last few messages as context. " +
            "Sends those messages to a cloud provider.";
          escalate.setAttribute("data-polyglot", "escalate");
          escalate.addEventListener("click", (e) => {
            e.stopPropagation();
            this.callbacks.onEscalate?.();
          });
          this.wrap.append(escalate);
        }
        // Names the layer for screen readers, which would otherwise read every
        // message twice with no indication that the second pass is a machine
        // translation.
        this.host.setAttribute("aria-label", `Translation from ${state.source}`);
        this.host.setAttribute("role", "note");
        break;
      }

      case "pending": {
        const el = doc.createElement("span");
        el.className = "muted";
        el.textContent = "translating…";
        this.wrap.append(el);
        break;
      }

      case "escalating": {
        const el = doc.createElement("span");
        el.className = "muted";
        el.textContent = "re-translating with context…";
        this.wrap.append(el);
        break;
      }

      case "needs-download": {
        // The user-gesture requirement surfaced as UX rather than swallowed.
        const label = doc.createElement("span");
        label.className = "muted";
        label.textContent = `${state.source} → ${state.target} needs a language pack. `;

        const button = doc.createElement("button");
        button.textContent = `Download ${state.source} pack`;
        button.addEventListener("click", () => {
          this.callbacks.onEnablePack(state.source, state.target);
        });

        this.wrap.append(label, button);
        break;
      }

      case "downloading": {
        const label = doc.createElement("span");
        label.className = "muted";
        label.textContent = `downloading language pack… ${Math.round(state.progress * 100)}%`;

        const bar = doc.createElement("div");
        bar.className = "bar";
        const fill = doc.createElement("i");
        fill.style.width = `${Math.round(state.progress * 100)}%`;
        bar.append(fill);

        this.wrap.append(label, bar);
        break;
      }

      case "failed": {
        const el = doc.createElement("span");
        el.className = "muted";
        el.textContent = `translation failed: ${state.reason} `;
        this.wrap.append(el);

        if (this.callbacks.onEscalate) {
          const escalate = doc.createElement("button");
          escalate.textContent = "try with an LLM";
          escalate.setAttribute("data-polyglot", "escalate");
          escalate.addEventListener("click", (e) => {
            e.stopPropagation();
            this.callbacks.onEscalate?.();
          });
          this.wrap.append(escalate);
        }
        break;
      }

      case "idle": {
        // Deliberately empty but still mounted. A message detection skipped —
        // a short "ya voy" that looked unrecognisable — is visually identical
        // to an English one, so the user never learns it happened. The hover
        // affordance below is what makes the skip rule safe, which is why it
        // exists in every mode rather than only in on-demand mode.
        break;
      }
    }
  }

  /** The always-available manual trigger. */
  attachHoverAffordance(messageEl: HTMLElement): void {
    const doc = messageEl.ownerDocument;
    let button: HTMLButtonElement | null = null;

    const show = (): void => {
      if (button) return;
      button = doc.createElement("button");
      button.textContent = "🌐";
      button.title = "Translate this message";
      button.setAttribute("data-polyglot", "globe");
      button.addEventListener("click", (e) => {
        e.stopPropagation();
        this.callbacks.onTranslateRequest();
      });
      this.wrap.append(button);
    };

    const hide = (): void => {
      button?.remove();
      button = null;
    };

    messageEl.addEventListener("mouseenter", show);
    messageEl.addEventListener("mouseleave", hide);
    messageEl.addEventListener("focusin", show);
  }

  remove(): void {
    this.host.remove();
  }
}
