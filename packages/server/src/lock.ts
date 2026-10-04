// The owner lock that stands behind the tailnet fence. An anonymous caller
// on a tailnet address reaches the lock screen and nothing else, and
// loopback stays open so the MCP server, scripts and the browser on this
// computer keep working.
//
// - The everyday sign-in is a password, kept only as a salted scrypt
//   verifier, or a passkey kept as its public key.
// - Setting or resetting the password needs the recovery secret:
//   WOODCHUCK_RECOVERY_SECRET, or a random one made each start and printed
//   only while nothing is enrolled. A process that can't read .env or the
//   log can't enrol itself.
// - A session is a random id in an httpOnly, SameSite=Strict cookie that
//   lasts 24 hours. Only its SHA-256 is stored, so a copy of the data folder
//   can't sign anyone in. The id is 256 random bits, so there's nothing to
//   guess and a plain hash is enough.
//
// Everything lives in one file, lock.json in the data folder, readable by
// the owner alone.

import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const SESSION_COOKIE = "wc_session";
export const SESSION_TTL_MS = 24 * 3600 * 1000;
export const MIN_PASSWORD_LENGTH = 8;
/** scrypt reads all of it, so a giant password is refused before it's hashed. */
export const MAX_PASSWORD_LENGTH = 1024;
/** Far longer than any id this mints (43 characters), so a giant cookie is refused before it's hashed. */
const MAX_SID_LENGTH = 256;

// The same scrypt cost as Crossband and Membro: about 16 MiB per derivation, instant for one
// sign-in and expensive at guessing scale. Stored with each verifier, so it
// can rise later without a migration.
const N = 2 ** 14;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const MAX_MEM = 64 * 1024 * 1024;

interface Verifier {
  alg: "scrypt";
  n: number;
  r: number;
  p: number;
  dklen: number;
  salt: string;
  hash: string;
}

/** A passkey's public half. The private half never leaves the device. */
export interface PasskeyRecord {
  /** The credential id, base64url. */
  id: string;
  /** The public key, base64url. */
  public_key: string;
  counter: number;
  transports?: string[];
  /** The tailnet name or localhost it was made on. */
  rp_id: string;
  origin: string;
  created_at: string;
  last_used_at?: string;
  backed_up: boolean;
}

interface LockFile {
  password?: Verifier;
  /** One stable random handle for the owner, hex. It identifies nothing. */
  user_handle?: string;
  passkeys: PasskeyRecord[];
  /** SHA-256 of each live session id, with when it ends, in ms. */
  sessions: { hash: string; expires_at: number }[];
}

const derive = (password: string, salt: Buffer, v: Pick<Verifier, "n" | "r" | "p" | "dklen">) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, v.dklen, { N: v.n, r: v.r, p: v.p, maxmem: MAX_MEM }, (err, key) => (err ? reject(err) : resolve(key))),
  );

/** A fresh verifier, with a new random salt each time. */
export async function hashPassword(password: string): Promise<Verifier> {
  const salt = randomBytes(16);
  const v = { n: N, r: R, p: P, dklen: KEY_LENGTH };
  return { alg: "scrypt", ...v, salt: salt.toString("hex"), hash: (await derive(password, salt, v)).toString("hex") };
}

/** Recomputes with the stored cost and compares in constant time. A malformed verifier is a plain false. */
export async function verifyPassword(password: string, stored: Verifier | undefined): Promise<boolean> {
  if (!stored || stored.alg !== "scrypt" || password.length > MAX_PASSWORD_LENGTH) return false;
  try {
    const expected = Buffer.from(stored.hash, "hex");
    const got = await derive(password, Buffer.from(stored.salt, "hex"), stored);
    return expected.length === got.length && timingSafeEqual(expected, got);
  } catch {
    return false;
  }
}

export const sidHash = (sid: string) => createHash("sha256").update(sid).digest("hex");

