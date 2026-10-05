// A window that opens, or comes back into view, asks the server to warm
// Claude's prompt cache. The server sends a warm-up only when the cache
// has gone cold, so the next reply starts sooner after a long pause, and
// asking costs nothing otherwise. A window out of view never asks.

/** The parts of the document warmWhenSeen reads, so tests can pass a fake. */
export interface Seen {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/**
 * Calls `ask` now if the window is in view, and again each time it comes
 * back into view. Returns the function that stops listening.
 */
export function warmWhenSeen(doc: Seen, ask: () => void): () => void {
  const check = () => {
    if (doc.visibilityState === "visible") ask();
  };
  check();
  doc.addEventListener("visibilitychange", check);
  return () => doc.removeEventListener("visibilitychange", check);
}
