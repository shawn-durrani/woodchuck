// The 2D views over HTTP, on the paper the window asks for.

import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/index.js";
import { scriptedClient } from "../src/scripted.js";

let dir: string;
let base: string;
let close: () => Promise<void>;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "woodchuck-views-"));
  const app = createApp({ dataDir: dir, client: scriptedClient([]) });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  close = app.close;
  await fetch(`${base}/api/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Console", example: "record_console" }) });
});
afterAll(async () => {
  await close();
  rmSync(dir, { recursive: true, force: true });
});

const view = async (query: string) => {
  const r = await fetch(`${base}/api/views/front.svg?w=800&h=600${query}`);
  expect(r.headers.get("content-type")).toBe("image/svg+xml");
  return r.text();
};

describe("the 2D views", () => {
  it("are on white paper unless the window asks for another", async () => {
    const svg = await view("");
    expect(svg).toContain('<rect width="800" height="600" fill="#ffffff"/>');
  });

  it("are drawn on the paper of the theme the window wears", async () => {
    const svg = await view("&paper-background=18181b&paper-ink=f4f4f5&paper-mid=a1a1aa");
    expect(svg).toContain('<rect width="800" height="600" fill="#18181b"/>');
    expect(svg).toContain('fill="#f4f4f5">Front');
    expect(svg).toContain('stroke="#a1a1aa"');
  });

  it("draw only colours made of hex digits, so an address can't put anything else in the picture", async () => {
    const svg = await view("&paper-background=%22%20onload%3D%22x&paper-ink=red&paper-mid=12345");
    expect(svg).toBe(await view(""));
    expect(svg).not.toContain("onload");
  });

  it("save the plan views to a file the same way whatever the theme", async () => {
    const png = async (query: string) => Buffer.from(await (await fetch(`${base}/api/plans.png${query}`)).arrayBuffer());
    const plain = await png("");
    expect(plain.subarray(1, 4).toString()).toBe("PNG");
    expect((await png("?paper-background=18181b&paper-ink=f4f4f5")).equals(plain)).toBe(true);
  });
});
