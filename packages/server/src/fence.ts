// The tailnet fence: who may reach the server at all, before the owner lock
// asks who you are. The server listens on 127.0.0.1 only. Tailscale serve
// passes requests from your own tailnet devices on to it, under a tailnet
// name listed in WOODCHUCK_TRUSTED_HOSTS. Everything here is pure, apart
// from finding and asking the tailscale command, which tests replace.

import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import type { IncomingMessage } from "node:http";
import path from "node:path";

/** The names that mean this computer. A bind address is never a caller, so 0.0.0.0 isn't one. */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "::1"]);
/** The header Tailscale serve adds for a signed-in tailnet user. Through Funnel there's none. */
export const IDENTITY_HEADER = "tailscale-user-login";
/** The HTTPS port scripts/tailscale-serve.sh serves Woodchuck on. */
export const DEFAULT_TAILSCALE_PORT = 8445;
export const DEFAULT_FUNNEL_CHECK_S = 180;
/** The Mac App Store build keeps the command inside the app, off PATH. */
const MAC_TAILSCALE = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

/** A Host header or an origin's host, lowercased, with no port, brackets or trailing dot. "" when unreadable. */
export function hostname(value: string | undefined): string {
  if (!value) return "";
  try {
    const url = new URL(value.includes("://") ? value : `http://${value}`);
    return url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
  } catch {
    return "";
  }
}

export const isLoopback = (host: string) => LOOPBACK_HOSTS.has(host);

/**
 * A caller on this computer: a loopback Host, and no identity header. A
 * request carrying Tailscale's identity came through Tailscale, so it meets
 * the lock whatever host it names.
 */
export const fromThisComputer = (req: IncomingMessage) => isLoopback(hostname(req.headers.host)) && !req.headers[IDENTITY_HEADER];

/** WOODCHUCK_TRUSTED_HOSTS: tailnet names separated by commas. A port or scheme written by mistake is dropped. */
export function parseTrustedHosts(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const h = hostname(part.trim());
    if (h && !isLoopback(h) && !out.includes(h)) out.push(h);
  }
  return out;
}

export interface Fence {
  /** Tailnet names, in the order given. */
  trusted: string[];
  /** Loopback and the trusted names. */
  allowed: ReadonlySet<string>;
  /** Refuse a tailnet request that lacks Tailscale's identity header. */
  identityRequired: boolean;
}

export function makeFence(trusted: string[], identityRequired = true): Fence {
  return { trusted, allowed: new Set([...LOOPBACK_HOSTS, ...trusted]), identityRequired };
}

export type Screened = { ok: true; host: string; loopback: boolean } | { ok: false; status: number; message: string };

/**
 * The fence, for a request or a socket. The Host has to be this computer or
 * a trusted tailnet name, which stops a site that points its own name at
 * 127.0.0.1. A tailnet request needs the identity header Tailscale serve
 * adds, which Funnel never does. An Origin, when the browser sends one, has
 * to name the same place: loopback for loopback, and the same tailnet name
 * for a tailnet request. A caller with no Origin, such as curl, passes.
 */
export function screen(fence: Fence, req: IncomingMessage): Screened {
  const host = hostname(req.headers.host);
  if (!host || !fence.allowed.has(host)) {
    return { ok: false, status: 403, message: "Woodchuck answers on this computer, and on the tailnet names in WOODCHUCK_TRUSTED_HOSTS, only." };
  }
  const loopback = fromThisComputer(req);
  if (!loopback && fence.identityRequired && !req.headers[IDENTITY_HEADER]) {
    return { ok: false, status: 403, message: "This address is served to tailnet devices only." };
  }
  const origin = req.headers.origin;
  if (origin !== undefined) {
    const from = hostname(origin);
    const same = isLoopback(host) ? isLoopback(from) : from === host;
    if (!same) return { ok: false, status: 403, message: "Requests from other sites are refused." };
  }
  return { ok: true, host, loopback };
}

/** A browser marks a request another site made. Only that one value is refused, and only on the API. */
export const crossSite = (req: IncomingMessage, pathname: string) =>
  pathname.startsWith("/api/") && req.headers["sec-fetch-site"] === "cross-site";

/** The server listens on 127.0.0.1 and nowhere else. Any other bind is refused with the reason. */
export function bindHost(value: string | undefined): string {
  const host = (value ?? "").trim() || "127.0.0.1";
  if (host !== "127.0.0.1") {
    throw new Error(
      `Woodchuck refuses to listen on ${host}. It listens on 127.0.0.1 only. To reach it from another device, serve it on your tailnet and list the name in WOODCHUCK_TRUSTED_HOSTS, as docs/REMOTE_ACCESS.md says.`,
    );
  }
  return host;
}

