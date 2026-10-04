// The owner lock's routes under /api/auth: the session probe, setting the
// password, signing in and out, resetting, and passkeys. The login surface
// is reachable with no session, and each write there proves the recovery
// secret, the password or a passkey. Managing passkeys needs a session.

import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { fromThisComputer, hostname, type Fence } from "./fence.js";
import { clearedCookie, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, sessionCookie, sessionFrom, type OwnerLock, type PasskeyRecord } from "./lock.js";

/**
 * The only /api paths an anonymous tailnet caller may reach. The two passkey
 * sign-in steps are here because they're how a session comes to exist.
 * Adding a passkey isn't: that needs a session.
 */
export const LOGIN_SURFACE: ReadonlySet<string> = new Set([
  "/api/auth/session",
  "/api/auth/setup",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/reset",
  "/api/auth/passkey/login/options",
  "/api/auth/passkey/login",
]);

/** The name a passkey is saved under. Apps on one tailnet name share a relying party, so each names itself. */
export const PASSKEY_USER = "woodchuck owner";
const CEREMONY_TTL_MS = 5 * 60_000;
/** EdDSA, ES256 and RS256, which every platform passkey uses. Naming them skips the library's probe of experimental crypto. */
const ALGORITHMS = [-8, -7, -257];

/**
 * The WebAuthn relying party a request on this host may use, or null where
 * passkeys can't work. Browsers refuse an IP address. localhost always
 * works, and any other name has to be one you trusted.
 */
export function rpForHost(host: string, trusted: readonly string[]): string | null {
  const h = hostname(host);
  if (!h || isIP(h)) return null;
  if (h === "localhost") return h;
  return trusted.includes(h) ? h : null;
}

/** The page's Origin has to name this same host: over https, or plain http for localhost alone. */
export function originOk(origin: string | undefined, host: string): boolean {
  if (!origin) return false;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  const o = hostname(u.host);
  if (!o || o !== hostname(host)) return false;
  return u.protocol === "https:" || (u.protocol === "http:" && o === "localhost");
}

interface Ceremony {
  purpose: "register" | "login";
  challenge: string;
  rpId: string;
  origin: string;
  expires: number;
}

export interface LockRoutes {
  lock: OwnerLock;
  fence: Fence;
  browserOrigin: string;
}

