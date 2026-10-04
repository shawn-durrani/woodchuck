// The owner lock's rules on the page, kept out of the components so tests
// can hold them: which face the lock screen shows, what the setup form
// checks before it sends, and noticing a 401 so the page locks itself.

/** What GET /api/auth/session answers. */
export interface LockSession {
  enrolled: boolean;
  /** Open to this browser: it's on this computer, or signed in. */
  authenticated: boolean;
  /** Holds a real session, so it can manage passkeys and sign out. */
  signed_in: boolean;
  loopback: boolean;
  /** Woodchuck has tailnet names to answer on. */
  tailnet: boolean;
  /** A passkey exists for this address. */
  passkey: boolean;
  /** The addresses that hold a passkey, when this one doesn't. */
  passkey_elsewhere: string[];
  app: string;
  browser_origin: string;
}

export type GateView = "probing" | "open" | "setup" | "passkey" | "password";

/** The lock screen's face for a session. A passkey leads only where one exists and the browser can use it. */
export function gateView(session: LockSession | null | undefined, webauthnAvailable = false): GateView {
  if (!session) return "probing";
  if (session.authenticated) return "open";
  if (!session.enrolled) return "setup";
  if (session.passkey && webauthnAvailable) return "passkey";
  return "password";
}

export const MIN_PASSWORD_LENGTH = 8;

/** The setup and reset form's own check, matching the server's, so the round trip only confirms. */
export function setupProblem(f: { recovery: string; password: string; confirm: string }): string | null {
  if (!f.recovery.trim()) return "Paste the recovery secret first.";
  if (f.password.length < MIN_PASSWORD_LENGTH) return `The password needs at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (f.password !== f.confirm) return "The two passwords don't match.";
  return null;
}

/** Says "locked" when the server turns this browser away, so the gate can ask again. */
export const lockEvents = new EventTarget();

/** The API path a fetch went to on this page's own server, or null. */
function apiPath(input: RequestInfo | URL): string | null {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const here = globalThis.location?.href ?? "http://localhost/";
  try {
    const url = new URL(href, here);
    if (url.origin !== new URL(here).origin) return null;
    return url.pathname.startsWith("/api/") ? url.pathname : null;
  } catch {
    return null;
  }
}

/**
 * Watches every fetch the page makes. Any 401 from the API, outside the lock's
 * own routes, means the session ended, so the page locks. Returns the undo.
 */
export function watchForLock(target: { fetch: typeof fetch } = globalThis): () => void {
  const original = target.fetch;
  const watched: typeof fetch = async (input, init) => {
    const res = await original.call(globalThis, input, init);
    const p = res.status === 401 ? apiPath(input) : null;
    if (p && !p.startsWith("/api/auth/")) lockEvents.dispatchEvent(new Event("locked"));
    return res;
  };
  target.fetch = watched;
  return () => {
    if (target.fetch === watched) target.fetch = original;
  };
}

/** Plain words for a passkey prompt that didn't finish. */
export function passkeyProblem(err: unknown, kind: "add" | "unlock"): string {
  const name = (err as { name?: string } | null)?.name;
  if (name === "NotAllowedError") {
    return kind === "add" ? "The passkey prompt was closed, so nothing was added." : "The passkey prompt was closed or timed out. Try again, or use your password.";
  }
  if (name === "InvalidStateError" && kind === "add") return "This device already has a passkey for this address.";
  const message = (err as { message?: string } | null)?.message ?? String(err);
  return kind === "add" ? `Adding the passkey didn't work: ${message}` : `The passkey didn't unlock Woodchuck: ${message}`;
}
