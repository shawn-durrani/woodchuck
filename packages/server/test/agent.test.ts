// The turn loop, driven by a scripted stand-in for Claude. No API key and
// no network: the tests check what the loop sends and does.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { derive } from "@woodchuck/core";
import { compactAt, SUMMARY_INSTRUCTIONS, Turn, type MessagesClient } from "../src/agent.js";
import { SYSTEM_PROMPT } from "../src/prompt.js";
import { scriptedClient } from "../src/scripted.js";
import { Store } from "../src/store.js";
import { TOOLS } from "../src/tools.js";

type Block = Record<string, unknown>;

const scripted = (replies: Block[][]) => scriptedClient(replies);

const call = (id: string, name: string, input: Block): Block => ({ type: "tool_use", id, name, input });

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "woodchuck-"));
  store = new Store(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function turn(client: MessagesClient) {
  return new Turn(store, client, { chat() {}, delta() {}, changed() {} }, () => Buffer.from("png"));
}

describe("a Claude turn", () => {
  it("sets species and finishes through the tools", async () => {
    const client = scripted([
      [
        call("t1", "define_material", { id: "oak", name: "Oak", kind: "solid", thickness_mm: 19, grained: true, species: "white_oak" }),
        call("t2", "set_finish", { targets: ["material:oak"], finish: "13" }),
        call("t3", "set_finish", { targets: ["material:oak"], finish: "mauve" }),
      ],
      [{ type: "text", text: "Oiled it Amsterdam." }],
    ]);
    await turn(client).run({ text: "Oak, oiled Amsterdam", selection: [] });
    expect(store.project.design.materials[0]!.species).toBe("white_oak");
    expect(store.project.design.finishes).toEqual({ "material:oak": "satin_wood_oil/amsterdam" });
    const reply = client.sent[1]!.messages.at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[];
    expect(reply.find((b) => b.tool_use_id === "t3")).toMatchObject({ is_error: true });
  });

  it("runs tool calls, sends their results back, and undoes as one change", async () => {
    const client = scripted([
      [
        call("t1", "set_param", { name: "width", expr: "600", unit: "mm" }),
        call("t2", "define_material", { id: "ply18", name: "18 mm ply", kind: "sheet", thickness_mm: 18, grained: true }),
      ],
      [
        call("t3", "add_panel", {
          id: "shelf",
          name: "Shelf",
          material: "ply18",
          thickness_axis: "y",
          grain_axis: "x",
          x: { start: { at: "0" }, size: "width" },
          y: { start: { at: "0" } },
          z: { start: { at: "0" }, size: "250" },
        }),
      ],
      [{ type: "text", text: "Added a 600 mm shelf." }],
    ]);
    await turn(client).run({ text: "Add a shelf", selection: [] });

    expect(derive(store.project.design).byId.get("shelf")!.cut.length).toBe(600);
    const second = client.sent[1]!.messages.at(-1)!;
    expect((second.content as unknown as Block[]).map((b) => b.type)).toEqual(["tool_result", "tool_result"]);
    expect(store.project.history).toHaveLength(1);
    expect(store.project.history[0]!.author).toBe("claude");

    store.project.undo();
    expect(store.project.design.parts).toEqual([]);
  });

  it("returns a refused edit as an error Claude can fix", async () => {
    const client = scripted([[call("t1", "delete_part", { id: "nope" })], [{ type: "text", text: "There was nothing to delete." }]]);
    await turn(client).run({ text: "Delete nope", selection: [] });
    const result = (client.sent[1]!.messages.at(-1)!.content as unknown as Block[])[0]!;
    expect(result).toMatchObject({ type: "tool_result", is_error: true, content: 'There\'s no part "nope"' });
  });

  it("waits on a question and sends the answer as the tool result", async () => {
    const client = scripted([
      [call("q1", "ask_user", { question: "Solid timber or ply?", options: ["Solid", "Ply"] }), call("t1", "set_param", { name: "a", expr: "1" })],
      [{ type: "text", text: "Ply it is." }],
    ]);
    await turn(client).run({ text: "Design a shelf", selection: [] });
    expect(store.project.pending?.waiting).toEqual([{ tool_use_id: "q1", kind: "question" }]);
    expect(client.sent).toHaveLength(1);

    await turn(client).run({ text: "Ply", selection: ["shelf"] });
    const reply = client.sent[1]!.messages.at(-1)!.content as unknown as Block[];
    expect(reply.map((b) => b.type)).toEqual(["tool_result", "tool_result", "text"]);
    expect(reply.find((b) => b.tool_use_id === "q1")).toMatchObject({ content: "Ply" });
    expect(reply.at(-1)).toMatchObject({ text: "Ply\n\n(Selected in the app: shelf)" });
    expect(store.project.pending).toBeNull();
  });

  it("tells Claude about your own edits and undos since its last turn", async () => {
    const client = scripted([[call("t1", "set_param", { name: "w", expr: "600" })], [{ type: "text", text: "Done." }], [{ type: "text", text: "Noted." }]]);
    await turn(client).run({ text: "add w", selection: [] });
    store.project.undo();
    store.project.change("you", "Set depth", [{ op: "set_param", name: "depth", expr: "300", unit: "mm" }]);
    await turn(client).run({ text: "carry on", selection: [] });
    const text = (client.sent[2]!.messages.at(-1)!.content as unknown as Block[]).at(-1)!.text;
    expect(text).toBe('carry on\n\n(Since your last turn the woodworker undid your change "add w"; changed: Set depth. Read the design again before editing.)');
  });

  it("puts attached pictures before the words that refer to them", async () => {
    const client = scripted([[{ type: "text", text: "Nice chair." }]]);
    await turn(client).run({ text: "Like this", selection: [], images: [{ media_type: "image/png", data: "aGk=", name: "1-abc.png" }] });
    const content = client.sent[0]!.messages.at(-1)!.content as unknown as Block[];
    expect(content.map((b) => b.type)).toEqual(["image", "text"]);
    expect(store.project.chat.find((c) => c.kind === "user")).toMatchObject({ images: ["1-abc.png"] });
  });

  it("tells Claude about pins and shows it the woodworker's view", async () => {
    const client = scripted([[{ type: "text", text: "Got it." }]]);
    await turn(client).run({
      text: "Make pin 1 flush with pin 2",
      selection: ["shelf"],
      pins: [
        { n: 1, part: "shelf", face: "front", point_mm: [120.04, 300, 250] },
        { n: 2, part: "left", face: "front", point_mm: [9, 610.26, 300] },
      ],
      view: { media_type: "image/jpeg", data: "aGk=", name: "1-view.jpg" },
    });
    const content = client.sent[0]!.messages.at(-1)!.content as unknown as Block[];
    expect(content.map((b) => b.type)).toEqual(["image", "text"]);
    expect(content[1]!.text).toBe(
      "Make pin 1 flush with pin 2\n\n(Selected in the app: shelf)\n\n(Pinned in the app: pin 1 on shelf, front face, at x 120, y 300, z 250 mm; pin 2 on left, front face, at x 9, y 610.3, z 300 mm.)\n\n(The last picture is the woodworker's view of the model right now. Selected parts are blue and pins are numbered red dots.)",
    );
    expect(store.project.chat.find((c) => c.kind === "user")).toMatchObject({ view: "1-view.jpg", pins: [{ n: 1 }, { n: 2 }] });
  });

  it("pins a plan with a drawing of the draft and waits", async () => {
    const client = scripted([
      [
        call("p1", "submit_plan", {
          summary: "A shelf",
          parts: [{ label: "Shelf", qty: 1, tag: "shelf" }],
          key_dims: [],
          joints: [],
          assumptions: ["18 mm ply"],
        }),
      ],
    ]);
    await turn(client).run({ text: "Design a shelf", selection: [] });
    expect(store.project.pending?.waiting).toEqual([{ tool_use_id: "p1", kind: "plan" }]);
    const plan = store.project.chat.find((c) => c.kind === "plan");
    expect(plan).toMatchObject({ kind: "plan", image: expect.stringMatching(/\.png$/) });
  });

  it("shows a missing-tool card when Claude asks for a tool", async () => {
    const client = scripted([
      [
        call("r1", "request_tool", {
          name: "scarf_joint",
          purpose: "Join two short boards end to end into one long rail",
          example: "rail_a meets rail_b halfway along the back",
          inputs: "host, guest, slope",
          effect: "Cuts a matching slope on both ends",
          check: "Both slopes show on the cut list",
        }),
      ],
      [{ type: "text", text: "The app doesn't have that tool yet." }],
    ]);
    await turn(client).run({ text: "Join the rails", selection: [] });
    expect(store.project.chat.find((c) => c.kind === "tool_request")).toMatchObject({ request: "tr_1" });
    const result = (client.sent[1]!.messages.at(-1)!.content as unknown as Block[])[0]!;
    expect(String(result.content)).toMatch(/sends it to Claude Code/);
  });

  it("keeps the conversation append-only across turns", async () => {
    const client = scripted([[{ type: "text", text: "One." }], [{ type: "text", text: "Two." }]]);
    await turn(client).run({ text: "first", selection: [] });
    const firstHistory = structuredClone(client.sent[0]!.messages);
    await turn(client).run({ text: "second", selection: [] });
    expect(client.sent[1]!.messages.slice(0, firstHistory.length)).toEqual(firstHistory);
  });

  it("uses the model picked for the design", async () => {
    const client = scripted([[{ type: "text", text: "Hi." }]]);
    store.project.model = "claude-fable-5-1";
    await turn(client).run({ text: "hello", selection: [] });
    expect(client.sent[0]!.model).toBe("claude-fable-5-1");
  });

  it("caches the tools and system prompt and never forces a tool", async () => {
    const client = scripted([[{ type: "text", text: "Hi." }]]);
    await turn(client).run({ text: "hello", selection: [] });
    const body = client.sent[0]! as unknown as Record<string, unknown>;
    // The standing instructions, then the workshop, with the one breakpoint on the workshop.
    const system = body.system as { text: string; cache_control?: unknown }[];
    expect(system).toHaveLength(2);
    expect(system[0]!.cache_control).toBeUndefined();
    expect(system[1]!.cache_control).toEqual({ type: "ephemeral" });
    expect(body.tool_choice).toBeUndefined();
    expect(body.thinking).toMatchObject({ type: "adaptive" });
  });
});

// A build goes quicker when one reply carries a whole stage. The fixture is a
// small invented carcass: two 18 mm sides 500 mm apart and a shelf between.
describe("a reply with many tool calls", () => {
  const ply = call("t1", "define_material", { id: "ply18", name: "18 mm ply", kind: "sheet", thickness_mm: 18, grained: true });
  const side = (callId: string, id: string, name: string, x: Block) =>
    call(callId, "add_panel", {
      id,
      name,
      material: "ply18",
      thickness_axis: "x",
      grain_axis: "y",
      x,
      y: { start: { at: "0" }, size: "600" },
      z: { start: { at: "0" }, size: "300" },
    });
  const left = side("t2", "left", "Left side", { start: { at: "0" } });
  const right = side("t3", "right", "Right side", { end: { at: "500" } });
  const shelf = (callId: string, id: string, material: string) =>
    call(callId, "add_panel", {
      id,
      name: "Shelf",
      material,
      thickness_axis: "y",
      grain_axis: "x",
      x: { start: { face: "left.right" }, end: { face: "right.left" } },
      y: { start: { at: "200" } },
      z: { start: { at: "0" }, size: "300" },
    });
  const results = (client: ReturnType<typeof scripted>, n: number) => client.sent[n]!.messages.at(-1)!.content as unknown as Block[];

  it("asks for independent edits together, and leaves parallel calls on", async () => {
    const client = scripted([[{ type: "text", text: "Hi." }]]);
    await turn(client).run({ text: "hello", selection: [] });
    const body = client.sent[0]! as unknown as Record<string, unknown>;
    expect(body.tool_choice).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("disable_parallel_tool_use");
    expect(SYSTEM_PROMPT).toContain("Put independent edits together in one reply.");
  });

  // A new prompt, tool list or workshop changes what earlier thinking was
  // tied to. The API drops that thinking only for a request that asks.
  it("asks the API to drop stale thinking on every request, so an open chat carries on", async () => {
    const base = scripted([[ply], [{ type: "text", text: "Done." }]]);
    let n = 0;
    const client: MessagesClient = {
      stream(body) {
        const s = base.stream(body);
        const first = n++ === 0;
        return {
          on: (event, cb) => s.on(event, cb),
          abort: () => s.abort(),
          finalMessage: async () => {
            const m = await s.finalMessage();
            const dropped = [
              { type: "thinking_dropped", path: "messages.1.content.0", reason: "prefix_binding_mismatch" },
              { type: "thinking_dropped", path: "messages.3.content.0", reason: "model_binding_mismatch" },
              { type: "a_later_kind", reason: "prefix_binding_mismatch" },
            ];
            return { ...m, input_transformations: first ? dropped : dropped.slice(1) } as Anthropic.Beta.BetaMessage;
          },
        };
      },
    };
    const logged: unknown[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => void logged.push(args);
    try {
      await turn(client).run({ text: "Build a small carcass", selection: [] });
    } finally {
      console.log = log;
    }
    expect(base.sent).toHaveLength(2);
    for (const sent of base.sent) {
      const body = sent as unknown as { thinking: Record<string, unknown>; betas: string[] };
      expect(body.thinking).toEqual({ type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } });
      expect(body.betas).toContain("thinking-binding-controls-2026-08-01");
    }
    // One line for the turn, and none for thinking from another model.
    expect(logged).toHaveLength(1);
    expect(JSON.stringify(logged)).toMatch(/left it out/);
  });

  it("runs every call in order, carries on past a failed one, and undoes as one change", async () => {
    const client = scripted([
      [
        { type: "text", text: "Carcass first." },
        ply,
        left,
        right,
        shelf("t4", "broken", "walnut"),
        shelf("t5", "shelf", "ply18"),
        call("t6", "add_joint", { id: "shelf_l", type: "dado", host: "left", guest: "shelf", depth: "6" }),
      ],
      [{ type: "text", text: "Carcass done." }],
    ]);
    await turn(client).run({ text: "Build a small carcass", selection: [] });

    // One result per call, in the order of the calls, and only the bad one is an error.
    const sent = results(client, 1);
    expect(sent.map((b) => b.type)).toEqual(Array(6).fill("tool_result"));
    expect(sent.map((b) => b.tool_use_id)).toEqual(["t1", "t2", "t3", "t4", "t5", "t6"]);
    expect(sent.filter((b) => b.is_error).map((b) => b.tool_use_id)).toEqual(["t4"]);
    expect(String(sent[3]!.content)).toMatch(/walnut/);

    // The design took them in order: the shelf sits between the sides, and its dado lengthens it.
    const design = store.project.design;
    expect(design.parts.map((p) => p.id)).toEqual(["left", "right", "shelf"]);
    expect(design.joints.map((j) => j.id)).toEqual(["shelf_l"]);
    expect(derive(design).byId.get("shelf")!.cut.length).toBe(500 - 36 + 6);
    const tools = store.project.chat.filter((c) => c.kind === "tool");
    expect(tools.map((c) => c.kind === "tool" && c.name)).toEqual(["define_material", "add_panel", "add_panel", "add_panel", "add_panel", "add_joint"]);

    // One change set, so one undo takes the whole stage back.
    expect(store.project.history).toHaveLength(1);
    expect(store.project.chat.find((c) => c.kind === "change")).toMatchObject({ author: "claude", edits: 5 });
    store.project.undo();
    expect(store.project.design.parts).toEqual([]);
    expect(store.project.design.materials).toEqual([]);
  });

  it("runs the calls around a question, waits once, and answers in call order", async () => {
    const client = scripted([
      [
        ply,
        left,
        call("q1", "ask_user", { question: "Fixed or adjustable shelf?", options: ["Fixed", "Adjustable"] }),
        right,
        call("q2", "ask_user", { question: "Painted or oiled?", options: ["Painted", "Oiled"] }),
      ],
      [{ type: "text", text: "A fixed shelf it is." }],
    ]);
    await turn(client).run({ text: "Build a small carcass", selection: [] });

    // The calls after the question still ran, and only the first question waits.
    expect(store.project.design.parts.map((p) => p.id)).toEqual(["left", "right"]);
    expect(store.project.pending?.waiting).toEqual([{ tool_use_id: "q1", kind: "question" }]);
    expect(store.project.chat.filter((c) => c.kind === "question")).toHaveLength(1);
    expect(client.sent).toHaveLength(1);

    await turn(client).run({ text: "Fixed", selection: [] });
    const sent = results(client, 1);
    expect(sent.map((b) => b.tool_use_id ?? b.type)).toEqual(["t1", "t2", "q1", "t3", "q2", "text"]);
    expect(sent[2]).toMatchObject({ content: "Fixed" });
    expect(sent[2]!.is_error).toBeUndefined();
    expect(sent[4]).toMatchObject({ is_error: true, content: expect.stringMatching(/^Not run: this reply already calls ask_user/) });
    expect(store.project.pending).toBeNull();
  });

  it("keeps one preview waiting when a reply suggests two", async () => {
    const preview = (id: string, title: string) =>
      call(id, "preview_change", { title, explanation: "A suggestion.", ops: [{ op: "set_param", name: "depth", expr: "320", unit: "mm" }] });
    const client = scripted([[preview("v1", "Deeper"), call("t1", "set_param", { name: "gap", expr: "2", unit: "mm" }), preview("v2", "Deeper still")]]);
    await turn(client).run({ text: "Any ideas?", selection: [] });
    expect(store.project.pending?.waiting).toEqual([{ tool_use_id: "v1", kind: "preview" }]);
    expect(store.project.chat.filter((c) => c.kind === "preview").map((c) => c.kind === "preview" && c.title)).toEqual(["Deeper"]);
    expect(store.project.pending?.held.map((r) => [r.tool_use_id, !!r.is_error])).toEqual([
      ["t1", false],
      ["v2", true],
    ]);
  });

  it("answers every call of a reply that was cut off, without running any", async () => {
    const base = scripted([[ply, left, { ...right, input: { id: "right" } }], [{ type: "text", text: "Carrying on." }]]);
    let cut = true;
    const client: MessagesClient = {
      stream(body) {
        const s = base.stream(body);
        return {
          on: (event, cb) => s.on(event, cb),
          abort: () => s.abort(),
          finalMessage: async () => {
            const m = await s.finalMessage();
            const out = cut ? { ...m, stop_reason: "max_tokens" as const } : m;
            cut = false;
            return out;
          },
        };
      },
    };
    await turn(client).run({ text: "Build a small carcass", selection: [] });
    expect(store.project.design.parts).toEqual([]);
    expect(store.project.chat.at(-2)).toMatchObject({ kind: "error", text: expect.stringMatching(/cut off/) });
    expect(store.project.pending?.waiting).toEqual([]);

    // The next message goes in after a result for each of those calls, so the request is valid.
    await turn(client).run({ text: "Carry on", selection: [] });
    const sent = results(base, 1);
    expect(sent.map((b) => b.tool_use_id ?? b.type)).toEqual(["t1", "t2", "t3", "text"]);
    expect(sent.slice(0, 3).every((b) => b.is_error === true && /^Not run/.test(String(b.content)))).toBe(true);
    expect(store.project.pending).toBeNull();
  });
});

describe("a long chat", () => {
  // The API summarises the older turns; the whole chat stays on disk.
  it("asks the API to summarise once the chat passes the threshold", async () => {
    const client = scripted([[{ type: "text", text: "Hi." }]]);
    await turn(client).run({ text: "hello", selection: [] });
    const body = client.sent[0]! as unknown as Record<string, unknown>;
    expect(body.context_management).toEqual({
      edits: [{ type: "compact_20260112", trigger: { type: "input_tokens", value: 100_000 }, instructions: SUMMARY_INSTRUCTIONS }],
    });
    expect(body.betas).toContain("compact-2026-01-12");
    expect(body.output_config).toEqual({ effort: "high" });
  });

  it("reads the threshold from the setting, with the API's floor and an off switch", () => {
    expect(compactAt(undefined)).toBe(100_000);
    expect(compactAt("120000")).toBe(120_000);
    expect(compactAt("1000")).toBe(50_000);
    expect(compactAt("off")).toBeNull();
  });

  it("sends only the summary onwards, keeps the rest on disk, and says so in the chat", async () => {
    const client = scripted([
      [{ type: "compaction", content: "They want a fir bookshelf.", encrypted_content: null }, { type: "text", text: "Noted." }],
      [{ type: "text", text: "Still fir." }],
    ]);
    await turn(client).run({ text: "first", selection: [] });
    expect(store.project.chat.some((c) => c.kind === "summary")).toBe(true);
    await turn(client).run({ text: "second", selection: [] });
    const sent = client.sent[1]!.messages;
    expect(sent[0]!.role).toBe("assistant");
    expect((sent[0]!.content as unknown as Block[])[0]).toMatchObject({ type: "compaction" });
    expect(sent).toHaveLength(2);
    expect(store.project.messages).toHaveLength(4);
  });

  it("counts the summary's tokens and the cache writes in the turn's usage", async () => {
    const client: MessagesClient = {
      stream: () => ({
        on: () => undefined,
        abort: () => undefined,
        finalMessage: async () =>
          ({
            content: [{ type: "text", text: "Done." }],
            stop_reason: "end_turn",
            usage: {
              input_tokens: 10,
              output_tokens: 20,
              cache_read_input_tokens: 300,
              cache_creation_input_tokens: 40,
              iterations: [
                { type: "compaction", input_tokens: 5000, output_tokens: 700, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
                { type: "message", input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 },
              ],
            },
          }) as unknown as Anthropic.Beta.BetaMessage,
      }),
    };
    await turn(client).run({ text: "hi", selection: [] });
    expect(store.project.chat.find((c) => c.kind === "usage")).toMatchObject({ input: 5010, cached: 300, written: 40, output: 720 });
  });

  it("lets Claude look back through the whole chat", async () => {
    const client = scripted([
      [{ type: "text", text: "Spotted gum legs it is, 70 by 35." }],
      [{ type: "text", text: "Sure." }],
      [call("r1", "recall_chat", { query: "what timber for the legs?" }), call("r2", "recall_chat", { from: "start", limit: 1 })],
      [{ type: "text", text: "Spotted gum." }],
    ]);
    await turn(client).run({ text: "Let's do the legs in spotted gum", selection: [] });
    await turn(client).run({ text: "Make the shelf deeper", selection: [] });
    await turn(client).run({ text: "What did we pick for the legs at the start?", selection: [] });
    const results = client.sent[3]!.messages.at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[];
    const byQuery = String(results[0]!.content);
    expect(byQuery).toMatch(/^3 of 5 chat lines about timber, leg, oldest first:/);
    expect(byQuery).toContain("Woodworker: Let's do the legs in spotted gum");
    expect(byQuery).toContain("Claude: Spotted gum legs it is, 70 by 35.");
    expect(String(results[1]!.content)).toMatch(/^The first 1 of 6 chat lines, oldest first:\n\[1 · \d{4}-\d\d-\d\d \d\d:\d\d\] Woodworker: Let's do the legs/);
  });
});

describe("the tool list", () => {
  it("is exactly the deterministic set, with no way to run code", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual(
      [
        "add_joint",
        "add_panel",
        "add_unverified_box",
        "apply_edits",
        "ask_user",
        "check_design",
        "clear_design",
        "define_material",
        "delete_array",
        "delete_hardware",
        "delete_joint",
        "delete_material",
        "delete_param",
        "delete_part",
        "delete_rule",
        "explain",
        "get_cut_list",
        "get_design",
        "get_part",
        "list_joints",
        "list_library_parts",
        "measure",
        "preview_change",
        "propose_library_part",
        "recall_chat",
        "rename_design",
        "render_views",
        "request_tool",
        "set_array",
        "set_finish",
        "set_hardware",
        "set_param",
        "set_rule",
        "show_joint",
        "submit_plan",
        "update_panel",
        "verify_against_plan",
      ].sort(),
    );
  });
});
