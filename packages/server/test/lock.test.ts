// The owner lock: the password, sessions, loopback staying open, and
// passkeys. The passkey tests sign with a software authenticator, so the
// whole WebAuthn ceremony runs without a browser.

import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "../src/index.js";
import { makeFence } from "../src/fence.js";
import { OwnerLock, sidHash } from "../src/lock.js";
import { originOk, rpForHost } from "../src/lockRoutes.js";
import { scriptedClient } from "../src/scripted.js";
import { cookieOf, raw, socket, type Answer } from "./remote.js";

const TAILNET = "my-mac.my-tailnet.ts.net";
const PAGE = `https://${TAILNET}:8445`;
const SECRET = "fairhaven-recovery-secret";
const PASSWORD = "fairhaven-oak-1";

const root = mkdtempSync(path.join(tmpdir(), "woodchuck-lock-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let dataDir: string;
let port: number;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(root, "data-"));
  const web = path.join(dataDir, "..", "web");
  mkdirSync(web, { recursive: true });
  writeFileSync(path.join(web, "index.html"), "<!doctype html><title>Woodchuck</title><div id=root></div>");
  app = createApp({ dataDir, client: scriptedClient([]), watchTools: false, fence: makeFence([TAILNET]), recoverySecret: SECRET, webDist: web });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  port = (app.server.address() as AddressInfo).port;
});
afterEach(() => app.close());

/** A request on the tailnet name, as Tailscale serve passes it on. */
const tailnet = (p: string, opts: { cookie?: string; body?: unknown; origin?: string } = {}) =>
  raw(p, {
    port,
    headers: { host: `${TAILNET}:8445`, "tailscale-user-login": "alex@example.com", ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.origin ? { origin: opts.origin } : {}) },
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  });
const local = (p: string, body?: unknown) => raw(p, { port, ...(body !== undefined ? { body } : {}) });
const parsed = (a: Answer) => JSON.parse(a.body) as Record<string, unknown>;
const setup = (body: Record<string, unknown>) => tailnet("/api/auth/setup", { body });

describe("an anonymous caller on the tailnet", () => {
  it("gets the lock screen's shell, and 401 on everything else", async () => {
    const shell = await tailnet("/");
    expect(shell.status).toBe(200);
    expect(shell.body).toContain("<div id=root>");
    expect((await tailnet("/some/deep/link")).status).toBe(200);
    for (const p of ["/api/state", "/api/health", "/api/busy", "/api/design.json", "/api/library", "/api/auth/passkeys"]) {
      expect((await tailnet(p)).status, p).toBe(401);
    }
    expect((await tailnet("/api/ops", { body: { ops: [] } })).status).toBe(401);
    expect(await socket(port, { host: TAILNET, "tailscale-user-login": "alex@example.com" })).toBe(401);
    const session = parsed(await tailnet("/api/auth/session"));
    expect(session).toMatchObject({ enrolled: false, authenticated: false, signed_in: false, loopback: false, tailnet: true, passkey: false, app: "woodchuck" });
    expect(session.browser_origin).toBe(`https://${TAILNET}:8445`);
  });
});

