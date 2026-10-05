// The turn stats script, run on an invented data folder made here. It has
// to count rounds, calls and seconds right, rebuild older turns from the
// conversation, and print nothing from a chat or a design. Issue #10.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Turn } from "../src/agent.js";
import { scriptedClient } from "../src/scripted.js";
import { Store, type ChatItem } from "../src/store.js";
import { coldStart, readTurns, report, roundsFromMessages, spread, turnsOf } from "../src/turnstats.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
// Words that must never reach the report.
const SECRET = ["Globex hall table", "globex-hall-table", "Mateo wants spotted gum", "Dave asked for walnut", "initech-shelf"];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "woodchuck-stats-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const at = (s: number) => new Date(Date.UTC(2026, 9, 5, 9, 0, s)).toISOString();
const call = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });

/** A design whose chat came from a real turn, timed on a fake clock. */
async function timedDesign() {
  const store = new Store(dir);
  store.create("Globex hall table");
  let clock = 0;
  const replies = [
    [{ type: "thinking", thinking: "Mateo wants spotted gum." }, call("t1", "set_param", { name: "width_mm", expr: "900", unit: "mm" }), call("t2", "set_param", { name: "depth_mm", expr: "300", unit: "mm" })],
    [{ type: "text", text: "Mateo wants spotted gum, so I set 900 by 300." }],
  ];
  const client = scriptedClient(replies);
  const ticking = {
    stream(body: Parameters<typeof client.stream>[0]) {
      const s = client.stream(body);
      return {
        on: s.on.bind(s),
        abort: s.abort.bind(s),
        async finalMessage() {
          clock += 4_000;
          const m = await s.finalMessage();
          clock += 1_000;
          return m;
        },
      };
    },
  };
  await new Turn(store, ticking, { chat() {}, delta() {}, changed() {} }, () => Buffer.from("png"), undefined, [0, 0], () => clock).run({
    text: "Make it Mateo wants spotted gum",
    selection: [],
  });
}

/** A design from before timing was kept: token counts only, with the conversation to rebuild it from. */
function olderDesign() {
  const p = path.join(dir, "projects", "initech-shelf");
  mkdirSync(p, { recursive: true });
  const chat: ChatItem[] = [
    { id: "u1", kind: "user", text: "Dave asked for walnut", selection: [], at: at(0) },
    { id: "x1", kind: "tool", name: "set_finish", summary: "set finish walnut", is_error: false, at: at(10) },
    { id: "n1", kind: "usage", input: 30, cached: 8_000, written: 500, output: 400, at: at(20) },
    { id: "c1", kind: "change", change: 1, author: "claude", label: "Dave asked for walnut", edits: 1, at: at(20) },
    { id: "u2", kind: "user", text: "Dave asked for walnut again", selection: [], at: at(100) },
    { id: "n2", kind: "usage", input: 10, cached: 9_000, written: 100, output: 50, at: at(130) },
    // Sent during the second turn, and moved down when the third began with it.
    { id: "u3", kind: "user", text: "Dave asked for walnut, darker", selection: [], during: true, taken: "turn", at: at(105) },
    { id: "n3", kind: "usage", input: 5, cached: 9_100, written: 20, output: 30, at: at(160) },
  ];
  const messages = [
    { role: "user", content: [{ type: "text", text: "Dave asked for walnut" }] },
    { role: "assistant", content: [call("a", "get_design", {}), call("b", "set_finish", {}), call("c", "check_design", {})] },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "a", content: "ok" },
        { type: "text", text: '(While you were working, the woodworker said: "Dave asked for walnut")' },
      ],
    },
    { role: "assistant", content: [call("d", "render_views", {})] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "d", content: "ok" }] },
    { role: "assistant", content: [{ type: "text", text: "Dave asked for walnut, done." }] },
    { role: "user", content: "Dave asked for walnut again" },
    { role: "assistant", content: [{ type: "text", text: "Sure." }] },
    { role: "user", content: [{ type: "text", text: "Dave asked for walnut, darker" }] },
    { role: "assistant", content: [{ type: "text", text: "Darker." }] },
  ];
  writeFileSync(path.join(p, "design.json"), JSON.stringify({ name: "Initech shelf" }));
  writeFileSync(path.join(p, "chat.json"), JSON.stringify(chat));
  writeFileSync(path.join(p, "messages.json"), JSON.stringify(messages));
}

