// The Passkeys section, for a browser that's signed in: add a passkey for
// the address you're on, see the ones you have, remove one, and sign out.
// A passkey belongs to the address it was made at, and the password always
// stays behind it, so removing one can never lock you out.

import { useEffect, useState } from "react";
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { passkeyProblem } from "../lock";
import { lockCall, useLock } from "./AuthGate";

interface Passkey {
  id: string;
  rp_id: string;
  created_at: string;
  last_used_at: string | null;
  backed_up: boolean;
}

/** A date in the viewer's own language and order. */
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/** The top bar's button, or a row in the design menu on a phone. It shows only to a signed-in browser, so this computer's window looks as it always has. */
export function PasskeysButton({ open, onOpen }: { open: boolean; onOpen: (open: boolean) => void }) {
  const lock = useLock();
  if (!lock?.session.signed_in) return null;
  return (
    <button className="passkeys-button" aria-expanded={open} aria-controls="passkeys" title="Passkeys and signing out" onClick={() => onOpen(!open)}>
      Passkeys
    </button>
  );
}

/** The Passkeys section while it's open, kept outside the menus so closing the design menu leaves it open. Esc closes it. */
export function Passkeys({ open, onClose }: { open: boolean; onClose: () => void }) {
  const lock = useLock();
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, [open, onClose]);
  if (!open || !lock?.session.signed_in) return null;
  return <PasskeysSection onClose={onClose} onSignedOut={lock.refresh} />;
}

export function PasskeysSection({ onClose, onSignedOut }: { onClose: () => void; onSignedOut: () => void }) {
  const [rows, setRows] = useState<Passkey[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const here = location.hostname;
  const canAdd = browserSupportsWebAuthn();

  const load = async () => {
    try {
      setRows((await lockCall<{ passkeys: Passkey[] }>("/api/auth/passkeys")).passkeys);
    } catch (e) {
      setRows([]);
      setNote(`Couldn't list your passkeys: ${(e as Error).message}`);
    }
  };
  useEffect(() => void load(), []);

  const add = async () => {
    setBusy(true);
    setNote(null);
    try {
      const o = await lockCall<{ cid: string; publicKey: Parameters<typeof startRegistration>[0]["optionsJSON"] }>("/api/auth/passkey/register/options", {});
      let credential;
      try {
        credential = await startRegistration({ optionsJSON: o.publicKey });
      } catch (e) {
        throw new Error(passkeyProblem(e, "add"));
      }
      await lockCall("/api/auth/passkey/register", { cid: o.cid, credential });
      setNote("Passkey added. The lock screen at this address offers it first now.");
      await load();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (p: Passkey) => {
    if (!confirm(`Remove the passkey for ${p.rp_id}? It stops unlocking Woodchuck, and every other signed-in browser is signed out. Your password still works.`)) return;
    try {
      await lockCall("/api/auth/passkeys/remove", { id: p.id });
      await load();
    } catch (e) {
      setNote(`Couldn't remove it: ${(e as Error).message}`);
    }
  };

  const signOut = async () => {
    await lockCall("/api/auth/logout", {}).catch(() => undefined);
    onSignedOut();
  };

  return (
    <section id="passkeys" className="passkeys" aria-labelledby="passkeys-heading">
      <div className="passkeys-head">
        <h2 id="passkeys-heading">Passkeys</h2>
        <button className="link" onClick={onClose} aria-label="Close passkeys">
          Close
        </button>
      </div>
      <p className="passkeys-lead">
        Unlock Woodchuck with Face ID, Touch ID or your device's screen lock instead of typing the password. A passkey works only at the address it was
        made on, so add one on each device. Your password stays as the fallback.
      </p>
      {rows === null ? (
        <p className="muted">Loading your passkeys…</p>
      ) : rows.length === 0 ? (
        <p className="muted">No passkeys yet.</p>
      ) : (
        <ul className="passkeys-list">
          {rows.map((p) => (
            <li key={p.id}>
              <div>
                <strong>{p.rp_id}</strong>
                {p.rp_id === here && <span className="badge">this address</span>}
                <div className="small muted">
                  Added {day(p.created_at)} · {p.last_used_at ? `last used ${day(p.last_used_at)}` : "not used yet"} · {p.backed_up ? "synced" : "this device only"}
                </div>
              </div>
              <button className="danger" onClick={() => void remove(p)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="passkeys-actions">
        <button className="primary" disabled={busy || !canAdd} onClick={() => void add()}>
          {busy ? "Waiting for your device…" : "Add a passkey on this device"}
        </button>
        {!canAdd && <span className="small muted">This browser can't hold a passkey.</span>}
      </div>
      {note && (
        <p className="small passkeys-note" role="status">
          {note}
        </p>
      )}
      <div className="passkeys-foot">
        <button onClick={() => void signOut()}>Sign out of this browser</button>
      </div>
    </section>
  );
}
