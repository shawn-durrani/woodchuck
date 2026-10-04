// The server while Claude works: chat and edits go through, undo
// and switching designs wait, progress answers at once, and a message
// Claude didn't take in starts the next turn with no gap in busy.

import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/index.js";
import type { Progress } from "../src/progress.js";
import { scriptedClient, type ScriptBlock } from "../src/scripted.js";

const replies: ScriptBlock[][] = [];
let dir: string;
let base: string;
let close: () => Promise<void>;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "woodchuck-busy-"));
  const app = createApp({ dataDir: dir, client: scriptedClient(replies), watchTools: false, takePicture: async () => Buffer.from("png") });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  close = app.close;
});
afterAll(async () => {
  await close();
  rmSync(dir, { recursive: true, force: true });
});

const post = (p: string, body: unknown) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const get = async <T>(p: string) => (await (await fetch(base + p)).json()) as T;
const progress = () => get<Progress>("/api/progress");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(test: () => Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await test())) {
    if (Date.now() > end) throw new Error("timed out");
    await wait(15);
  }
}
const call = (id: string, name: string, input: ScriptBlock): ScriptBlock => ({ type: "tool_use", id, name, input });
/** A reply held back until the test opens it, so no step depends on how fast the machine is. */
function gate() {
  let open!: () => void;
  const until = new Promise<void>((r) => (open = r));
  return { block: { type: "gate", until } as ScriptBlock, open };
}
const idle = () => until(async () => !(await get<{ busy: boolean }>("/api/busy")).busy, 10_000);

// A test that fails part way leaves no replies or turn behind for the next one.
afterEach(async () => {
  replies.length = 0;
  await post("/api/chat/stop", {});
  await idle();
});

type Chat = { id: string; kind: string; author?: string; during?: boolean; taken?: string }[];

describe("while Claude works", () => {
  it("takes your message and your edit, and holds undo, redo and switching designs", async () => {
    const second = gate();
    replies.push(
      [{ type: "text", text: "Sizes first." }, call("t1", "set_param", { name: "a", expr: "1", unit: "mm" })],
      [second.block, call("t2", "set_param", { name: "c", expr: "3", unit: "mm" })],
      [{ type: "text", text: "Done." }],
    );
    const started = (await (await post("/api/chat", { text: "Build a shelf", selection: [] })).json()) as { ok: boolean; job: string };
    expect(started).toEqual({ ok: true, job: expect.stringMatching(/^u/) });
    expect(await get("/api/busy")).toEqual({ busy: true, reasons: ["claude_turn"] });

    // Once Claude's first step has run, both land while it thinks about the next, which waits for the test.
    await until(async () => (await progress()).steps === 1);
    const said = await post("/api/chat", { text: "Make it oak", selection: ["a"] });
    expect(said.status).toBe(202);
    const steered = (await said.json()) as { ok: boolean; steered: boolean; item: string };
    expect(steered).toEqual({ ok: true, steered: true, item: expect.stringMatching(/^u/) });
    expect((await post("/api/ops", { ops: [{ op: "set_param", name: "b", expr: "2", unit: "mm" }], label: "Set b" })).status).toBe(200);
    for (const route of ["/api/undo", "/api/redo", "/api/projects/open", "/api/projects/delete", "/api/previews/apply", "/api/projects"]) {
      expect((await post(route, { slug: "nope", id: "nope" })).status, route).toBe(409);
    }

    const mid = await progress();
    expect(mid).toMatchObject({ busy: true, job: started.job, state: "running", steps: 1, stage: "Sizes first.", queued: [{ id: steered.item, text: "Make it oak" }] });
    const state = await get<{ chat: Chat }>("/api/state");
    expect(state.chat.find((c) => c.id === steered.item)).toMatchObject({ kind: "user", during: true });

    second.open();
    await idle();
    const after = await get<{ chat: Chat; history: { author: string }[] }>("/api/state");
    expect(after.history.map((h) => h.author)).toEqual(["claude", "you", "claude"]);
    expect(after.chat.find((c) => c.id === steered.item)).toMatchObject({ taken: "step" });
    const done = await progress();
    expect(done).toMatchObject({ state: "done", job: started.job, steps: 2, queued: [] });
    expect(done.reply).toBe("Sizes first.\n\n(Woodchuck's Claude made 1 edit.)\n\nDone.\n\n(Woodchuck's Claude made 1 edit.)\n\n(It used 2 tools.)");
  });

  it("starts the next turn at once with a message Claude didn't take in, and stays busy across the hand-off", async () => {
    const hello = gate();
    const oak = gate();
    replies.push([hello.block, { type: "text", text: "Hello." }], [oak.block, { type: "text", text: "Got it, oak." }]);
    const first = ((await (await post("/api/chat", { text: "Hi", selection: [] })).json()) as { job: string }).job;
    const late = ((await (await post("/api/chat", { text: "Make it oak", selection: [] })).json()) as { item: string }).item;
    expect((await progress()).job).toBe(first);

    // The first turn ends without reading the late message, so the next starts with it, busy all the way.
    const busy: boolean[] = [];
    hello.open();
    await until(async () => {
      const p = await progress();
      busy.push(p.busy, (await get<{ busy: boolean }>("/api/busy")).busy);
      return p.job === late;
    });
    expect(busy.every(Boolean)).toBe(true);
    expect(await progress()).toMatchObject({ job: late, busy: true, state: "running" });

    oak.open();
    await idle();
    expect(await progress()).toMatchObject({ job: late, state: "done", reply: "Got it, oak." });
    expect(late).not.toBe(first);
    const state = await get<{ chat: Chat }>("/api/state");
    expect(state.chat.filter((c) => c.kind === "user").map((c) => [c.id, c.taken ?? null]).slice(-2)).toEqual([
      [first, null],
      [late, "turn"],
    ]);
  });

  it("stops what Claude is doing, then starts on a message it hadn't read", async () => {
    // The first reply never arrives on its own, so only Stop ends that turn.
    replies.push([gate().block, { type: "text", text: "Never said." }], [{ type: "text", text: "Doing that instead." }]);
    await post("/api/chat", { text: "Build a long thing", selection: [] });
    const late = ((await (await post("/api/chat", { text: "No, a short thing", selection: [] })).json()) as { item: string }).item;
    expect((await post("/api/chat/stop", {})).status).toBe(200);
    await until(async () => {
      const p = await progress();
      return p.job === late && p.state === "done";
    });
    const chat = (await get<{ chat: { kind: string; text?: string }[] }>("/api/state")).chat;
    expect(chat.filter((c) => c.kind === "error").at(-1)).toMatchObject({ text: "Stopped." });
    expect((await progress()).reply).toBe("Doing that instead.");
  });
});
