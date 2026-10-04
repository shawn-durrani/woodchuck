// Helpers for the remote-access tests: raw requests with any Host
// header, and the live-updates socket opened with any headers.

import { request } from "node:http";
import { WebSocket } from "ws";

export type Answer = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

/** A raw request, since fetch won't send a different Host header. */
export function raw(p: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown; port: number }): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers = { ...(body ? { "content-type": "application/json" } : {}), ...opts.headers };
    const req = request({ host: "127.0.0.1", port: opts.port, path: p, method: opts.method ?? (body ? "POST" : "GET"), headers }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** Opens the live-updates socket with these headers. Resolves to "open" or the refusal's status. */
export function socket(port: number, headers: Record<string, string>): Promise<"open" | number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    ws.on("open", () => {
      ws.close();
      resolve("open");
    });
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.on("error", () => resolve(0));
  });
}

/** The session cookie a response set, as a Cookie header value. */
export const cookieOf = (a: Answer) => String(a.headers["set-cookie"] ?? "").split(";")[0]!;
