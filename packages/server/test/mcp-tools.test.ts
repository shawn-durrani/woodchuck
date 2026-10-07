// The MCP tools against a running app. A chat app such as Crossband
// holds its turn while a tool runs, so woodchuck_ask hands a build over
// within seconds, woodchuck_progress answers at once, and each carries the
// background block Crossband watches the build by.

import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
      "answered",
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

describe("woodchuck_view", () => {
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

  // Seen in a demo: a voice chat asked Woodchuck's Claude for the cut list, a turn it didn't need.
  it("opens a side panel tab, and tells a voice model to open Make for the cut list", async () => {
    const { tools } = await client.listTools();
    const view = tools.find((t) => t.name === "woodchuck_view")!;
    expect(view.description).toMatch(/"show me the cut list", open tab "make"/);
    expect(view.description).toMatch(/rather than asking Woodchuck's Claude/);
    const tab = (view.inputSchema.properties as Record<string, { enum?: string[]; description?: string }>).tab!;
    expect(tab.enum).toEqual(["edit", "finish", "make", "check", "history"]);
    expect(tab.description).toMatch(/make holds the workshop drawings, the cut list and the cutting layout/);

    const win = await windowOpen();
    expect((await tool("woodchuck_view", { tab: "make" })).text).toBe("The Woodchuck window now shows the Make tab open.");
    expect((await tool("woodchuck_view", { tab: "check", look: "finished" })).text).toBe("The Woodchuck window now shows the Finished look and the Check tab open.");
    await win.got(2);
    expect(win.views.map(({ from: _, ...v }) => v)).toEqual([{ tab: "make" }, { look: "finished", tab: "check" }]);
    // Filling the window hides the tabs, and a name off screen isn't a tab.
    expect((await tool("woodchuck_view", { tab: "make", fill_window: true })).text).toMatch(/^Woodchuck refused that: tab opens the side panel, so it can't go with fill/);
    expect((await client.callTool({ name: "woodchuck_view", arguments: { tab: "cutlist" } })).isError).toBe(true);
    expect(win.views).toHaveLength(2);
    win.ws.close();
  });

  // Issue #66: whatever the window's Explode, its slider and a joint card's pull apart do, another chat can do too.
  it("pulls the piece apart, or one joint, and puts it back together", async () => {
    const { tools } = await client.listTools();
    const props = tools.find((t) => t.name === "woodchuck_view")!.inputSchema.properties as Record<string, { description?: string }>;
    expect(props.explode!.description).toMatch(/1 fully apart, 0 back together/);
    expect(props.focus_joint!.description).toMatch(/by its id from woodchuck_status/);
    const pine = { op: "define_material", id: "pine18", name: "18 mm pine", kind: "solid", thickness_mm: 18, grained: true };
    const side = (id: string, x: Record<string, unknown>) => ({ op: "add_panel", id, name: "Side", material: "pine18", thickness_axis: "x", grain_axis: "y", x, y: { start: { at: "0" }, size: "600" }, z: { start: { at: "0" }, size: "240" } });
    const shelf = { op: "add_panel", id: "shelf", name: "Shelf", material: "pine18", thickness_axis: "y", grain_axis: "x", x: { start: { face: "side_l.right" }, end: { face: "side_r.left" } }, y: { start: { at: "300" } }, z: { start: { at: "0" }, size: "240" } };
    const ops = [pine, side("side_l", { start: { at: "0" } }), side("side_r", { end: { at: "600" } }), shelf, { op: "add_joint", id: "shelf_l", type: "dado", host: "side_l", guest: "shelf" }];
    expect((await fetch(`${process.env.WOODCHUCK_URL}/api/ops`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ops }) })).status).toBe(200);
    expect((await tool("woodchuck_status")).text).toContain("Joints, by id: shelf_l");

    const win = await windowOpen();
    expect((await tool("woodchuck_view", { explode: 1 })).text).toBe("The Woodchuck window now shows the piece pulled apart.");
    expect((await tool("woodchuck_view", { explode: 0.5 })).text).toBe("The Woodchuck window now shows the piece partly pulled apart.");
    expect((await tool("woodchuck_view", { focus_joint: "shelf_l" })).text).toBe("The Woodchuck window now shows joint shelf_l pulled apart, with its section and sizes.");
    expect((await tool("woodchuck_view", { focus_joint: "", explode: 1 })).text).toBe("The Woodchuck window now shows the whole piece pulled apart.");
    expect((await tool("woodchuck_view", { explode: 0 })).text).toBe("The Woodchuck window now shows the piece back together.");
    await win.got(5);
    expect(win.views.map(({ from: _, ...v }) => v)).toEqual([{ explode: 1 }, { explode: 0.5 }, { focusJoint: "shelf_l" }, { focusJoint: "", explode: 1 }, { explode: 0 }]);
    // A joint the design doesn't have, and pulling the plan views apart, are refused.
    expect((await tool("woodchuck_view", { focus_joint: "nope" })).text).toBe("Woodchuck refused that: There's no joint nope. The design's joints: shelf_l");
    expect((await tool("woodchuck_view", { explode: 1, plan_views: true })).text).toMatch(/^Woodchuck refused that: explode and focusJoint pull the 3D view apart/);
    expect(win.views).toHaveLength(5);
    win.ws.close();
    await fetch(`${process.env.WOODCHUCK_URL}/api/undo`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  });

  // Crossband keeps the first 900 characters of a tool's description, so anything after that never reaches its models.
  it("keeps every tool's description within the 900 characters a chat app reads", async () => {
    const { tools } = await client.listTools();
    for (const t of tools) expect(t.description!.length, t.name).toBeLessThanOrEqual(900);
  });
});

