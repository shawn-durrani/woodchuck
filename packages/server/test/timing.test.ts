// What a turn's usage line records about its time: each request to Claude,
// its first streamed words, its tokens and tool calls, and the time the
// tools took, and the level each request was written at. A fake clock moves
// only when the fake Claude or a render says so, so every number is exact.
// Issue #10.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { EFFORT, MODEL, Turn, type MessagesClient } from "../src/agent.js";
import { Store, type ChatItem } from "../src/store.js";

type Block = Record<string, unknown>;

/** One reply: how long before its first streamed event, how long after, what it says, and its tokens. */
interface Reply {
  first_ms: number;
  rest_ms: number;
  content: Block[];
  usage?: Record<string, unknown>;
  /** Fails this try after first_ms, with this error. */
  error?: unknown;
}

let dir: string;
let store: Store;
let clock = 0;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "woodchuck-timing-"));
  store = new Store(dir);
  clock = 1_000;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fake(replies: Reply[]): MessagesClient {
  return {
    stream() {
      const r = replies.shift()!;
      const on: Record<string, (d: string) => void> = {};
      return {
        on(event: string, cb: (d: string) => void) {
          on[event] = cb;
          return this;
        },
        async finalMessage() {
          clock += r.first_ms;
          if (r.error) throw r.error;
          for (const b of r.content) {
            if (b.type === "thinking") on.thinking?.(String(b.thinking));
            if (b.type === "text") on.text?.(String(b.text));
          }
          clock += r.rest_ms;
          return {
            content: r.content,
            stop_reason: r.content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
            usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...r.usage },
          } as unknown as Anthropic.Beta.BetaMessage;
        },
        abort() {},
      };
    },
  };
}

/** A render that takes 140 ms on the fake clock. */
const render = () => {
  clock += 140;
  return Buffer.from("png");
};

const turn = (client: MessagesClient) => new Turn(store, client, { chat() {}, delta() {}, changed() {} }, render, undefined, [0, 0], () => clock);

const usage = () => store.project.chat.find((c): c is ChatItem & { kind: "usage" } => c.kind === "usage")!;

const call = (id: string, name: string, input: Block): Block => ({ type: "tool_use", id, name, input });

