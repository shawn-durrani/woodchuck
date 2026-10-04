// Pictures of the open design, for places that can't run the 3D view
// themselves, such as a chat in Crossband. The server starts a headless
// Chrome on this computer, opens the render-only page (?render=1), waits
// until it says it's ready and takes a screenshot. One picture at a time.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, type RmOptions } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface PictureRequest {
  look: "finished" | "plain";
  lighting: "daylight" | "evening" | "workshop";
  view: "iso" | "front" | "top" | "left" | "right" | "back";
  width: number;
  height: number;
  /** Draw this preview's change without making it. */
  preview?: string;
}

export type TakePicture = (req: PictureRequest) => Promise<Buffer>;

/** How a picture tidies up after itself. Tests pass stand-ins. */
export interface TidyOptions {
  /** Removes a folder. fs.rm, unless a test says otherwise. */
  remove?: (dir: string, opts: RmOptions) => Promise<void>;
  /** How long Chrome gets to exit once it's told to, before it's killed. */
  exitMs?: number;
}

const CHROMES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

/** A Chrome to draw with: WOODCHUCK_CHROME, or the usual install places. */
export function findChrome(): string | null {
  const own = process.env.WOODCHUCK_CHROME;
  if (own && existsSync(own)) return own;
  return CHROMES.find((p) => existsSync(p)) ?? null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(check: () => Promise<T | null> | T | null, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v !== null && v !== undefined) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(150);
  }
}

/** Just enough of the DevTools protocol to load a page and screenshot it. */
async function devtools(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("Couldn't reach Chrome")), { once: true });
  });
  let id = 0;
  const waiting = new Map<number, (v: { result?: Record<string, unknown>; error?: { message: string } }) => void>();
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(String(m.data)) as { id?: number; result?: Record<string, unknown>; error?: { message: string } };
    if (msg.id !== undefined) waiting.get(msg.id)?.(msg);
  });
  return {
    async send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
      const n = ++id;
      const reply = await new Promise<{ result?: Record<string, unknown>; error?: { message: string } }>((resolve) => {
        waiting.set(n, resolve);
        ws.send(JSON.stringify({ id: n, method, params }));
      });
      waiting.delete(n);
      if (reply.error) throw new Error(`Chrome: ${reply.error.message}`);
      return reply.result ?? {};
    },
    close: () => ws.close(),
  };
}

/** True once proc has exited, or false if it's still running after ms. */
function exited(proc: ChildProcess, ms: number): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      proc.off("exit", onExit);
      resolve(false);
    }, ms);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    proc.once("exit", onExit);
  });
}

/**
 * Closes Chrome and removes its throwaway profile. Chrome can go on writing
 * into the profile for a moment after it's told to close, so this waits for
 * it to exit, kills it if it won't, and tries the removal a few times. It
 * never throws, because the picture is already taken.
 */
async function closeChrome(proc: ChildProcess, profile: string, { remove = rm, exitMs = 5_000 }: TidyOptions): Promise<void> {
  proc.kill();
  if (!(await exited(proc, exitMs))) {
    proc.kill("SIGKILL");
    await exited(proc, exitMs);
  }
  for (let attempt = 1; ; attempt++) {
    try {
      // fs.rm tries a busy folder again by itself, waiting longer each time.
      await remove(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch (e) {
      if (attempt === 3) {
        console.error(`Couldn't remove Chrome's profile at ${profile}: ${(e as Error).message}`);
        return;
      }
      await sleep(200 * attempt);
    }
  }
}

async function shoot(baseUrl: string, chrome: string, req: PictureRequest, tidy: TidyOptions): Promise<Buffer> {
  const profile = mkdtempSync(path.join(tmpdir(), "woodchuck-chrome-"));
  const proc = spawn(
    chrome,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      `--window-size=${req.width},${req.height}`,
      // A software GPU, so it draws the same with or without a screen.
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--mute-audio",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  try {
    const port = await until(() => {
      try {
        return readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0] || null;
      } catch {
        return null;
      }
    }, 15_000, "Chrome to start");
    const pages = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
    const page = pages.find((p) => p.type === "page");
    if (!page) throw new Error("Chrome opened no page");
    const cdp = await devtools(page.webSocketDebuggerUrl);
    try {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: req.width, height: req.height, deviceScaleFactor: 1, mobile: false });
      const q = new URLSearchParams({ render: "1", look: req.look, lighting: req.lighting, view: req.view, ...(req.preview ? { preview: req.preview } : {}) });
      await cdp.send("Page.navigate", { url: `${baseUrl}/?${q}` });
      await until(async () => {
        const r = (await cdp.send("Runtime.evaluate", { expression: "document.body.dataset.ready === '1'", returnByValue: true })) as {
          result?: { value?: boolean };
        };
        return r.result?.value === true ? true : null;
      }, 25_000, "the design to draw");
      const shot = (await cdp.send("Page.captureScreenshot", { format: "png" })) as { data: string };
      return Buffer.from(shot.data, "base64");
    } finally {
      cdp.close();
    }
  } finally {
    await closeChrome(proc, profile, tidy);
  }
}

/** Takes pictures with Chrome, one at a time, of the page at baseUrl(). */
export function chromePicture(baseUrl: () => string, chrome: string, tidy: TidyOptions = {}): TakePicture {
  let queue: Promise<unknown> = Promise.resolve();
  return (req) => {
    const run = queue.then(() => shoot(baseUrl(), chrome, req, tidy));
    queue = run.catch(() => undefined);
    return run;
  };
}