describe("turn stats", () => {
  it("reads timed turns from their usage lines", async () => {
    await timedDesign();
    const [t] = readTurns(dir);
    expect(t).toMatchObject({ design: 1, turn: 1, timed: true, calls: [2, 0], ms: 10_000 });
    expect(t!.rounds!.map((r) => [r.ttft_ms, r.ms])).toEqual([
      [4_000, 5_000],
      [4_000, 5_000],
    ]);
  });

  it("rebuilds older turns from the conversation and the chat's times", () => {
    olderDesign();
    const turns = readTurns(dir);
    expect(turns.map((t) => [t.timed, t.calls, t.ms])).toEqual([
      // The first turn, with a message taken in mid-turn.
      [false, [3, 1, 0], 20_000],
      [false, [0], 30_000],
      // A follow-up turn starts when the last one ended.
      [false, [0], 30_000],
    ]);
  });

  it("lines up the latest turns when an old chat has more usage lines than turns", () => {
    const chat: ChatItem[] = [
      { id: "n0", kind: "usage", input: 1, cached: 0, output: 1, at: at(0) },
      { id: "u1", kind: "user", text: "Hi Sam", selection: [], at: at(10) },
      { id: "n1", kind: "usage", input: 1, cached: 0, output: 1, at: at(14) },
    ];
    const turns = turnsOf(chat, [
      { role: "user", content: "Hi Sam" },
      { role: "assistant", content: [{ type: "text", text: "Hi." }] },
    ]);
    expect(turns.map((t) => [t.calls, t.ms])).toEqual([
      [null, null],
      [[0], 4_000],
    ]);
  });

  it("starts a turn at an answer to Claude's question, which comes with the waiting call's result", () => {
    expect(
      roundsFromMessages([
        { role: "user", content: "A shelf for Alex" },
        { role: "assistant", content: [call("q", "ask_user", {}) as never] },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "q", content: "Oak" },
            { type: "text", text: "Oak" },
          ],
        },
        { role: "assistant", content: [call("m", "define_material", {}) as never, call("p", "add_panel", {}) as never] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "m", content: "ok" }] },
        { role: "assistant", content: [{ type: "text", text: "Done." }] },
      ]),
    ).toEqual([[1], [2, 0]]);
  });

  it("works out medians, the 90th percentile and a cold start", () => {
    expect(spread([5, 1, 4, 2, 3, 10, 6, 7, 8, 9])).toEqual({ n: 10, median: 5, p90: 9 });
    expect(spread([])).toEqual({ n: 0, median: null, p90: null });
    const round = { effort: "high" as const, ttft_ms: 1, ms: 2, input: 10, cached: 0, written: 9_000, output: 5, calls: 0 };
    const turn = { design: 1, turn: 1, timed: true, calls: [0], ms: 2, tool_ms: 0, model: null, efforts: ["high"], route: null, edits: 0, input: 0, cached: 0, written: 0, output: 0 };
    expect(coldStart({ ...turn, rounds: [round] })).toBe(true);
    expect(coldStart({ ...turn, rounds: [{ ...round, cached: 9_000, written: 200 }] })).toBe(false);
  });

  it("tallies the level of each request and the rule that picked it, from rounds and from older efforts lists", () => {
    const round = { ttft_ms: 500, ms: 3_000, input: 10, cached: 9_000, written: 50, output: 200 };
    const chat: ChatItem[] = [
      { id: "u1", kind: "user", text: "Build the carcass for Sam", selection: [], at: at(0) },
      {
        id: "n1",
        kind: "usage",
        input: 20,
        cached: 18_000,
        written: 100,
        output: 400,
        at: at(10),
        model: "claude-sonnet-5-5",
        route: "build",
        ms: 6_000,
        tool_ms: 80,
        // One apply_edits call carrying a whole stage, then a reply in words.
        rounds: [
          { ...round, effort: "medium", calls: 1, edits: 12 },
          { ...round, effort: "high", calls: 0 },
        ],
      },
      { id: "u2", kind: "user", text: "Try Amsterdam on the top", selection: [], at: at(20) },
      // Saved before rounds were kept: its levels are a list of their own.
      { id: "n2", kind: "usage", input: 5, cached: 9_000, output: 30, efforts: ["low"], route: "finish", at: at(25) },
    ];
    const turns = turnsOf(chat, [
      { role: "user", content: "Build the carcass for Sam" },
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "apply_edits", input: { edits: [] } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "ok" }] },
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
      { role: "user", content: "Try Amsterdam on the top" },
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
    ]);
    expect(turns.map((t) => [t.timed, t.efforts, t.route, t.edits, t.calls])).toEqual([
      [true, ["medium", "high"], "build", 12, [1, 0]],
      [false, ["low"], "finish", null, [0]],
    ]);
    const text = report(turns);
    expect(text).toContain("medium>high");
    expect(text).toContain("Rounds that used apply_edits: 1, listing 12 edits between them.");
    expect(text).toContain("Effort per request: high 1, low 1, medium 1.");
    expect(text).toContain("Routes: build 1, finish 1.");
  });

  it("prints counts and timings, and nothing from a chat or a design", async () => {
    await timedDesign();
    olderDesign();
    const text = report(readTurns(dir));
    expect(text).toContain("4 turns in 2 designs: 1 timed, 3 rebuilt from older chats.");
    expect(text).toMatch(/rounds per turn\s+1\s+3\s+4/);
    expect(text).toMatch(/seconds per round, timed\s+5\.0\s+5\.0\s+2/);
    expect(text).toContain("Rounds with more than one tool call: 2 of 3 that called a tool (67%), 29% of all rounds.");
    for (const s of SECRET) expect(text).not.toContain(s);
  });

  it("runs as a script on the folder it's given", async () => {
    await timedDesign();
    olderDesign();
    const out = execFileSync(path.join(ROOT, "node_modules/.bin/tsx"), [path.join(ROOT, "scripts/turn-stats.ts"), dir], { encoding: "utf8" });
    expect(out).toContain("4 turns in 2 designs");
    for (const s of SECRET) expect(out).not.toContain(s);
  });
});