describe("a turn's timing", () => {
  it("keeps each request's time, first streamed event, tokens and tool calls", async () => {
    const client = fake([
      {
        first_ms: 2_000,
        rest_ms: 6_000,
        content: [{ type: "thinking", thinking: "Width first." }, call("t1", "set_param", { name: "width", expr: "600", unit: "mm" }), call("t2", "render_views", { views: ["front"] })],
        usage: { input_tokens: 40, cache_read_input_tokens: 9_000, cache_creation_input_tokens: 300, output_tokens: 250 },
      },
      {
        first_ms: 1_500,
        rest_ms: 2_500,
        content: [{ type: "text", text: "Set the width to 600 mm." }],
        usage: { input_tokens: 10, cache_read_input_tokens: 9_300, cache_creation_input_tokens: 80, output_tokens: 30 },
      },
    ]);
    await turn(client).run({ text: "Make it 600 wide", selection: [] });

    const u = usage();
    expect(u).toMatchObject({ input: 50, cached: 18_300, written: 380, output: 280, model: MODEL, route: "new_build", ms: 12_140, tool_ms: 140 });
    // An empty design asks for a build, at the full level.
    expect(u.rounds).toEqual([
      { effort: EFFORT, ttft_ms: 2_000, ms: 8_000, input: 40, cached: 9_000, written: 300, output: 250, calls: 2 },
      { effort: EFFORT, ttft_ms: 1_500, ms: 4_000, input: 10, cached: 9_300, written: 80, output: 30, calls: 0 },
    ]);
    // Each round's level is the only record of it.
    expect(u).not.toHaveProperty("efforts");
    expect(u).not.toHaveProperty("effort");
  });

  it("records the design's own model", async () => {
    store.project.model = "claude-opus-5-5";
    await turn(fake([{ first_ms: 100, rest_ms: 100, content: [{ type: "text", text: "Hi." }] }])).run({ text: "Hello", selection: [] });
    expect(usage()).toMatchObject({ model: "claude-opus-5-5" });
  });

  it("keeps the level each request was written at on its round, as it rises mid-turn", async () => {
    // An invented top for a console Alex is making, so a colour try starts low.
    store.project.apply([
      { op: "define_material", id: "oak30", name: "30 mm oak", kind: "solid", thickness_mm: 30, grained: true },
      {
        op: "add_panel",
        id: "top",
        name: "Top",
        material: "oak30",
        thickness_axis: "y",
        grain_axis: "x",
        x: { start: { at: "0" }, size: "1200" },
        y: { start: { at: "700" } },
        z: { start: { at: "0" }, size: "400" },
      },
    ]);
    const client = fake([
      { first_ms: 0, rest_ms: 1_000, content: [call("t1", "list_joints", {})] },
      { first_ms: 100, rest_ms: 100, content: [{ type: "text", text: "Amsterdam on the top." }] },
    ]);
    const t = turn(client);
    await t.run({ text: "Try Amsterdam on the top", selection: [] });
    // list_joints needs judgement, so the second request goes back up.
    expect(usage().rounds!.map((r) => r.effort)).toEqual(["low", "high"]);
    expect(t.roundEfforts()).toEqual(["low", "high"]);
    expect(usage()).toMatchObject({ route: "finish" });
  });

  it("counts an apply_edits call once, with the edits it listed beside it", async () => {
    const edits = [
      { op: "set_param", name: "width_mm", expr: "900", unit: "mm" },
      { op: "set_param", name: "depth_mm", expr: "300", unit: "mm" },
      { op: "set_param", name: "height_mm", expr: "750", unit: "mm" },
    ];
    const client = fake([
      { first_ms: 0, rest_ms: 1_000, content: [call("t1", "apply_edits", { edits }), call("t2", "check_design", {})] },
      { first_ms: 100, rest_ms: 100, content: [{ type: "text", text: "Set the sizes." }] },
    ]);
    await turn(client).run({ text: "Set the sizes", selection: [] });
    expect(usage().rounds!.map((r) => [r.calls, r.edits])).toEqual([
      [2, 3],
      [0, undefined],
    ]);
    expect(usage().rounds![1]).not.toHaveProperty("edits");
  });

  it("has no first event for a reply of tool calls alone", async () => {
    const client = fake([
      { first_ms: 0, rest_ms: 3_000, content: [call("t1", "set_param", { name: "a", expr: "1", unit: "mm" })] },
      { first_ms: 500, rest_ms: 500, content: [{ type: "text", text: "Done." }] },
    ]);
    await turn(client).run({ text: "Add a", selection: [] });
    expect(usage().rounds!.map((r) => [r.ttft_ms, r.ms, r.calls])).toEqual([
      [null, 3_000, 1],
      [500, 1_000, 0],
    ]);
  });

  it("counts a retried request once, notes its retries, and times the first event from the try that worked", async () => {
    const dropped = new Anthropic.APIConnectionError({ message: "Connection error." });
    const client = fake([
      { first_ms: 5_000, rest_ms: 0, content: [], error: dropped },
      { first_ms: 1_000, rest_ms: 1_000, content: [{ type: "text", text: "Built it." }], usage: { output_tokens: 12 } },
    ]);
    await turn(client).run({ text: "Build it", selection: [] });
    expect(usage().rounds).toEqual([{ effort: EFFORT, ttft_ms: 1_000, ms: 7_000, input: 0, cached: 0, written: 0, output: 12, calls: 0, retries: 1 }]);
  });

  it("marks the request where the API summarised the chat, with the summary's tokens in it", async () => {
    const client = fake([
      {
        first_ms: 100,
        rest_ms: 100,
        content: [
          { type: "compaction", content: "Summary." },
          { type: "text", text: "Carrying on." },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          iterations: [{ type: "compaction", input_tokens: 5_000, output_tokens: 700, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }],
        },
      },
    ]);
    await turn(client).run({ text: "Carry on", selection: [] });
    expect(usage().rounds).toEqual([{ effort: EFFORT, ttft_ms: 100, ms: 200, input: 5_010, cached: 0, written: 0, output: 720, calls: 0, compacted: true }]);
  });

  it("is still written when the turn ends in an error, with the rounds that finished", async () => {
    const refused = new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: "nope" } }, "nope", new Headers());
    const client = fake([
      { first_ms: 0, rest_ms: 1_000, content: [call("t1", "set_param", { name: "a", expr: "1", unit: "mm" })] },
      { first_ms: 300, rest_ms: 0, content: [], error: refused },
    ]);
    await turn(client).run({ text: "Add a", selection: [] });
    expect(usage()).toMatchObject({ ms: 1_300 });
    expect(usage().rounds).toHaveLength(1);
  });
});