describe("woodchuck_set_param and woodchuck_design", () => {
  type State = { design: { params: { name: string; expr: string }[] }; history: { author: string; label: string }[] };
  const state = () => app("/api/state") as unknown as Promise<State>;
  const expr = async (name: string) => (await state()).design.params.find((p) => p.name === name)?.expr;
  const post = (p: string, body: unknown) =>
    fetch(`${process.env.WOODCHUCK_URL}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  // Each test starts on a fresh record console, the invented example the app ships.
  beforeEach(async () => {
    expect((await post("/api/projects", { name: "Record console", example: "record_console" })).status).toBe(200);
  });

  it("lists both, and tells the calling model to say a size back before changing it", async () => {
    const { tools } = await client.listTools();
    const set = tools.find((t) => t.name === "woodchuck_set_param")!;
    expect(set.description).toMatch(/say the change back \(parameter, old → new in mm\) and get a yes/);
    expect(set.description).toContain("call woodchuck_design first");
    expect(set.description).toMatch(/adds, removes or reshapes parts[^.]*goes to woodchuck_ask/);
    // Crossband keeps the first 900 characters of a description.
    expect(set.description!.length).toBeLessThan(900);
    expect(Object.keys(set.inputSchema.properties!)).toEqual(["params", "confirmed"]);
    expect(tools.find((t) => t.name === "woodchuck_design")!.description).toMatch(/never changes anything/);
  });

  it("reads the design in a few short lines, with its parameters and sizes", async () => {
    const r = await tool("woodchuck_design");
    expect(r.ms).toBeLessThan(2000);
    for (const line of [
      "Design: Record console",
      "Woodchuck's Claude isn't working on anything.",
      "Overall: 2040 mm wide, 430 mm high and 520 mm deep.",
      "- top_length = 2040 mm: Length of the top",
      "- drawers = 5, a count",
      "- partition ×4: 370 × 511 × 30, carcass_30",
      "- false_front ×5 (Drawer front): 368 × 366 × 18, front_18",
      "- drawer_box_front ×5: 316.6 × 340 × 15, ply15",
      "Checks: 1 error and no warnings, not ready to cut yet:",
      "- Error: 12-inch LPs need at least lp_clear inside each drawer (rule lp_fit)",
    ]) {
      expect(r.text.split("\n")).toContain(line);
    }
    expect(r.text).toMatch(/^- bay = 372 mm, worked out as \(top_length - left_side\.thickness/m);
    // Short enough for a voice model's context.
    expect(r.text.length).toBeLessThan(2500);
  });

  it("changes parameters as one undo step, and says old and new, what followed and what it fixed", async () => {
    const before = (await state()).history.length;
    const r = await tool("woodchuck_set_param", {
      params: [
        { name: "slide_gap", value_mm: 11 },
        { name: "top_length", value_mm: 2100 },
      ],
    });
    expect(r.ms).toBeLessThan(2000);
    expect(r.text).toMatch(/^Done: slide_gap 12\.7 mm → 11 mm and top_length 2040 mm → 2100 mm\./);
    expect(r.text).toContain("Sizes worked out from them changed too: bay 372 mm → 384 mm.");
    expect(r.text).toMatch(/\n\d+ parts moved or changed size: /);
    expect(r.text).toContain("Checks: no errors and no warnings, ready to cut.\nNo new errors or warnings.");
    expect(r.text).toContain("Fixed: 12-inch LPs need at least lp_clear inside each drawer (rule lp_fit).");
    expect(r.text).toContain("It's one change the woodworker can undo in one step, and Woodchuck's Claude will be told.");
    const after = await state();
    expect(after.history.length).toBe(before + 1);
    expect(after.history.at(-1)).toMatchObject({ author: "you", label: "Another app: set slide_gap from 12.7 mm to 11 mm and top_length from 2040 mm to 2100 mm" });
    expect([await expr("slide_gap"), await expr("top_length")]).toEqual(["11", "2100"]);
    // One undo takes both back.
    expect((await post("/api/undo", {})).status).toBe(200);
    expect([await expr("slide_gap"), await expr("top_length")]).toEqual(["12.7", "2040"]);
  });

  it("brings the whole model into view in an open window, with a note naming the change", async () => {
    const win = await windowOpen();
    const r = await tool("woodchuck_set_param", { params: [{ name: "top_length", value_mm: 2100 }] });
    expect(r.text).toMatch(/The Woodchuck window shows it now\.$/);
    await win.got(1);
    expect(win.views).toEqual([{ fit: true, from: "another app", note: "set top_length from 2040 mm to 2100 mm." }]);
    win.ws.close();
  });

  it("refuses a parameter the design doesn't have and a formula that doesn't work out, and changes nothing", async () => {
    const before = await state();
    const refusals: [Record<string, unknown>, RegExp][] = [
      [{ name: "height", value_mm: 450 }, /^Nothing changed\. There's no parameter called "height"\. Did you mean carcass_height\? .*Making a new one is a job for woodchuck_ask\.$/],
      [{ name: "top_depth", expression: "top_length +" }, /^Nothing changed\. Couldn't read "top_length \+" for parameter top_depth/],
      [{ name: "top_depth", expression: "width * 2" }, /^Nothing changed\. There's no size called "width"/],
      [{ name: "top_length", expression: "bay * 5" }, /^Nothing changed\. top_length wouldn't work out: Circular reference/],
      [{ name: "drawers", value_mm: 4 }, /^Nothing changed\. drawers is a count, so give it as value\.$/],
      [{ name: "top_length", value: 2100 }, /^Nothing changed\. top_length is a size in mm, so give it as value_mm\.$/],
      [{ name: "top_length" }, /^Nothing changed\. Give top_length one of value_mm or expression\.$/],
    ];
    for (const [change, said] of refusals) {
      expect((await tool("woodchuck_set_param", { params: [{ name: "slide_gap", value_mm: 12 }, change] })).text).toMatch(said);
    }
    // The good change listed beside each bad one didn't go in either.
    expect(await state()).toEqual(before);
  });

  it("names every new problem a change makes", async () => {
    await tool("woodchuck_set_param", { params: [{ name: "slide_gap", value_mm: 11 }, { name: "top_length", value_mm: 2100 }] });
    const r = await tool("woodchuck_set_param", { params: [{ name: "top_length", value_mm: 2000 }] });
    expect(r.text).toMatch(/^Done: top_length 2100 mm → 2000 mm\.\nSizes worked out from it changed too: bay 384 mm → 364 mm\./);
    expect(r.text).toContain("Checks: 1 error and no warnings, not ready to cut yet.\n- New error: 12-inch LPs need at least lp_clear inside each drawer (rule lp_fit)");
  });

  it("asks for the woodworker's yes before a change over 20%, or to 0 or below", async () => {
    const before = await state();
    const big = await tool("woodchuck_set_param", { params: [{ name: "top_length", value_mm: 1500 }] });
    expect(big.text).toBe(
      'Nothing changed yet. This change needs the woodworker\'s yes first, in case a number was misheard: top_length from 2040 mm to 1500 mm, 26% less. Say it back to them, such as "Top length from 2040 mm to 1500 mm, is that right?", and once they say yes, call again with the same values and confirmed true.',
    );
    expect((await tool("woodchuck_set_param", { params: [{ name: "top_length", value_mm: 1630 }] })).text).toMatch(/^Nothing changed yet\..*20% less/);
    expect((await tool("woodchuck_set_param", { params: [{ name: "front_gap", value_mm: 0 }] })).text).toMatch(
      /^Nothing changed yet\. .*front_gap from 2 mm to 0 mm, and a value of 0 or below is almost always a mishearing/,
    );
    // A formula is held to the value it works out to.
    expect((await tool("woodchuck_set_param", { params: [{ name: "top_depth", expression: "top_length / 2" }] })).text).toMatch(
      /top_depth from 520 mm to top_length \/ 2 \(1020 mm\), 96% more/,
    );
    expect(await state()).toEqual(before);

    // Up to a fifth goes straight in, and a yes lets the rest through.
    expect((await tool("woodchuck_set_param", { params: [{ name: "top_length", value_mm: 1640 }] })).text).toMatch(/^Done: top_length 2040 mm → 1640 mm\./);
    expect((await tool("woodchuck_set_param", { params: [{ name: "top_length", value_mm: 1200 }], confirmed: true })).text).toMatch(/^Done: top_length 1640 mm → 1200 mm\./);
    expect(await expr("top_length")).toBe("1200");
  });

  it("says when a size it sets stops following the sizes its formula used", async () => {
    const r = await tool("woodchuck_set_param", { params: [{ name: "bay", value_mm: 380 }] });
    expect(r.text).toMatch(/^Done: bay 372 mm → 380 mm\./);
    expect(r.text).toContain(
      "so it followed top_length, left_side.thickness, right_side.thickness, drawers and partition.thickness. It's now a plain 380 mm and stops following them; undo puts the formula back.",
    );
    expect(r.text).toContain("- New error: right_side and false_front#5 overlap");
    // A formula in place of a plain size, or of another formula, says what it follows now.
    const f = await tool("woodchuck_set_param", { params: [{ name: "bay", expression: "top_length / 5 - 30" }] });
    expect(f.text).toMatch(/^Done: bay 380 mm → top_length \/ 5 - 30 \(378 mm\)\.\nbay now follows top_length, and moves when they do\./);
    await post("/api/undo", {});
    await post("/api/undo", {});
    const g = await tool("woodchuck_set_param", { params: [{ name: "bay", expression: "(top_length - 180) / drawers" }] });
    expect(g.text).toContain("so it followed top_length, left_side.thickness, right_side.thickness, drawers and partition.thickness. It's now worked out as (top_length - 180) / drawers; undo puts the formula back.");
  });

  it("works while Claude is mid-build, as its own undo step, and Claude is told after its current step", async () => {
    const held = gate();
    replies.push([held.block, call("t1", "set_param", { name: "lp_clear", expr: "321", unit: "mm" })], [{ type: "text", text: "Done." }]);
    const started = tool("woodchuck_ask", { message: "Make room for thicker sleeves" });
    await until(async () => (await app("/api/busy")).busy === true);
    expect((await tool("woodchuck_design")).text).toContain("Woodchuck's Claude is working right now.");

    const r = await tool("woodchuck_set_param", { params: [{ name: "carcass_height", value_mm: 420 }] });
    expect(r.ms).toBeLessThan(2000);
    expect(r.text).toMatch(/^Done: carcass_height 400 mm → 420 mm\./);
    held.open();
    await started;
    await idle();

    const told = JSON.stringify(scripted.sent.at(-1)!.messages.at(-1));
    expect(told).toContain("(While you were working, the woodworker changed: Another app: set carcass_height from 400 mm to 420 mm. Read the design again before editing those parts.)");
    const s = await state();
    expect(s.history.slice(-2).map((e) => e.author)).toEqual(["you", "claude"]);
    expect([await expr("carcass_height"), await expr("lp_clear")]).toEqual(["420", "321"]);
    // Undo takes Claude's change back first, then this one.
    await post("/api/undo", {});
    expect([await expr("carcass_height"), await expr("lp_clear")]).toEqual(["420", "320"]);
    await post("/api/undo", {});
    expect(await expr("carcass_height")).toBe("400");
  });
});

// Issue #69: whatever the window's Undo, Redo and design menu do, another
// chat can do too. A chat app may send a call twice, so each names the
// change or the design it means, and a second send changes nothing.
describe("woodchuck_undo, woodchuck_redo and woodchuck_designs", () => {
  type State = { project: { slug: string }; design: { params: { name: string; expr: string }[] }; projects: { slug: string; starred: boolean }[] };
  const state = () => app("/api/state") as unknown as Promise<State>;
  const expr = async (name: string) => (await state()).design.params.find((p) => p.name === name)?.expr;
  const post = (p: string, body: unknown) =>
    fetch(`${process.env.WOODCHUCK_URL}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("undoes and redoes a change by its number, once however often it's sent", async () => {
    const ops = (name: string, expr: string) => post("/api/ops", { ops: [{ op: "set_param", name, expr, unit: "mm" }], label: `Set ${name}` });
    await ops("undo_a", "10");
    await ops("undo_b", "20");
    const status = (await tool("woodchuck_status")).text;
    const [, b, a] = status.match(/Changes, latest first: (\d+) "Set undo_b" and (\d+) "Set undo_a"/)!;
    // Only the latest change can be undone.
    expect((await tool("woodchuck_undo", { change: Number(a) })).text).toBe(`Nothing changed. Change ${a} isn't the latest. Undo ${b} first.`);
    expect((await tool("woodchuck_undo", { change: Number(b) })).text).toBe(`Undid change ${b}, "Set undo_b". woodchuck_redo with change ${b} puts it back.`);
    expect((await tool("woodchuck_undo", { change: Number(b) })).text).toBe(`Change ${b}, "Set undo_b", is undone already, so nothing changed.`);
    expect(await expr("undo_a")).toBe("10");
    expect((await tool("woodchuck_status")).text).toContain(`Undone, next to redo first: ${b} "Set undo_b"`);
    expect((await tool("woodchuck_redo", { change: Number(b) })).text).toBe(`Redid change ${b}, "Set undo_b". woodchuck_undo with change ${b} takes it out again.`);
    expect((await tool("woodchuck_redo", { change: Number(b) })).text).toBe(`Change ${b}, "Set undo_b", is in the design already, so nothing changed.`);
    expect(await expr("undo_b")).toBe("20");
    expect((await tool("woodchuck_undo", { change: 99999 })).text).toBe("Nothing changed. There's no change 99999.");
    // The window's own Undo names the change too, so a second click can't take another.
    expect((await post("/api/undo", { change: Number(b) })).status).toBe(200);
    expect(((await (await post("/api/undo", { change: Number(b) })).json()) as { already?: boolean }).already).toBe(true);
    await post("/api/undo", { change: Number(a) });
    expect(await expr("undo_a")).toBeUndefined();
  });

  it("starts, copies, renames, stars, opens and deletes designs, each once however often it's sent", async () => {
    const first = (await state()).project.slug;
    const list = (await tool("woodchuck_designs", { action: "list" })).text;
    expect(list).toMatch(/^Designs, by id:\n/);
    expect(list).toContain(`- ${first}: `);
    expect(list).toContain(", open");
    expect(list).toContain(`The open design's file: ${process.env.WOODCHUCK_URL}/api/design.json`);

    expect((await tool("woodchuck_designs", { action: "new", name: "Fairhaven bench" })).text).toBe("Started Fairhaven bench. It's open now.");
    expect((await tool("woodchuck_designs", { action: "new", name: "Fairhaven bench" })).text).toBe("Fairhaven bench is open already, so nothing changed.");
    const bench = (await state()).project.slug;
    expect((await tool("woodchuck_designs", { action: "copy", name: "Fairhaven bench, wider" })).text).toBe("Copied Fairhaven bench as Fairhaven bench, wider. The copy is open now.");
    expect((await tool("woodchuck_designs", { action: "copy", name: "Fairhaven bench, wider" })).text).toBe("Fairhaven bench, wider is open already, so nothing changed.");
    const wider = (await state()).project.slug;
    expect((await tool("woodchuck_designs", { action: "new", name: "Fairhaven bench" })).text).toBe(`Nothing changed. There's already a design called Fairhaven bench (${bench}). Open it, or pick another name.`);

    expect((await tool("woodchuck_designs", { action: "rename", name: "Wide bench" })).text).toBe("Renamed Fairhaven bench, wider to Wide bench. It's one change the woodworker can undo.");
    expect((await tool("woodchuck_designs", { action: "rename", name: "Wide bench" })).text).toBe("It's called Wide bench already, so nothing changed.");
    for (let i = 0; i < 2; i++) expect((await tool("woodchuck_designs", { action: "star", design: bench, starred: true })).text).toBe("Fairhaven bench is starred.");
    expect((await state()).projects.find((p) => p.slug === bench)!.starred).toBe(true);
    expect((await tool("woodchuck_designs", { action: "star", design: bench, starred: false })).text).toBe("Fairhaven bench is not starred.");

    expect((await tool("woodchuck_designs", { action: "open", design: bench })).text).toBe("Opened Fairhaven bench.");
    expect((await tool("woodchuck_designs", { action: "open", design: bench })).text).toBe("Fairhaven bench is open already.");
    expect((await tool("woodchuck_designs", { action: "open", design: "nope" })).text).toMatch(/^Nothing changed\. There's no design nope\. Designs: /);

    // Deleting waits for the woodworker's yes, and a second delete finds it gone.
    expect((await tool("woodchuck_designs", { action: "delete", design: wider })).text).toBe(
      "Nothing changed yet. Deleting Wide bench takes it and its chat out of Woodchuck, and it can't be undone. Ask the woodworker, then call again with confirmed true.",
    );
    expect((await state()).projects.some((p) => p.slug === wider)).toBe(true);
    expect((await tool("woodchuck_designs", { action: "delete", design: wider, confirmed: true })).text).toBe("Deleted Wide bench. Fairhaven bench is open now.");
    expect((await tool("woodchuck_designs", { action: "delete", design: wider, confirmed: true })).text).toBe(`There's no design ${wider}, so there's nothing to delete.`);

    await tool("woodchuck_designs", { action: "delete", design: bench, confirmed: true });
    await tool("woodchuck_designs", { action: "open", design: first });
    expect((await state()).project.slug).toBe(first);
  });
});
