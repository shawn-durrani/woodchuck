import { describe, expect, it } from "vitest";
import { gateView, lockEvents, passkeyProblem, setupProblem, watchForLock, type LockSession } from "../src/lock.js";

const session = (s: Partial<LockSession>): LockSession => ({
  enrolled: true,
  authenticated: false,
  signed_in: false,
  loopback: false,
  tailnet: true,
  passkey: false,
  passkey_elsewhere: [],
  app: "woodchuck",
  browser_origin: "https://my-mac.my-tailnet.ts.net:8445",
  ...s,
});

describe("the lock screen's face", () => {
  it("waits for the server's answer", () => {
    expect(gateView(null)).toBe("probing");
    expect(gateView(undefined, true)).toBe("probing");
  });

  it("opens on this computer and for a signed-in browser, enrolled or not", () => {
    expect(gateView(session({ enrolled: false, authenticated: true, loopback: true }))).toBe("open");
    expect(gateView(session({ authenticated: true, loopback: true }))).toBe("open");
    expect(gateView(session({ authenticated: true, signed_in: true, passkey: true }), true)).toBe("open");
  });

  it("asks a tailnet browser to set the password while none is set", () => {
    expect(gateView(session({ enrolled: false }))).toBe("setup");
    expect(gateView(session({ enrolled: false, passkey: true }), true)).toBe("setup");
  });

  it("leads with a passkey only where one exists and the browser can use it", () => {
    expect(gateView(session({ passkey: true }), true)).toBe("passkey");
    expect(gateView(session({ passkey: true }), false)).toBe("password");
    expect(gateView(session({ passkey: false, passkey_elsewhere: ["localhost"] }), true)).toBe("password");
  });
});

describe("the setup form's own check", () => {
  it("matches the server: a secret, eight characters, and the same password twice", () => {
    expect(setupProblem({ recovery: "", password: "long-enough-1", confirm: "long-enough-1" })).toMatch(/recovery secret/);
    expect(setupProblem({ recovery: "s", password: "short", confirm: "short" })).toMatch(/at least 8/);
    expect(setupProblem({ recovery: "s", password: "long-enough-1", confirm: "long-enough-2" })).toMatch(/don't match/);
    expect(setupProblem({ recovery: "s", password: "12345678", confirm: "12345678" })).toBeNull();
  });
});

describe("locking again on a 401", () => {
  it("locks when the API turns this browser away, but not for the lock's own routes", async () => {
    let status = 200;
    const target = { fetch: (async () => new Response("{}", { status })) as typeof fetch };
    let locked = 0;
    const count = () => locked++;
    lockEvents.addEventListener("locked", count);
    const undo = watchForLock(target);
    try {
      await target.fetch("/api/state");
      expect(locked).toBe(0);
      status = 401;
      await target.fetch("/api/state");
      await target.fetch(new URL("http://localhost/api/ops"), { method: "POST" });
      expect(locked).toBe(2);
      await target.fetch("/api/auth/login", { method: "POST" });
      await target.fetch("/api/auth/passkeys");
      await target.fetch("https://elsewhere.example/api/state");
      expect(locked).toBe(2);
    } finally {
      undo();
      lockEvents.removeEventListener("locked", count);
    }
    status = 401;
    await target.fetch("/api/state");
    expect(locked).toBe(2);
  });

  it("puts a closed or timed-out passkey prompt in plain words", () => {
    const closed = Object.assign(new Error("x"), { name: "NotAllowedError" });
    expect(passkeyProblem(closed, "unlock")).toMatch(/use your password/);
    expect(passkeyProblem(closed, "add")).toMatch(/nothing was added/);
    expect(passkeyProblem(Object.assign(new Error("x"), { name: "InvalidStateError" }), "add")).toMatch(/already has a passkey/);
  });
});