describe("the password", () => {
  it("needs the recovery secret to set, then answers 409 once it's set", async () => {
    expect((await setup({ password: PASSWORD, confirm: PASSWORD })).status).toBe(403);
    expect((await setup({ recovery_secret: "wrong", password: PASSWORD, confirm: PASSWORD })).status).toBe(403);
    expect((await setup({ recovery_secret: SECRET, password: "short", confirm: "short" })).status).toBe(400);
    expect((await setup({ recovery_secret: SECRET, password: PASSWORD, confirm: "different-1" })).status).toBe(400);
    const ok = await setup({ recovery_secret: SECRET, password: PASSWORD, confirm: PASSWORD });
    expect(ok.status).toBe(200);
    const set = String(ok.headers["set-cookie"]);
    expect(set).toMatch(/^wc_session=[\w-]{43}; Path=\/; Max-Age=86400; HttpOnly; SameSite=Strict; Secure$/);
    expect((await setup({ recovery_secret: SECRET, password: "another-pass-1" })).status).toBe(409);
    expect(parsed(await tailnet("/api/auth/session", { cookie: cookieOf(ok) }))).toMatchObject({ enrolled: true, authenticated: true, signed_in: true });
  });

  it("signs in with a cookie that opens the API and the socket, and keeps only its hash", async () => {
    await setup({ recovery_secret: SECRET, password: PASSWORD });
    expect((await tailnet("/api/auth/login", { body: { password: "not-the-password" } })).status).toBe(403);
    expect((await tailnet("/api/auth/login", { body: {} })).status).toBe(403);
    const login = await tailnet("/api/auth/login", { body: { password: PASSWORD } });
    expect(login.status).toBe(200);
    const cookie = cookieOf(login);
    expect((await tailnet("/api/state", { cookie })).status).toBe(200);
    expect(await socket(port, { host: TAILNET, "tailscale-user-login": "alex@example.com", cookie, origin: PAGE })).toBe("open");
    expect((await tailnet("/api/state", { cookie: "wc_session=made-up" })).status).toBe(401);

    const file = path.join(dataDir, "lock.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const stored = readFileSync(file, "utf8");
    const sid = cookie.split("=")[1]!;
    expect(stored).not.toContain(sid);
    expect(stored).toContain(sidHash(sid));
    expect(stored).not.toContain(PASSWORD);
    expect(JSON.parse(stored).password).toMatchObject({ alg: "scrypt", n: 16384, r: 8, p: 1 });
  });

  it("signs out one browser, and a reset signs out every one", async () => {
    const first = cookieOf(await setup({ recovery_secret: SECRET, password: PASSWORD }));
    const second = cookieOf(await tailnet("/api/auth/login", { body: { password: PASSWORD } }));
    const open = await openSocket(second);
    const closed = new Promise<number>((r) => open.on("close", (code) => r(code)));

    const out = await tailnet("/api/auth/logout", { cookie: second, body: {} });
    expect(String(out.headers["set-cookie"])).toMatch(/^wc_session=; Path=\/; Max-Age=0/);
    expect((await tailnet("/api/state", { cookie: second })).status).toBe(401);
    expect((await tailnet("/api/state", { cookie: first })).status).toBe(200);
    // Its open socket closes too, and the page locks itself.
    expect(await closed).toBe(4401);

    expect((await tailnet("/api/auth/reset", { body: { recovery_secret: "wrong", password: "brand-new-pass" } })).status).toBe(403);
    const reset = await tailnet("/api/auth/reset", { body: { recovery_secret: SECRET, password: "brand-new-pass", confirm: "brand-new-pass" } });
    expect(reset.status).toBe(200);
    expect((await tailnet("/api/state", { cookie: first })).status).toBe(401);
    expect((await tailnet("/api/state", { cookie: cookieOf(reset) })).status).toBe(200);
    expect((await tailnet("/api/auth/login", { body: { password: PASSWORD } })).status).toBe(403);
    expect((await tailnet("/api/auth/login", { body: { password: "brand-new-pass" } })).status).toBe(200);
  });

  it("keeps sessions through a restart, and ends them after 24 hours", () => {
    let now = Date.parse("2026-10-04T09:00:00Z");
    const dir = mkdtempSync(path.join(root, "restart-"));
    const sid = new OwnerLock(dir, SECRET, () => now).mintSession();
    expect(new OwnerLock(dir, SECRET, () => now).sessionOk(sid)).toBe(true);
    now += 24 * 3600 * 1000 + 1;
    expect(new OwnerLock(dir, SECRET, () => now).sessionOk(sid)).toBe(false);
  });

  it("prints a random recovery secret only while nothing is enrolled", async () => {
    const dir = mkdtempSync(path.join(root, "secret-"));
    const lock = new OwnerLock(dir);
    const lines = lock.startupLines(true).join("\n");
    const secret = /recovery secret for this start is (\S+)/.exec(lines)![1]!;
    expect(lock.recoveryOk(secret)).toBe(true);
    expect(new OwnerLock(dir).recoveryOk(secret)).toBe(false);
    expect(lock.startupLines(false).join("\n")).not.toContain(secret);
    await lock.setPassword(PASSWORD);
    expect(lock.startupLines(true).join("\n")).not.toContain(secret);
    expect(new OwnerLock(dir, SECRET).startupLines(true).join("\n")).not.toContain(SECRET);
  });
});

describe("loopback", () => {
  it("stays open with no session, before and after a password is set", async () => {
    const check = async () => {
      expect((await local("/api/state")).status).toBe(200);
      expect(await (await fetch(`http://127.0.0.1:${port}/api/busy`)).json()).toEqual({ busy: false, reasons: [] });
      expect((await local("/api/ops", { ops: [{ op: "set_param", name: "w", expr: "600", unit: "mm" }] })).status).toBe(200);
      expect(await socket(port, { origin: `http://127.0.0.1:${port}` })).toBe("open");
      expect(parsed(await local("/api/auth/session"))).toMatchObject({ authenticated: true, signed_in: false, loopback: true });
    };
    await check();
    await setup({ recovery_secret: SECRET, password: PASSWORD });
    await check();
    // Managing passkeys needs a real session, even here.
    expect((await local("/api/auth/passkeys")).status).toBe(401);
  });
});

// ---- passkeys ----

describe("where a passkey can work", () => {
  it("refuses an IP address and an untrusted name, and allows localhost and a trusted name", () => {
    expect(rpForHost("127.0.0.1:8905", [TAILNET])).toBeNull();
    expect(rpForHost("[::1]:8905", [TAILNET])).toBeNull();
    expect(rpForHost("100.64.0.7", ["100.64.0.7"])).toBeNull();
    expect(rpForHost("evil.example", [TAILNET])).toBeNull();
    expect(rpForHost("localhost:8905", [])).toBe("localhost");
    expect(rpForHost(`${TAILNET}:8445`, [TAILNET])).toBe(TAILNET);
  });

  it("needs the page's origin to name the same host, over https unless it's localhost", () => {
    expect(originOk(PAGE, `${TAILNET}:8445`)).toBe(true);
    expect(originOk(`http://${TAILNET}:8445`, `${TAILNET}:8445`)).toBe(false);
    expect(originOk("https://evil.example", `${TAILNET}:8445`)).toBe(false);
    expect(originOk(undefined, `${TAILNET}:8445`)).toBe(false);
    expect(originOk("http://localhost:8905", "localhost:8905")).toBe(true);
    expect(originOk("http://127.0.0.1:8905", "127.0.0.1:8905")).toBe(false);
  });

  it("refuses a passkey ceremony at an IP address or from another scheme", async () => {
    const cookie = cookieOf(await setup({ recovery_secret: SECRET, password: PASSWORD }));
    expect((await raw("/api/auth/passkey/login/options", { port, body: {}, headers: { origin: `http://127.0.0.1:${port}` } })).status).toBe(400);
    expect((await tailnet("/api/auth/passkey/register/options", { cookie, body: {}, origin: `http://${TAILNET}:8445` })).status).toBe(400);
    expect((await tailnet("/api/auth/passkey/register/options", { body: {}, origin: PAGE })).status).toBe(401);
    expect((await tailnet("/api/auth/passkey/login/options", { body: {}, origin: PAGE })).status).toBe(400);
  });
});

describe("a passkey, end to end", () => {
  it("is added once signed in, unlocks the tailnet name, and removing it signs everyone else out", async () => {
    const cookie = cookieOf(await setup({ recovery_secret: SECRET, password: PASSWORD }));
    const device = new SoftAuthenticator(TAILNET, PAGE);

    const regOpts = await tailnet("/api/auth/passkey/register/options", { cookie, body: {}, origin: PAGE });
    expect(regOpts.status).toBe(200);
    const reg = parsed(regOpts) as { cid: string; publicKey: Record<string, unknown> & { challenge: string; user: { name: string; displayName: string }; rp: { id: string }; authenticatorSelection: Record<string, string> } };
    expect(reg.publicKey.rp.id).toBe(TAILNET);
    expect(reg.publicKey.user).toMatchObject({ name: "woodchuck owner", displayName: "woodchuck owner" });
    expect(reg.publicKey.authenticatorSelection).toMatchObject({ authenticatorAttachment: "platform", residentKey: "required", userVerification: "required" });
    const added = await tailnet("/api/auth/passkey/register", { cookie, origin: PAGE, body: { cid: reg.cid, credential: device.register(reg.publicKey.challenge) } });
    expect(added.status, added.body).toBe(200);
    // The ceremony is single use.
    expect((await tailnet("/api/auth/passkey/register", { cookie, origin: PAGE, body: { cid: reg.cid, credential: device.register(reg.publicKey.challenge) } })).status).toBe(400);

    const list = parsed(await tailnet("/api/auth/passkeys", { cookie })) as { passkeys: { id: string; rp_id: string; public_key?: string }[] };
    expect(list.passkeys).toHaveLength(1);
    expect(list.passkeys[0]).toMatchObject({ id: device.id, rp_id: TAILNET });
    expect(list.passkeys[0]!.public_key).toBeUndefined();
    expect(parsed(await tailnet("/api/auth/session"))).toMatchObject({ passkey: true, authenticated: false });
    expect(parsed(await local("/api/auth/session"))).toMatchObject({ passkey: false, passkey_elsewhere: [TAILNET] });

    // The lock screen's passkey, narrowed to Woodchuck's own.
    const loginOpts = parsed(await tailnet("/api/auth/passkey/login/options", { body: {}, origin: PAGE })) as { cid: string; publicKey: { challenge: string; allowCredentials: { id: string }[]; userVerification: string } };
    expect(loginOpts.publicKey.allowCredentials.map((c) => c.id)).toEqual([device.id]);
    expect(loginOpts.publicKey.userVerification).toBe("required");
    const wrong = new SoftAuthenticator(TAILNET, PAGE);
    expect((await tailnet("/api/auth/passkey/login", { origin: PAGE, body: { cid: loginOpts.cid, credential: { ...wrong.assert(loginOpts.publicKey.challenge), id: device.id, rawId: device.id } } })).status).toBe(403);
    const again = parsed(await tailnet("/api/auth/passkey/login/options", { body: {}, origin: PAGE })) as typeof loginOpts;
    const unlocked = await tailnet("/api/auth/passkey/login", { origin: PAGE, body: { cid: again.cid, credential: device.assert(again.publicKey.challenge) } });
    expect(unlocked.status, unlocked.body).toBe(200);
    const phone = cookieOf(unlocked);
    expect((await tailnet("/api/state", { cookie: phone })).status).toBe(200);

    const removed = await tailnet("/api/auth/passkeys/remove", { cookie, origin: PAGE, body: { id: device.id } });
    expect(removed.status).toBe(200);
    expect((await tailnet("/api/state", { cookie: phone })).status).toBe(401);
    expect((await tailnet("/api/state", { cookie })).status).toBe(401);
    expect((await tailnet("/api/state", { cookie: cookieOf(removed) })).status).toBe(200);
    expect(parsed(await tailnet("/api/auth/session"))).toMatchObject({ passkey: false });
  });
});

function openSocket(cookie: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { host: TAILNET, "tailscale-user-login": "alex@example.com", cookie, origin: PAGE } });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

