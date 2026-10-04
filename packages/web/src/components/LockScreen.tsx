// The lock screen a tailnet browser sees until it signs in: set the
// password with the recovery secret, sign in with it, or unlock with a
// passkey made at this address. It never offers to add a passkey, which
// needs a session first.

import { useState, type FormEvent } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import { MIN_PASSWORD_LENGTH, passkeyProblem, setupProblem, type LockSession } from "../lock";
import { lockCall } from "./AuthGate";

type Mode = "setup" | "reset" | "password" | "passkey";

export function LockScreen({ session, start, onUnlocked }: { session: LockSession; start: "setup" | "password" | "passkey"; onUnlocked: () => void }) {
  const [mode, setMode] = useState<Mode>(start);
  const [recovery, setRecovery] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const go = (m: Mode) => {
    setMode(m);
    setError(null);
  };
  const attempt = async (work: () => Promise<unknown>, onFail?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      onUnlocked();
    } catch (e) {
      setError((e as Error).message);
      onFail?.();
      setBusy(false);
    }
  };

  const submitPassword = (e: FormEvent) => {
    e.preventDefault();
    void attempt(() => lockCall("/api/auth/login", { password }));
  };
  const submitSetup = (e: FormEvent) => {
    e.preventDefault();
    const problem = setupProblem({ recovery, password, confirm });
    if (problem) return setError(problem);
    void attempt(() => lockCall(mode === "reset" ? "/api/auth/reset" : "/api/auth/setup", { recovery_secret: recovery, password, confirm }));
  };
  const unlockWithPasskey = () =>
    void attempt(
      async () => {
        const o = await lockCall<{ cid: string; publicKey: Parameters<typeof startAuthentication>[0]["optionsJSON"] }>("/api/auth/passkey/login/options", {});
        let credential;
        try {
          credential = await startAuthentication({ optionsJSON: o.publicKey });
        } catch (e) {
          throw new Error(passkeyProblem(e, "unlock"));
        }
        await lockCall("/api/auth/passkey/login", { cid: o.cid, credential });
      },
      () => setMode("password"),
    );

  const setupish = mode === "setup" || mode === "reset";
  const heading = mode === "setup" ? "Set a password" : mode === "reset" ? "Reset your password" : "Woodchuck is locked";
  const lead = {
    setup: "This is Woodchuck on your tailnet. Prove it's you with the recovery secret from the computer running Woodchuck, then choose a password.",
    reset: "Prove it's you with the recovery secret, then choose a new password. Every signed-in browser is signed out.",
    password: "Sign in with your password to carry on.",
    passkey: "Unlock with the passkey on this device.",
  }[mode];

  return (
    <div className="lock-screen">
      <main className="lock-card" aria-labelledby="lock-heading">
        <p className="brand lock-brand">Woodchuck</p>
        <h1 id="lock-heading">{heading}</h1>
        <p className="lock-lead">{lead}</p>

        {mode === "passkey" && (
          <div className="lock-form">
            <button className="primary lock-submit" disabled={busy} autoFocus onClick={unlockWithPasskey}>
              {busy ? "Waiting for your passkey…" : "Unlock with passkey"}
            </button>
            <button className="link lock-link" onClick={() => go("password")}>
              Use your password
            </button>
          </div>
        )}

        {mode === "password" && (
          <form className="lock-form" onSubmit={submitPassword}>
            {/* A fixed user name, so a password manager files the password under Woodchuck's owner. */}
            <input className="lock-hidden" type="text" name="username" value="woodchuck owner" autoComplete="username" readOnly tabIndex={-1} aria-hidden="true" />
            <label className="lock-field">
              <span>Password</span>
              <input type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <button type="submit" className="primary lock-submit" disabled={busy || !password}>
              {busy ? "Unlocking…" : "Unlock"}
            </button>
          </form>
        )}

        {setupish && (
          <form className="lock-form" onSubmit={submitSetup}>
            <label className="lock-field">
              <span>Recovery secret</span>
              <input type="password" autoComplete="off" autoFocus value={recovery} onChange={(e) => setRecovery(e.target.value)} />
              <small>
                It's <code>WOODCHUCK_RECOVERY_SECRET</code> in <code>.env</code> on the computer running Woodchuck, or the secret Woodchuck's log prints when it starts.
              </small>
            </label>
            <input className="lock-hidden" type="text" name="username" value="woodchuck owner" autoComplete="username" readOnly tabIndex={-1} aria-hidden="true" />
            <label className="lock-field">
              <span>New password</span>
              <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              <small>At least {MIN_PASSWORD_LENGTH} characters.</small>
            </label>
            <label className="lock-field">
              <span>Confirm password</span>
              <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </label>
            <button type="submit" className="primary lock-submit" disabled={busy}>
              {busy ? "Saving…" : mode === "reset" ? "Reset and open Woodchuck" : "Set password and open Woodchuck"}
            </button>
          </form>
        )}

        {error && (
          <p className="form-error lock-error" role="alert">
            {error}
          </p>
        )}

        {mode === "password" && session.enrolled && !session.passkey && (
          <p className="lock-note">
            {session.passkey_elsewhere.length
              ? `There's a passkey for ${session.passkey_elsewhere.join(" and ")}. Open Woodchuck there to use it, or add one for this address under Passkeys once you're in.`
              : "Once you're in, add a passkey under Passkeys to unlock with Face ID or Touch ID next time."}
          </p>
        )}

        {mode === "password" && start === "passkey" && (
          <button className="link lock-link" onClick={() => go("passkey")}>
            Use your passkey
          </button>
        )}
        {(mode === "password" || mode === "reset") && (
          <button className="link lock-link" onClick={() => go(mode === "reset" ? "password" : "reset")}>
            {mode === "reset" ? "Back to your password" : "Forgot it? Reset with the recovery secret"}
          </button>
        )}

        <p className="lock-foot">Signing in keeps this browser in for 24 hours.</p>
      </main>
    </div>
  );
}