/** Constant-time equality for two strings of any length. */
export function sameSecret(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

/** The session id in a request's Cookie header, if any. */
export function sessionFrom(cookieHeader: string | undefined): string | undefined {
  for (const part of (cookieHeader ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === SESSION_COOKIE) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** The cookie that carries a session. Secure on a tailnet address, which is always HTTPS. */
export function sessionCookie(sid: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${sid}; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

export function clearedCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

export class OwnerLock {
  private file: string;
  private data: LockFile;
  /** True when WOODCHUCK_RECOVERY_SECRET set the secret, so it's never printed. */
  readonly secretConfigured: boolean;
  private readonly secret: string;
  /** Called after sessions are revoked, so open sockets can follow. */
  onRevoke: () => void = () => {};

  constructor(dataDir: string, recoverySecret?: string, private now: () => number = Date.now) {
    mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "lock.json");
    this.data = this.read();
    this.secretConfigured = !!recoverySecret?.trim();
    this.secret = recoverySecret?.trim() || randomBytes(24).toString("base64url");
  }

  private read(): LockFile {
    const empty: LockFile = { passkeys: [], sessions: [] };
    if (!existsSync(this.file)) return empty;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<LockFile>;
      const t = this.now();
      return {
        ...(raw.password ? { password: raw.password } : {}),
        ...(raw.user_handle ? { user_handle: raw.user_handle } : {}),
        passkeys: Array.isArray(raw.passkeys) ? raw.passkeys.filter((p) => p && typeof p.id === "string") : [],
        sessions: Array.isArray(raw.sessions) ? raw.sessions.filter((s) => s && typeof s.hash === "string" && s.expires_at > t) : [],
      };
    } catch {
      console.warn(`Couldn't read ${this.file}, so the owner lock starts with nothing enrolled.`);
      return empty;
    }
  }

  /** Writes the whole file, readable by the owner alone, and swaps it in at once. */
  private save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }

  get enrolled(): boolean {
    return !!this.data.password;
  }

  /** The recovery secret, for the startup log. Only shown while nothing is enrolled. */
  startupLines(tailnet: boolean): string[] {
    if (!tailnet) return ["Remote access is off: WOODCHUCK_TRUSTED_HOSTS is empty, so Woodchuck answers on this computer only."];
    if (this.enrolled) return ["Owner lock: a password is set. Tailnet addresses need a sign-in, and this computer stays open."];
    return [
      "Owner lock: no password yet. Open Woodchuck at its tailnet address and set one.",
      this.secretConfigured
        ? "The recovery secret is WOODCHUCK_RECOVERY_SECRET in .env."
        : `The recovery secret for this start is ${this.secret}`,
    ];
  }

  recoveryOk(given: unknown): boolean {
    return typeof given === "string" && sameSecret(given, this.secret);
  }

  async setPassword(password: string) {
    this.data.password = await hashPassword(password);
    this.save();
  }

  checkPassword(password: string): Promise<boolean> {
    return verifyPassword(password, this.data.password);
  }

  // ---- sessions ----

  /** A fresh random id, never taken from anything the client sent. Only its hash is kept. */
  mintSession(): string {
    const sid = randomBytes(32).toString("base64url");
    const t = this.now();
    this.data.sessions = this.data.sessions.filter((s) => s.expires_at > t);
    this.data.sessions.push({ hash: sidHash(sid), expires_at: t + SESSION_TTL_MS });
    this.save();
    return sid;
  }

  sessionOk(sid: string | undefined): boolean {
    if (!sid || sid.length > MAX_SID_LENGTH) return false;
    return this.hashOk(sidHash(sid));
  }

  /** For an open socket, which keeps the hash of the session it opened with. */
  hashOk(hash: string): boolean {
    const t = this.now();
    return this.data.sessions.some((s) => s.hash === hash && s.expires_at > t);
  }

  revoke(sid: string | undefined) {
    if (!sid || sid.length > MAX_SID_LENGTH) return;
    const h = sidHash(sid);
    const before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter((s) => s.hash !== h);
    if (this.data.sessions.length !== before) this.save();
    this.onRevoke();
  }

  /** A reset or a removed passkey signs every browser out, so a stolen cookie goes with the old credential. */
  revokeAll() {
    this.data.sessions = [];
    this.save();
    this.onRevoke();
  }

  // ---- passkeys ----

  passkeys(): PasskeyRecord[] {
    return [...this.data.passkeys];
  }

  passkeysFor(rpId: string): PasskeyRecord[] {
    return this.data.passkeys.filter((p) => p.rp_id === rpId);
  }

  addPasskey(rec: PasskeyRecord): boolean {
    if (this.data.passkeys.some((p) => p.id === rec.id)) return false;
    this.data.passkeys.push(rec);
    this.save();
    return true;
  }

  removePasskey(id: string): boolean {
    const kept = this.data.passkeys.filter((p) => p.id !== id);
    if (kept.length === this.data.passkeys.length) return false;
    this.data.passkeys = kept;
    this.save();
    return true;
  }

  /** Keeps the signature counter, so a cloned passkey shows up, and when it last unlocked. */
  usedPasskey(id: string, counter: number) {
    const p = this.data.passkeys.find((x) => x.id === id);
    if (!p) return;
    p.counter = counter;
    p.last_used_at = new Date(this.now()).toISOString();
    this.save();
  }

  /** One stable random handle for the single owner, made at the first passkey. */
  userHandle(): Uint8Array<ArrayBuffer> {
    if (!this.data.user_handle) {
      this.data.user_handle = randomBytes(16).toString("hex");
      this.save();
    }
    return new Uint8Array(Buffer.from(this.data.user_handle, "hex"));
  }
}
