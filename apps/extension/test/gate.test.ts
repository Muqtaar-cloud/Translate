// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImmediateGate, ViewportGate, defaultGate } from "../src/content/gate.js";

/**
 * happy-dom has no real layout, so IntersectionObserver is stubbed with one we
 * drive by hand. That is the right level for this: the behaviour under test is
 * the gate's bookkeeping — release once, unobserve after, honour unwatch —
 * not whether the browser computes intersections correctly.
 *
 * Whether gating actually suppresses work on a real page is checked in the
 * browser smoke test instead.
 */
type Cb = (entries: { target: Element; isIntersecting: boolean }[]) => void;

let observed: Element[];
let unobserved: Element[];
let fire: Cb;
let disconnected: boolean;

class StubObserver {
  constructor(cb: Cb) {
    fire = cb;
  }
  observe(el: Element): void {
    observed.push(el);
  }
  unobserve(el: Element): void {
    unobserved.push(el);
  }
  disconnect(): void {
    disconnected = true;
  }
}

beforeEach(() => {
  observed = [];
  unobserved = [];
  disconnected = false;
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = StubObserver;
});

const el = (): HTMLElement => document.createElement("li");

describe("ViewportGate", () => {
  it("does not release a message that never comes into view", () => {
    const gate = new ViewportGate();
    const release = vi.fn();
    gate.watch(el(), release);

    expect(observed).toHaveLength(1);
    expect(release).not.toHaveBeenCalled();
  });

  it("releases when the message intersects", () => {
    const gate = new ViewportGate();
    const target = el();
    const release = vi.fn();
    gate.watch(target, release);

    fire([{ target, isIntersecting: true }]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("ignores a non-intersecting entry", () => {
    const gate = new ViewportGate();
    const target = el();
    const release = vi.fn();
    gate.watch(target, release);

    fire([{ target, isIntersecting: false }]);
    expect(release).not.toHaveBeenCalled();
  });

  // Scrolling back over a message is a cache hit at worst, never a second
  // translation.
  it("releases at most once and then stops observing", () => {
    const gate = new ViewportGate();
    const target = el();
    const release = vi.fn();
    gate.watch(target, release);

    fire([{ target, isIntersecting: true }]);
    fire([{ target, isIntersecting: true }]);

    expect(release).toHaveBeenCalledOnce();
    expect(unobserved).toContain(target);
  });

  it("does not release after unwatch", () => {
    const gate = new ViewportGate();
    const target = el();
    const release = vi.fn();
    gate.watch(target, release);
    gate.unwatch(target);

    fire([{ target, isIntersecting: true }]);
    expect(release).not.toHaveBeenCalled();
  });

  it("releases only the entries that actually intersected", () => {
    const gate = new ViewportGate();
    const a = el();
    const b = el();
    const releaseA = vi.fn();
    const releaseB = vi.fn();
    gate.watch(a, releaseA);
    gate.watch(b, releaseB);

    fire([
      { target: a, isIntersecting: true },
      { target: b, isIntersecting: false },
    ]);

    expect(releaseA).toHaveBeenCalledOnce();
    expect(releaseB).not.toHaveBeenCalled();
  });

  it("extends the release margin past the visible area", () => {
    // A translation that arrives as the message crosses the edge is already
    // late; the margin buys a screen of lead time.
    const spy = vi.fn();
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
      constructor(_cb: Cb, options: { rootMargin: string }) {
        spy(options.rootMargin);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
    new ViewportGate();
    expect(spy).toHaveBeenCalledWith("300px 0px");
  });

  it("disconnects", () => {
    new ViewportGate().disconnect();
    expect(disconnected).toBe(true);
  });
});

describe("ImmediateGate", () => {
  it("releases synchronously", () => {
    const release = vi.fn();
    new ImmediateGate().watch(el(), release);
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("defaultGate", () => {
  it("falls back to immediate release where there is no IntersectionObserver", () => {
    delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
    expect(defaultGate()).toBeInstanceOf(ImmediateGate);
  });

  it("uses the viewport gate when the browser provides one", () => {
    expect(defaultGate()).toBeInstanceOf(ViewportGate);
  });
});
