// The tailnet fence: which hosts the server answers, Funnel, cross-site
// requests and the live-updates socket. No real tailscale command runs here:
// the Funnel check reads a stand-in's answer.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/index.js";
import { scriptedClient } from "../src/scripted.js";
import { cookieOf, raw, socket } from "./remote.js";
import {
  bindHost,
  browserOrigin,
  cleanOrigin,
  findTailscale,
  flag,
  funnelExposes,
  hostname,
  makeFence,
  parseTrustedHosts,
  seconds,
} from "../src/fence.js";

const TAILNET = "my-mac.my-tailnet.ts.net";
const SECRET = "fairhaven-recovery-secret";
const IDENTITY = { "tailscale-user-login": "alex@example.com" };

let dir: string;
let port: number;
let app: ReturnType<typeof createApp>;
/** What the stand-in for `tailscale serve status --json` prints next. */
let serveStatus: string | null = null;
let cookie = "";

const get = (p: string, headers: Record<string, string> = {}) => raw(p, { headers, port });
const tailnet = (extra: Record<string, string> = {}) => ({ host: `${TAILNET}:8445`, ...IDENTITY, ...extra });

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "woodchuck-tailnet-"));
  const web = path.join(dir, "web");
  mkdirSync(web, { recursive: true });
  writeFileSync(path.join(web, "index.html"), "<!doctype html><title>Woodchuck</title><div id=root></div>");
  app = createApp({
    dataDir: path.join(dir, "data"),
    client: scriptedClient([]),
    watchTools: false,
    fence: makeFence([TAILNET]),
    recoverySecret: SECRET,
    webDist: web,
    funnel: { status: async () => serveStatus, everyS: 0 },
  });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  port = (app.server.address() as AddressInfo).port;
  const setup = await raw("/api/auth/setup", { headers: tailnet(), body: { recovery_secret: SECRET, password: "fairhaven-oak-1", confirm: "fairhaven-oak-1" }, port });
  expect(setup.status).toBe(200);
  cookie = cookieOf(setup);
});
afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the tailnet fence", () => {
  it("answers a trusted tailnet name and refuses a lookalike", async () => {
    expect((await get("/api/state", tailnet({ cookie }))).status).toBe(200);
    // Case and a trailing dot don't matter, the port is dropped.
    expect((await get("/api/state", { ...IDENTITY, cookie, host: `${TAILNET.toUpperCase()}.` })).status).toBe(200);
    for (const host of [`${TAILNET}.evil.example`, `evil-${TAILNET}`, TAILNET.slice(TAILNET.indexOf(".") + 1), "evil.example"]) {
      const r = await get("/api/state", { ...IDENTITY, cookie, host });
      expect(r.status, host).toBe(403);
      expect(JSON.parse(r.body).error).toMatch(/WOODCHUCK_TRUSTED_HOSTS/);
    }
    expect((await get("/", { ...IDENTITY, host: "evil.example" })).status).toBe(403);
  });

  it("refuses a trusted name without Tailscale's identity header, which Funnel never adds", async () => {
    const r = await get("/api/state", { host: TAILNET, cookie });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body).error).toBe("This address is served to tailnet devices only.");
    expect((await get("/", { host: TAILNET })).status).toBe(403);
    expect(await socket(port, { host: TAILNET, cookie })).toBe(403);
    // Loopback never carries the header and is never asked for it.
    expect((await get("/api/state")).status).toBe(200);
  });

  it("locks a request Tailscale passed on, even when it names this computer", async () => {
    expect((await get("/api/state", IDENTITY)).status).toBe(401);
    expect((await get("/api/state", { ...IDENTITY, cookie })).status).toBe(200);
    expect(JSON.parse((await get("/api/auth/session", IDENTITY)).body)).toMatchObject({ loopback: false, authenticated: false });
    expect(await socket(port, { ...IDENTITY })).toBe(401);
  });

  it("can drop the identity check when you turn it off", async () => {
    const loose = createApp({ dataDir: path.join(dir, "loose"), client: scriptedClient([]), watchTools: false, fence: makeFence([TAILNET], false) });
    await new Promise<void>((r) => loose.server.listen(0, "127.0.0.1", r));
    const p = (loose.server.address() as AddressInfo).port;
    try {
      expect((await raw("/api/auth/session", { headers: { host: TAILNET }, port: p })).status).toBe(200);
      expect((await raw("/api/state", { headers: { host: TAILNET }, port: p })).status).toBe(401);
    } finally {
      await loose.close();
    }
  });

  it("refuses a cross-site request to the API on every host, and lets same-site through", async () => {
    expect((await get("/api/state", { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await get("/api/state", tailnet({ cookie, "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect((await raw("/api/undo", { headers: { "sec-fetch-site": "cross-site" }, body: {}, port })).status).toBe(403);
    expect((await get("/api/state", { "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect((await get("/api/state", tailnet({ cookie, "sec-fetch-site": "same-site" }))).status).toBe(200);
  });

  it("accepts an Origin only from the place the request is sent to", async () => {
    const page = `https://${TAILNET}:8445`;
    expect((await get("/api/state", tailnet({ cookie, origin: page }))).status).toBe(200);
    expect((await get("/api/state", tailnet({ cookie, origin: "https://evil.example" }))).status).toBe(403);
    // A tailnet page can't reach the API on loopback, and the reverse.
    expect((await get("/api/state", { origin: page })).status).toBe(403);
    expect((await get("/api/state", tailnet({ cookie, origin: `http://127.0.0.1:${port}` }))).status).toBe(403);
    expect((await get("/api/state", { origin: `http://localhost:${port}` })).status).toBe(200);
  });

  it("checks the live-updates socket like a request: host, identity, Origin and session", async () => {
    const page = `https://${TAILNET}:8445`;
    expect(await socket(port, tailnet({ cookie, origin: page }))).toBe("open");
    expect(await socket(port, tailnet({ cookie, origin: "https://evil.example" }))).toBe(403);
    // A caller with no Origin, such as a script, passes, as over HTTP.
    expect(await socket(port, tailnet({ cookie }))).toBe("open");
    expect(await socket(port, tailnet({ origin: page }))).toBe(401);
    expect(await socket(port, { ...IDENTITY, cookie, host: "evil.example", origin: "https://evil.example" })).toBe(403);
    expect(await socket(port, { origin: `http://127.0.0.1:${port}` })).toBe("open");
    expect(await socket(port, { origin: "https://evil.example" })).toBe(403);
  });

  it("serves nothing while Funnel is on for its port, then comes back", async () => {
    const config = (p: number, on: boolean) =>
      JSON.stringify({
        TCP: { "443": { HTTPS: true } },
        Web: { [`${TAILNET}:443`]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${p}` } } } },
        AllowFunnel: { [`${TAILNET}:443`]: on },
      });
    // Funnel on for some other app's port doesn't count.
    serveStatus = config(port + 1, true);
    expect(await app.checkFunnel()).toBeNull();
    serveStatus = config(port, true);
    expect(await app.checkFunnel()).toBe(`${TAILNET}:443`);
    const api = await get("/api/state");
    expect(api.status).toBe(503);
    expect(JSON.parse(api.body).error).toMatch(/Tailscale Funnel is on/);
    const page = await get("/", tailnet());
    expect(page.status).toBe(503);
    expect(page.headers["content-type"]).toMatch(/text\/html/);
    expect(page.body).toContain("Woodchuck has stopped serving");
    expect((await get("/api/auth/session", tailnet())).status).toBe(503);
    expect(await socket(port, {})).toBe(503);
    // A restart script still hears whether it's busy and up, on loopback only.
    expect((await get("/api/busy")).status).toBe(200);
    expect((await get("/api/health")).status).toBe(200);
    expect((await get("/api/health", tailnet({ cookie }))).status).toBe(503);
    // A failed or unreadable answer reads as no Funnel.
    serveStatus = null;
    expect(await app.checkFunnel()).toBeNull();
    expect((await get("/api/state")).status).toBe(200);
  });
});

describe("the fence's rules", () => {
  it("reads trusted names however they're written", () => {
    expect(parseTrustedHosts(` ${TAILNET.toUpperCase()}. , https://my-ipad.my-tailnet.ts.net:8445, ,127.0.0.1,${TAILNET}`)).toEqual([
      TAILNET,
      "my-ipad.my-tailnet.ts.net",
    ]);
    expect(parseTrustedHosts(undefined)).toEqual([]);
    expect(hostname("[::1]:8905")).toBe("::1");
  });

  it("listens on 127.0.0.1 and refuses any other address", () => {
    expect(bindHost(undefined)).toBe("127.0.0.1");
    expect(bindHost(" 127.0.0.1 ")).toBe("127.0.0.1");
    for (const h of ["0.0.0.0", "::", "100.64.0.1", "localhost", "::1"]) expect(() => bindHost(h), h).toThrow(/127\.0\.0\.1 only/);
  });

  it("advertises where a browser opens the app", () => {
    expect(browserOrigin({ trusted: [], tailscalePort: 8445, port: 8905 })).toBe("http://127.0.0.1:8905");
    expect(browserOrigin({ trusted: [TAILNET], tailscalePort: 8445, port: 8905 })).toBe(`https://${TAILNET}:8445`);
    expect(browserOrigin({ explicit: "https://Woodchuck.Example.com/", trusted: [TAILNET], tailscalePort: 8445, port: 8905 })).toBe(
      "https://woodchuck.example.com",
    );
    expect(cleanOrigin("javascript:alert(1)")).toBe("");
    expect(cleanOrigin("https://example.com/path")).toBe("");
    expect(cleanOrigin("https://you@example.com")).toBe("");
  });

  it("reads Funnel from Tailscale's serve config, foreground serves included", () => {
    const fg = { Foreground: { abc: { Web: { [`${TAILNET}:8445`]: { Handlers: { "/": { Proxy: "127.0.0.1:8905" } } } }, AllowFunnel: { [`${TAILNET}:8445`]: true } } } };
    expect(funnelExposes(JSON.stringify(fg), 8905)).toBe(`${TAILNET}:8445`);
    expect(funnelExposes(JSON.stringify(fg), 8901)).toBeNull();
    expect(funnelExposes("not json", 8905)).toBeNull();
    expect(funnelExposes(JSON.stringify({ AllowFunnel: { [`${TAILNET}:443`]: false } }), 8905)).toBeNull();
  });

  it("finds the tailscale command on PATH first, then WOODCHUCK_TAILSCALE_BIN, without running it", () => {
    const bin = mkdtempSync(path.join(tmpdir(), "woodchuck-bin-"));
    const fake = path.join(bin, "tailscale");
    // It would fail loudly if it ran.
    writeFileSync(fake, "#!/bin/sh\nexit 99\n");
    chmodSync(fake, 0o755);
    try {
      expect(findTailscale(bin, "/nowhere/tailscale")).toBe(fake);
      expect(findTailscale("", fake)).toBe(fake);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("reads seconds and on-off settings with their defaults", () => {
    expect(seconds(undefined, 180)).toBe(180);
    expect(seconds("0", 180)).toBe(0);
    expect(seconds("-5", 180)).toBe(0);
    expect(seconds("soon", 180)).toBe(180);
    expect(flag(undefined, true)).toBe(true);
    expect(flag("0", true)).toBe(false);
    expect(flag("off", true)).toBe(false);
    expect(flag("1", true)).toBe(true);
  });
});