export function lockRoutes(ctx: LockRoutes) {
  const { lock, fence } = ctx;
  const ceremonies = new Map<string, Ceremony>();

  const mint = (c: Omit<Ceremony, "expires">) => {
    const t = Date.now();
    for (const [k, v] of ceremonies) if (v.expires < t) ceremonies.delete(k);
    const cid = randomBytes(18).toString("base64url");
    ceremonies.set(cid, { ...c, expires: t + CEREMONY_TTL_MS });
    return cid;
  };
  const take = (cid: unknown, purpose: Ceremony["purpose"]) => {
    const c = typeof cid === "string" ? ceremonies.get(cid) : undefined;
    if (c) ceremonies.delete(cid as string);
    return c && c.purpose === purpose && c.expires >= Date.now() ? c : null;
  };
  /** The relying party and origin for a passkey ceremony on this request, or null where it can't happen. */
  const ceremonyContext = (req: IncomingMessage) => {
    const host = req.headers.host ?? "";
    const rpId = rpForHost(host, fence.trusted);
    const origin = req.headers.origin;
    return rpId && origin && originOk(origin, host) ? { rpId, origin } : null;
  };

  /** Handles one /api/auth route. False when the path isn't one of them. */
  return async function handle(req: IncomingMessage, res: ServerResponse, pathname: string, readBody: () => Promise<Record<string, unknown>>): Promise<boolean> {
    const json = (status: number, body: unknown, cookie?: string) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...(cookie ? { "set-cookie": cookie } : {}) });
      res.end(JSON.stringify(body));
      return true;
    };
    const fail = (status: number, error: string) => json(status, { error });
    const loopback = fromThisComputer(req);
    const sid = sessionFrom(req.headers.cookie);
    const signedIn = lock.sessionOk(sid);
    const signIn = () => sessionCookie(lock.mintSession(), !loopback);
    const route = `${req.method} ${pathname}`;

    switch (route) {
      // The lock screen's view switch, and a health answer other apps read.
      case "GET /api/auth/session": {
        const rp = rpForHost(req.headers.host ?? "", fence.trusted);
        const all = lock.passkeys();
        const passkey = lock.enrolled && !!rp && all.some((p) => p.rp_id === rp);
        return json(200, {
          enrolled: lock.enrolled,
          authenticated: loopback || signedIn,
          signed_in: signedIn,
          loopback,
          tailnet: fence.trusted.length > 0,
          passkey,
          // Where a passkey is, when there's none here, so the lock screen can say so.
          passkey_elsewhere: lock.enrolled && !passkey ? [...new Set(all.map((p) => p.rp_id))].sort() : [],
          app: "woodchuck",
          browser_origin: ctx.browserOrigin,
        });
      }
      case "POST /api/auth/setup":
      case "POST /api/auth/reset": {
        const reset = route === "POST /api/auth/reset";
        if (!reset && lock.enrolled) return fail(409, "A password is already set. Reset it with the recovery secret.");
        const b = await readBody();
        if (!lock.recoveryOk(b.recovery_secret)) {
          return fail(403, "That recovery secret doesn't match WOODCHUCK_RECOVERY_SECRET or the one in this start's log.");
        }
        const password = typeof b.password === "string" ? b.password : "";
        if (b.confirm !== undefined && b.confirm !== password) return fail(400, "The two passwords don't match.");
        if (password.length < MIN_PASSWORD_LENGTH) return fail(400, `The password needs at least ${MIN_PASSWORD_LENGTH} characters.`);
        if (password.length > MAX_PASSWORD_LENGTH) return fail(400, `The password can have at most ${MAX_PASSWORD_LENGTH} characters.`);
        await lock.setPassword(password);
        if (reset) lock.revokeAll();
        console.log(`Owner lock: the password was ${reset ? "reset, and every browser was signed out" : "set"}.`);
        return json(200, { ok: true }, signIn());
      }
      case "POST /api/auth/login": {
        const b = await readBody();
        const ok = typeof b.password === "string" && (await lock.checkPassword(b.password));
        if (!ok) return fail(403, "That password isn't right.");
        return json(200, { ok: true }, signIn());
      }
      // Revokes this session on the server, so every copy of the cookie stops working.
      case "POST /api/auth/logout": {
        lock.revoke(sid);
        return json(200, { ok: true }, clearedCookie(!loopback));
      }
      case "POST /api/auth/passkey/login/options": {
        const c = ceremonyContext(req);
        if (!c) return fail(400, "Passkeys don't work at this address.");
        const rows = lock.passkeysFor(c.rpId);
        if (!rows.length) return fail(400, "There's no passkey for this address yet.");
        // Narrowed to Woodchuck's own passkeys, since other apps on the same tailnet name share a relying party.
        const options = await generateAuthenticationOptions({
          rpID: c.rpId,
          allowCredentials: rows.map((r) => ({ id: r.id, ...(r.transports ? { transports: r.transports } : {}) })),
          userVerification: "required",
        });
        return json(200, { cid: mint({ purpose: "login", challenge: options.challenge, ...c }), publicKey: options });
      }
      // Every failure is the same 403, so an anonymous caller learns nothing about which part was wrong.
      case "POST /api/auth/passkey/login": {
        const b = await readBody();
        const c = take(b.cid, "login");
        const response = b.credential as AuthenticationResponseJSON | undefined;
        const rec = c && response && typeof response.id === "string" ? lock.passkeysFor(c.rpId).find((p) => p.id === response.id) : undefined;
        if (!c || !response || !rec) return fail(403, "That passkey wasn't recognised.");
        try {
          const v = await verifyAuthenticationResponse({
            response,
            expectedChallenge: c.challenge,
            expectedOrigin: c.origin,
            expectedRPID: c.rpId,
            credential: { id: rec.id, publicKey: new Uint8Array(Buffer.from(rec.public_key, "base64url")), counter: rec.counter, ...(rec.transports ? { transports: rec.transports } : {}) },
            requireUserVerification: true,
          });
          if (!v.verified) return fail(403, "That passkey wasn't recognised.");
          lock.usedPasskey(rec.id, v.authenticationInfo.newCounter);
        } catch {
          return fail(403, "That passkey wasn't recognised.");
        }
        return json(200, { ok: true }, signIn());
      }
    }

    // Managing passkeys needs a real session, on this computer too.
    const manage = ["POST /api/auth/passkey/register/options", "POST /api/auth/passkey/register", "GET /api/auth/passkeys", "POST /api/auth/passkeys/remove"];
    if (!manage.includes(route)) return false;
    if (!signedIn) return fail(401, "Sign in at Woodchuck's tailnet address to manage passkeys.");

    switch (route) {
      case "POST /api/auth/passkey/register/options": {
        if (!lock.enrolled) return fail(409, "Set a password first. A passkey always has it behind it.");
        const c = ceremonyContext(req);
        if (!c) return fail(400, "Passkeys need a tailnet address over https, or http://localhost. An IP address such as 127.0.0.1 can't hold one.");
        const options = await generateRegistrationOptions({
          rpName: "Woodchuck",
          rpID: c.rpId,
          userID: lock.userHandle(),
          userName: PASSKEY_USER,
          userDisplayName: PASSKEY_USER,
          attestationType: "none",
          supportedAlgorithmIDs: ALGORITHMS,
          authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "required", userVerification: "required" },
          excludeCredentials: lock.passkeysFor(c.rpId).map((r) => ({ id: r.id, ...(r.transports ? { transports: r.transports } : {}) })),
        });
        return json(200, { cid: mint({ purpose: "register", challenge: options.challenge, ...c }), publicKey: options });
      }
      case "POST /api/auth/passkey/register": {
        const b = await readBody();
        const c = take(b.cid, "register");
        if (!c) return fail(400, "That passkey request ran out of time. Start again.");
        let rec: PasskeyRecord;
        try {
          const v = await verifyRegistrationResponse({
            response: b.credential as RegistrationResponseJSON,
            expectedChallenge: c.challenge,
            expectedOrigin: c.origin,
            expectedRPID: c.rpId,
            requireUserVerification: true,
            supportedAlgorithmIDs: ALGORITHMS,
          });
          if (!v.verified) throw new Error("not verified");
          const cred = v.registrationInfo.credential;
          rec = {
            id: cred.id,
            public_key: Buffer.from(cred.publicKey).toString("base64url"),
            counter: cred.counter,
            ...(cred.transports ? { transports: cred.transports } : {}),
            rp_id: c.rpId,
            origin: c.origin,
            created_at: new Date().toISOString(),
            backed_up: v.registrationInfo.credentialBackedUp,
          };
        } catch {
          return fail(400, "The browser's passkey didn't check out.");
        }
        if (!lock.addPasskey(rec)) return fail(409, "That passkey is already added.");
        console.log(`Owner lock: a passkey was added for ${c.rpId}.`);
        return json(200, { ok: true, passkey: publicView(rec) });
      }
      case "GET /api/auth/passkeys":
        return json(200, { passkeys: lock.passkeys().map(publicView) });
      // Removing a passkey signs out every other browser, since you remove one when a device is lost.
      case "POST /api/auth/passkeys/remove": {
        const id = String((await readBody()).id ?? "");
        if (!lock.removePasskey(id)) return fail(404, "There's no passkey with that id.");
        lock.revokeAll();
        return json(200, { ok: true }, signIn());
      }
    }
    return false;
  };
}

/** What the Passkeys section shows. Never the public key. */
function publicView(p: PasskeyRecord) {
  return { id: p.id, rp_id: p.rp_id, created_at: p.created_at, last_used_at: p.last_used_at ?? null, backed_up: p.backed_up };
}
