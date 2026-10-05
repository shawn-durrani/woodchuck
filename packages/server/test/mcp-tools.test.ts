// The MCP tools against a running app. A chat app such as Crossband
// holds its turn while a tool runs, so woodchuck_ask hands a build over
// within seconds, woodchuck_progress answers at once, and each carries the
// background block Crossband watches the build by.

import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { MessagesClient } from "../src/agent.js";
import { createApp } from "../src/index.js";
import type { Background } from "../src/progress.js";
import { scriptedClient, type ScriptBlock } from "../src/scripted.js";

const replies: ScriptBlock[][] = [];
/** Errors the next requests fail with, before the scripted replies go on. */
const failures: Error[] = [];
const scripted = scriptedClient(replies);
const flaky: MessagesClient = {
  stream(body) {
    const e = failures.shift();
    if (!e) return scripted.stream(body);
    return { on: () => undefined, finalMessage: () => Promise.reject(e), abort: () => undefined };
  },
};
let dir: string;
let closeApp: () => Promise<void>;
let client: Client;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "woodchuck-mcp-"));
  const app = createApp({ dataDir: dir, client: flaky, watchTools: false });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  closeApp = app.close;
  // The MCP server finds the app when it loads, so it's loaded once this one is up.
  process.env.WOODCHUCK_URL = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const { buildServer } = await import("../src/mcp.js");
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildServer({ askWaitMs: 1500, replyWaitMs: 1500 }).connect(a);
  client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(b);
});
afterAll(async () => {
  await client.close();
  await closeApp();
  rmSync(dir, { recursive: true, force: true });
});

type Result = { content: { type: string; text: string }[]; structuredContent?: { background: Background } };
async function tool(name: string, args: Record<string, unknown> = {}) {
  const t0 = Date.now();
  const r = (await client.callTool({ name, arguments: args })) as unknown as Result;
  return { text: r.content[0]!.text, bg: r.structuredContent?.background, ms: Date.now() - t0 };
}
const call = (id: string, name: string, input: ScriptBlock): ScriptBlock => ({ type: "tool_use", id, name, input });
/** A reply held back until the test opens it, so no step depends on how fast the machine is. */
function gate() {
  let open!: () => void;
  const until = new Promise<void>((r) => (open = r));
  return { block: { type: "gate", until } as ScriptBlock, open };
}
const app = (p: string) => fetch(`${process.env.WOODCHUCK_URL}${p}`).then((r) => r.json() as Promise<Record<string, unknown>>);
async function until(test: () => Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (!(await test())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 15));
  }
}
const idle = () => until(async () => !(await app("/api/busy")).busy);