/** Where a browser opens the app: the explicit origin, else https at the first trusted name on the serve port, else loopback. */
export function browserOrigin(opts: { explicit?: string | undefined; trusted: string[]; tailscalePort: number; port: number }): string {
  const clean = cleanOrigin(opts.explicit);
  if (clean) return clean;
  if (opts.trusted[0]) return `https://${opts.trusted[0]}:${opts.tailscalePort}`;
  return `http://127.0.0.1:${opts.port}`;
}

/** `scheme://host[:port]` for an http or https origin, else "". It ends up in a link, so nothing else gets through. */
export function cleanOrigin(value: string | undefined): string {
  if (!value?.trim()) return "";
  try {
    const u = new URL(value.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) return "";
    return `${u.protocol}//${u.host.toLowerCase()}`;
  } catch {
    return "";
  }
}

/** A number of seconds from a setting, with a default. Blank or unreadable is the default, and below zero is zero. */
export function seconds(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, n) : fallback;
}

/** "0", "false", "no" or "off" turn a setting off. Anything else, or nothing, leaves the default. */
export function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

// ---- Funnel ----

/** What `tailscale serve status --json` prints, or null when it fails. */
export type ServeStatus = () => Promise<string | null>;

/** Does a serve handler's proxy target, such as "http://127.0.0.1:8905", name this port? */
function targetsPort(proxy: string, port: number): boolean {
  const hostport = proxy.split("://").pop()!.split("/")[0]!;
  return hostport.slice(hostport.lastIndexOf(":") + 1) === String(port);
}

/**
 * The public address Funnel serves this app's port on, or null. AllowFunnel
 * names the host:port pairs Funnel is on for, and Web says what each one
 * proxies to. A foreground serve keeps its own copy under Foreground.
 * Anything unreadable reads as no exposure, so the check never blocks on a parse.
 */
export function funnelExposes(statusText: string | null, port: number): string | null {
  let cfg: unknown;
  try {
    cfg = JSON.parse(statusText ?? "");
  } catch {
    return null;
  }
  if (!cfg || typeof cfg !== "object") return null;
  type Config = { AllowFunnel?: Record<string, boolean>; Web?: Record<string, { Handlers?: Record<string, { Proxy?: string } | null> } | null> };
  const root = cfg as Config & { Foreground?: Record<string, Config> };
  const configs: Config[] = [root, ...Object.values(root.Foreground ?? {}).filter((c) => c && typeof c === "object")];
  for (const c of configs) {
    for (const [hostport, on] of Object.entries(c.AllowFunnel ?? {})) {
      if (!on) continue;
      const handlers = c.Web?.[hostport]?.Handlers ?? {};
      for (const h of Object.values(handlers)) {
        if (targetsPort(String(h?.Proxy ?? ""), port)) return hostport;
      }
    }
  }
  return null;
}

/** The tailscale command: on PATH, then WOODCHUCK_TAILSCALE_BIN, then inside the Mac app. Null when there's none. Runs nothing. */
export function findTailscale(searchPath: string, named: string | undefined): string | null {
  const runnable = (file: string) => {
    try {
      accessSync(file, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  for (const dir of searchPath.split(path.delimiter)) {
    if (dir && runnable(path.join(dir, "tailscale"))) return path.join(dir, "tailscale");
  }
  if (named && runnable(named)) return named;
  return runnable(MAC_TAILSCALE) ? MAC_TAILSCALE : null;
}

/** Asks Tailscale for its serve config. It only reads, and a missing daemon reads as no answer. */
export function tailscaleServeStatus(bin: string): ServeStatus {
  return () =>
    new Promise((resolve) => {
      execFile(bin, ["serve", "status", "--json"], { timeout: 10_000 }, (err, stdout) => resolve(err ? null : stdout));
    });
}

export function funnelText(exposed: string): string {
  return `Woodchuck has stopped serving because Tailscale Funnel is on for ${exposed}, which puts it on the public internet. Turn Funnel off with "tailscale funnel reset", serve it on your tailnet again as docs/REMOTE_ACCESS.md says, and Woodchuck comes back by itself within a few minutes.`;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The page served in place of the app while Funnel is on. */
export function funnelPage(exposed: string): string {
  return [
    "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "<title>Woodchuck isn't serving</title>",
    "<main style=\"font:16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:36rem;margin:4rem auto;padding:0 16px;color:#2b241d\">",
    "<h1 style=\"font-size:22px\">Woodchuck has stopped serving</h1>",
    `<p>${escapeHtml(funnelText(exposed))}</p></main></html>`,
  ].join("");
}
