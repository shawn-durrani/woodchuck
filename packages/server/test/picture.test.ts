// A picture comes back even when Chrome is slow to let go of its throwaway
// profile, and a Chrome that won't close gets killed. A small fake
// Chrome stands in for the real one.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, type RmOptions } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chromePicture, type PictureRequest } from "../src/picture.js";

const FAKE = fileURLToPath(new URL("./fakeChrome.mjs", import.meta.url));
const req: PictureRequest = { look: "plain", lighting: "daylight", view: "iso", width: 320, height: 240 };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "woodchuck-picture-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

/** A script that starts the fake Chrome with these settings. */
function fakeChrome(env: Record<string, string> = {}): string {
  const file = path.join(dir, "chrome");
  const exports = Object.entries(env).map(([k, v]) => `export ${k}="${v}"\n`).join("");
  writeFileSync(file, `#!/bin/sh\n${exports}exec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  return file;
}

const notEmpty = () => Object.assign(new Error("ENOTEMPTY: directory not empty, rmdir"), { code: "ENOTEMPTY" });

describe("a picture whose clean-up goes wrong", () => {
  it("tries the profile removal again while Chrome is still writing into it", async () => {
    const tries: { dir: string; opts: RmOptions }[] = [];
    const remove = async (d: string, opts: RmOptions) => {
      tries.push({ dir: d, opts });
      if (tries.length < 3) throw notEmpty();
      await rm(d, opts);
    };
    const take = chromePicture(() => "http://127.0.0.1:1", fakeChrome(), { remove });
    expect((await take(req)).toString()).toBe("a picture");
    expect(tries).toHaveLength(3);
    expect(tries[0]!.opts).toMatchObject({ recursive: true, force: true, maxRetries: expect.any(Number), retryDelay: expect.any(Number) });
    expect(existsSync(tries[0]!.dir)).toBe(false);
  });

  it("still returns the picture when the profile won't go, and says so in the log", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const tries: string[] = [];
    const remove = async (d: string) => {
      tries.push(d);
      throw notEmpty();
    };
    const take = chromePicture(() => "http://127.0.0.1:1", fakeChrome(), { remove });
    expect((await take(req)).toString()).toBe("a picture");
    expect(tries).toHaveLength(3);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("ENOTEMPTY"));
    rmSync(tries[0]!, { recursive: true, force: true });
  });

  it("kills a Chrome that won't close, then removes its profile", async () => {
    const pidFile = path.join(dir, "pid");
    const tries: string[] = [];
    const remove = async (d: string, opts: RmOptions) => {
      tries.push(d);
      await rm(d, opts);
    };
    const chrome = fakeChrome({ FAKE_CHROME_STUBBORN: "1", FAKE_CHROME_PID: pidFile });
    const take = chromePicture(() => "http://127.0.0.1:1", chrome, { remove, exitMs: 300 });
    expect((await take(req)).toString()).toBe("a picture");
    expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0)).toThrow();
    expect(tries).toHaveLength(1);
    expect(existsSync(tries[0]!)).toBe(false);
  });
});