// ---- a software authenticator: an ES256 key, packed into WebAuthn's shapes ----

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");

/** Enough CBOR for an attestation object and a COSE key. */
function cbor(v: unknown): Buffer {
  const head = (major: number, n: number) =>
    n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error(`can't encode ${typeof v}`);
}

class SoftAuthenticator {
  readonly id = b64u(randomBytes(16));
  private key: KeyObject;
  private publicKey: KeyObject;
  private counter = 0;
  constructor(
    private rpId: string,
    private origin: string,
  ) {
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.key = pair.privateKey;
    this.publicKey = pair.publicKey;
  }

  private clientData(type: string, challenge: string) {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }));
  }

  private authData(flags: number, extra: Buffer = Buffer.alloc(0)) {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(++this.counter);
    return Buffer.concat([createHash("sha256").update(this.rpId).digest(), Buffer.from([flags]), count, extra]);
  }

  register(challenge: string) {
    const jwk = this.publicKey.export({ format: "jwk" });
    const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]));
    const idBytes = Buffer.from(this.id, "base64url");
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(idBytes.length);
    // User present, user verified, attested credential data.
    const authData = this.authData(0x45, Buffer.concat([Buffer.alloc(16), idLength, idBytes, cose]));
    const attestation = cbor(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
      response: { clientDataJSON: b64u(this.clientData("webauthn.create", challenge)), attestationObject: b64u(attestation), transports: ["internal"] },
    };
  }

  assert(challenge: string) {
    const clientData = this.clientData("webauthn.get", challenge);
    const authData = this.authData(0x05);
    const signature = createSign("SHA256").update(Buffer.concat([authData, createHash("sha256").update(clientData).digest()])).sign(this.key);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(signature) },
    };
  }
}
