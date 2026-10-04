// Previews: Claude shows a change on a copy of the design, and it's only
// made when the woodworker clicks Apply.

import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/index.js";
import { scriptedClient } from "../src/scripted.js";

const preview = (id: string, expr: string) => [
  {
    type: "tool_use",
    id,
    name: "preview_change",
    input: { title: "Deeper top", explanation: "A deeper top overhangs the front.", ops: [{ op: "set_param", name: "top_depth", expr, unit: "mm" }] },
  },
];
const client = scriptedClient([
  preview("p1", "550"),
  [{ type: "text", text: "Done." }],
  preview("p2", "600"),
  [{ type: "text", text: "Left it." }],
  [{ type: "tool_use", id: "j1", name: "show_joint", input: { type: "mortise_tenon", note: "For the legs" } }],
  [{ type: "text", text: "That's a mortise and tenon." }],
]);

let dir: string;
let base: string;
let close: () => Promise<void>;
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "woodchuck-preview-"));
  const app = createApp({ dataDir: dir, client, watchTools: false });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  close = app.close;
});
afterAll(async () => {
  await close();
  rmSync(dir, { recursive: true, force: true });
});

const post = (p: string, body: unknown) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
type State = {
  waiting: string[];
  design: { params: { name: string; expr: string }[] };
  chat: { kind: string; id: string; status?: string; joint?: string; note?: string }[];
};
async function settle(): Promise<State> {
  for (let i = 0; i < 100; i++) {
    const busy = (await (await fetch(`${base}/api/busy`)).json()) as { busy: boolean };
    if (!busy.busy) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  return (await (await fetch(`${base}/api/state`)).json()) as State;
}
const depth = (s: State) => s.design.params.find((p) => p.name === "top_depth")!.expr;
const previews = (s: State) => s.chat.filter((c) => c.kind === "preview");

describe("previews", () => {
  it("waits with the design unchanged, then applies on Apply", async () => {
    await post("/api/projects", { name: "Console", example: "record_console" });
    await post("/api/chat", { text: "Could the top be deeper?" });
    let s = await settle();
    expect(s.waiting).toEqual(["preview"]);
    expect(depth(s)).toBe("520");
    expect(previews(s).map((c) => c.status)).toEqual(["proposed"]);

    await post("/api/chat", { text: "Apply it.", preview: "apply" });
    s = await settle();
    expect(depth(s)).toBe("550");
    expect(previews(s).map((c) => c.status)).toEqual(["applied"]);
    const answer = JSON.stringify(client.sent.at(-1)!.messages.at(-1));
    expect(answer).toContain("Applied as one change");
  });

  it("leaves the design alone on Not now", async () => {
    await post("/api/chat", { text: "And deeper still?" });
    await settle();
    await post("/api/chat", { text: "Not now.", preview: "not_now" });
    const s = await settle();
    expect(depth(s)).toBe("550");
    expect(previews(s).map((c) => c.status)).toEqual(["applied", "not_applied"]);
  });

  it("applies an earlier preview later, as your own change", async () => {
    const before = await settle();
    const earlier = before.chat.filter((c) => c.kind === "preview") as unknown as { id: string; status: string }[];
    expect(earlier.map((c) => c.status)).toEqual(["applied", "not_applied"]);
    const r = await post("/api/previews/apply", { id: earlier[1]!.id });
    expect(r.status).toBe(200);
    const s = await settle();
    expect(depth(s)).toBe("600");
    expect(previews(s).map((c) => c.status)).toEqual(["applied", "applied"]);
    expect((await post("/api/previews/apply", { id: "nope" })).status).toBe(404);
  });

  it("shows a worked joint example without waiting", async () => {
    await post("/api/chat", { text: "What's a mortise and tenon?" });
    const s = await settle();
    expect(s.waiting).toEqual([]);
    expect(s.chat.find((c) => c.kind === "example")).toMatchObject({ joint: "mortise_tenon", note: "For the legs" });
  });
});