// A test that fails part way leaves no replies or turn behind for the next one.
afterEach(async () => {
  replies.length = 0;
  failures.length = 0;
  await fetch(`${process.env.WOODCHUCK_URL}/api/chat/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  await idle();
});

describe("the MCP tools while Claude builds", () => {
  it("lists woodchuck_progress, and says woodchuck_ask never waits long", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("woodchuck_progress");
    expect(tools.find((t) => t.name === "woodchuck_ask")!.description).toMatch(/never waits long/);
    expect(tools.find((t) => t.name === "woodchuck_progress")!.description).toMatch(/Never call it in a loop/);
    expect(tools.find((t) => t.name === "woodchuck_finish")!.description).toMatch(/mid-build too/);
    // A calling model tells a slow spin from a one-off turn.
    const view = tools.find((t) => t.name === "woodchuck_view")!.description!;
    expect(view).toMatch(/"spin it slowly"[^.]*use orbit "start"/);
    expect(view).toMatch(/"turn it a bit"[^.]*use turn_degrees/);
  });

  it("answers a quick question straight away", async () => {
    replies.push([{ type: "text", text: "It's 800 mm wide." }]);
    const r = await tool("woodchuck_ask", { message: "How wide is it?" });
    expect(r.text).toBe("It's 800 mm wide.");
    expect(r.bg).toMatchObject({ state: "done", title: "Woodchuck", progress_tool: "woodchuck_progress", reply: "It's 800 mm wide.", waiting_for: null });
    expect(r.bg!.job).toMatch(/^u/);
  });

  it("hands a long build over within seconds, takes a message mid-build at once, and reports progress at once", async () => {
    const second = gate();
    const last = gate();
    replies.push(
      [{ type: "text", text: "Sides first." }, call("t1", "set_param", { name: "a", expr: "1", unit: "mm" })],
      [second.block, call("t2", "set_param", { name: "b", expr: "2", unit: "mm" })],
      [last.block, { type: "text", text: "Built it." }],
    );
    // The build is held after its first step, so woodchuck_ask has to hand it over unfinished.
    const asked = await tool("woodchuck_ask", { message: "Build a bookcase" });
    expect(asked.ms).toBeLessThan(5000);
    expect(asked.text).toMatch(/^Woodchuck's Claude has started on it/);
    expect(asked.bg).toMatchObject({ state: "running", stage: "Sides first.", steps: 1, reply: "" });
    const job = asked.bg!.job;

    const steer = await tool("woodchuck_ask", { message: "Make the shelves adjustable" });
    expect(steer.ms).toBeLessThan(2000);
    expect(steer.text).toMatch(/^Passed on\./);
    expect(steer.bg).toMatchObject({ job, state: "running" });

    const now = await tool("woodchuck_progress");
    expect(now.ms).toBeLessThan(2000);
    expect(now.text).toMatch(/^Woodchuck's Claude is working: Sides first\. \(1 step, \d+ s so far\.\)/);
    expect(now.text).toContain("One message is waiting to reach it after its current step.");
    expect(Object.keys(now.bg!)).toEqual([
      "job",
      "state",
      "title",
      "progress_tool",
      "stage",
      "steps",
      "elapsed_s",
      "waiting_for",
      "ask",
      "reply",
      "outcome",
      "error",
      "parts",
      "edits",
    ]);
    // Claude's edit so far counts before its change set closes, so another app hears the design is growing.
    expect(now.bg).toMatchObject({ outcome: null, error: "", parts: 0, edits: 1 });
    expect(now.text).toContain("No parts in the design so far, from 1 edit by Woodchuck's Claude in this request, showing live in the Woodchuck window.");

    second.open();
    last.open();
    await idle();
    const reply = await tool("woodchuck_reply");
    expect(reply.bg).toMatchObject({ job, state: "done", outcome: "finished", steps: 2, edits: 2 });
    expect(reply.text).toContain("Built it.");
  });

  it("says plainly when a request stopped with an error, and keeps the block's state one Crossband knows", async () => {
    failures.push(new Error("The disk is full"));
    const r = await tool("woodchuck_ask", { message: "Build a record cabinet" });
    expect(r.bg).toMatchObject({ state: "done", outcome: "failed", error: "Something went wrong: The disk is full" });
    expect(r.text).toMatch(/^Woodchuck's Claude stopped with an error before it finished, after 0 steps\. The error: Something went wrong: The disk is full The woodworker can ask it to carry on/);
    expect(r.text).not.toContain("Woodchuck reported an error");
    const p = await tool("woodchuck_progress");
    expect(p.text).toMatch(/^Woodchuck's Claude stopped with an error before it finished \(0 steps, \d+ s\)\. The error: Something went wrong: The disk is full\nThe woodworker can ask it to carry on\./);
    expect((await app("/api/progress")).state).toBe("failed");

    // The next request hears the last one stopped early.
    replies.push([{ type: "text", text: "Carrying on." }]);
    expect((await tool("woodchuck_ask", { message: "Carry on" })).bg).toMatchObject({ state: "done", outcome: "finished", error: "" });
    const sent = JSON.stringify(scripted.sent.at(-1)!.messages.at(-1));
    expect(sent).toContain("your last turn stopped early with an error after 0 steps");
  });

  it("changes colours mid-build, as a step of its own", async () => {
    const ops = [{ op: "define_material", id: "ply18", name: "18 mm birch ply", kind: "sheet", thickness_mm: 18, grained: true, species: "birch_ply" }];
    await fetch(`${process.env.WOODCHUCK_URL}/api/ops`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ops }) });
    const held = gate();
    replies.push([held.block, call("t3", "set_param", { name: "c", expr: "3", unit: "mm" })], [{ type: "text", text: "Done." }]);
    const started = tool("woodchuck_ask", { message: "Add a size" });
    await until(async () => (await app("/api/busy")).busy === true);
    const r = await tool("woodchuck_finish", { targets: ["material:ply18"], finish: "raw" });
    expect(r.text).toMatch(/^Done: material:ply18 now bare timber\. It's one change the woodworker can undo/);
    held.open();
    await started;
    await idle();
    expect(await tool("woodchuck_progress")).toMatchObject({ bg: { state: "done" } });
  });
});

describe("woodchuck_view", () => {
  /** An open window, keeping each view change the app sends it. */
  async function windowOpen() {
    const ws = new WebSocket(`${process.env.WOODCHUCK_URL!.replace("http", "ws")}/ws`);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    const views: Record<string, unknown>[] = [];
    ws.addEventListener("message", (m) => {
      const msg = JSON.parse(String(m.data)) as { type: string; view?: Record<string, unknown> };
      if (msg.type === "view") views.push(msg.view!);
    });
    return { ws, views, got: (n: number) => until(async () => views.length >= n) };
  }

  it("starts an orbit at the default speed or the one asked for, and stops it", async () => {
    const win = await windowOpen();
    const start = await tool("woodchuck_view", { orbit: "start" });
    expect(start.text).toBe('The Woodchuck window now shows the model turning 12° a second to the right. It keeps turning until you send orbit "stop", or the woodworker takes the camera.');
    // A speed on its own starts one too.
    const left = await tool("woodchuck_view", { orbit_degrees_per_second: -20, look: "finished" });
    expect(left.text).toMatch(/^The Woodchuck window now shows the Finished look and the model turning 20° a second to the left\./);
    const stop = await tool("woodchuck_view", { orbit: "stop" });
    expect(stop.text).toBe("The Woodchuck window now shows the model held still.");
    await win.got(3);
    expect(win.views.map(({ from: _, ...v }) => v)).toEqual([
      { orbit: "start", orbitSpeed: 12 },
      { orbit: "start", orbitSpeed: -20, look: "finished" },
      { orbit: "stop" },
    ]);
    // Too slow to see, and turning in the plan views, are refused.
    expect((await tool("woodchuck_view", { orbit: "start", orbit_degrees_per_second: 0.5 })).text).toMatch(/^Woodchuck refused that: orbitSpeed must be/);
    expect((await tool("woodchuck_view", { orbit: "start", plan_views: true })).text).toMatch(/can't go with the plan views/);
    win.ws.close();
  });
});
