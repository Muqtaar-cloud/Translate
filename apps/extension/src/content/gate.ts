/**
 * Viewport gating (PLAN.md §4.6).
 *
 * This is the cost defence, not the cache. Scrolling back through 500 messages
 * of backlog must not fire 500 translations — only what someone actually looks
 * at gets translated, so cost tracks attention rather than channel traffic.
 *
 * `Gate` is an interface because the gating policy is injected, not assumed:
 * a server-side consumer has no viewport at all and gates on demand instead
 * (a reply command or a reaction). Nothing downstream may assume that
 * something upstream already decided a message is worth translating.
 */
export interface Gate {
  /** Call `release` when this element becomes worth translating. */
  watch(el: HTMLElement, release: () => void): void;
  unwatch(el: HTMLElement): void;
  disconnect(): void;
}

/**
 * Releases a message when it enters, or comes near, the viewport.
 *
 * `rootMargin` deliberately extends past the visible area: releasing exactly at
 * the edge means the translation arrives after the message is already being
 * read. A screen of lead time is the difference between "already there" and
 * "pops in late".
 *
 * Each element is released at most once and then unobserved — re-entering the
 * viewport is not a new translation, it is a cache hit at worst.
 */
export class ViewportGate implements Gate {
  private observer: IntersectionObserver;
  private pending = new WeakMap<Element, () => void>();

  constructor(rootMargin = "300px 0px") {
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const release = this.pending.get(entry.target);
          if (!release) continue;
          this.pending.delete(entry.target);
          this.observer.unobserve(entry.target);
          release();
        }
      },
      { rootMargin, threshold: 0 },
    );
  }

  watch(el: HTMLElement, release: () => void): void {
    this.pending.set(el, release);
    this.observer.observe(el);
  }

  unwatch(el: HTMLElement): void {
    this.pending.delete(el);
    this.observer.unobserve(el);
  }

  disconnect(): void {
    this.observer.disconnect();
  }
}

/**
 * Releases everything immediately.
 *
 * For tests, for environments without IntersectionObserver, and as the honest
 * representation of "no gating" — which is what a bot has, and why it needs a
 * different cost defence entirely.
 */
export class ImmediateGate implements Gate {
  watch(_el: HTMLElement, release: () => void): void {
    release();
  }
  unwatch(): void {}
  disconnect(): void {}
}

export function defaultGate(): Gate {
  return typeof IntersectionObserver === "undefined" ? new ImmediateGate() : new ViewportGate();
}
