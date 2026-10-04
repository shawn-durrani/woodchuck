// A design opened from the record console example says so, so the app
// can open it with a card that explains it. Any other design doesn't.

import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index.js";
import { Store } from "../src/store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "woodchuck-example-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Project = { slug: string; name: string; example?: string };

async function withApp<T>(run: (call: (route: string, body?: unknown) => Promise<{ project: Project }>) => Promise<T>): Promise<T> {
  const app = createApp({ dataDir: dir, watchTools: false });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  try {
    return await run(async (route, body) => {
      if (body !== undefined) {
        const res = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        expect(res.ok).toBe(true);
      }
      return (await (await fetch(`${base}/api/state`)).json()) as { project: Project };
    });
  } finally {
    await app.close();
  }
}

describe("the record console example says what it is", () => {
  it("marks a design opened from the example", async () => {
    const state = await withApp((call) => call("/api/projects", { name: "Record console example", example: "record_console" }));
    expect(state.project.example).toBe("record_console");
  });

  it("leaves a fresh design unmarked", async () => {
    const state = await withApp((call) => call("/api/projects", {}));
    expect(state.project.example).toBeUndefined();
  });

  it("keeps the mark when the example is opened again later", async () => {
    const slug = await withApp(async (call) => (await call("/api/projects", { name: "Record console example", example: "record_console" })).project.slug);
    expect(new Store(dir).open(slug).example).toBe("record_console");
  });
});
