// The gate around the whole app. It asks the server whether this browser
// may in, shows the lock screen until it may, and locks again the moment
// the server turns it away. On this computer, and once signed in, the app
// runs as it always has.

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { gateView, lockEvents, watchForLock, type LockSession } from "../lock";
import { LockScreen } from "./LockScreen";

const LockContext = createContext<{ session: LockSession; refresh: () => void } | null>(null);

/** The session the gate let in, for the Passkeys section. Null outside the gate. */
export const useLock = () => useContext(LockContext);

/** A JSON call to the lock's routes. Throws the server's own words when it says no. */
export async function lockCall<T = { ok: true }>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `That didn't work (${res.status})`);
  return data;
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<LockSession | null>(null);

  const probe = useCallback(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async () => {
      try {
        setSession(await lockCall<LockSession>("/api/auth/session"));
      } catch {
        // Down or restarting, such as during an update: ask again until it answers.
        timer = setTimeout(() => void ask(), 2000);
      }
    };
    void ask();
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => probe(), [probe]);
  useEffect(() => {
    const unwatch = watchForLock();
    const locked = () => void probe();
    lockEvents.addEventListener("locked", locked);
    return () => {
      unwatch();
      lockEvents.removeEventListener("locked", locked);
    };
  }, [probe]);

  const view = gateView(session, browserSupportsWebAuthn());
  if (view === "probing" || !session) return <div className="lock-wait" aria-busy="true" />;
  if (view === "open") return <LockContext.Provider value={{ session, refresh: probe }}>{children}</LockContext.Provider>;
  return <LockScreen session={session} start={view} onUnlocked={probe} />;
}
