// Issue #38: a window asks the server to warm Claude's prompt cache as it
// opens in view, and each time it comes back into view. One out of view
// never asks.

import { describe, expect, it } from "vitest";
import { warmWhenSeen, type Seen } from "../src/warm";

function page(state: DocumentVisibilityState) {
  const listeners = new Set<() => void>();
  const doc: Seen & { show(s: DocumentVisibilityState): void; listening(): number } = {
    visibilityState: state,
    addEventListener: (_type, l) => void listeners.add(l),
    removeEventListener: (_type, l) => void listeners.delete(l),
    show(s) {
      (this as { visibilityState: DocumentVisibilityState }).visibilityState = s;
      for (const l of listeners) l();
    },
    listening: () => listeners.size,
  };
  return doc;
}

describe("warming the cache from a window", () => {
  it("asks as a window opens in view, and each time it comes back", () => {
    const doc = page("visible");
    let asked = 0;
    const stop = warmWhenSeen(doc, () => asked++);
    expect(asked).toBe(1);
    doc.show("hidden");
    expect(asked).toBe(1);
    doc.show("visible");
    expect(asked).toBe(2);
    stop();
    expect(doc.listening()).toBe(0);
    doc.show("visible");
    expect(asked).toBe(2);
  });

  it("waits for a window that opens out of view", () => {
    const doc = page("hidden");
    let asked = 0;
    warmWhenSeen(doc, () => asked++);
    expect(asked).toBe(0);
    doc.show("visible");
    expect(asked).toBe(1);
  });
});
