// How a build is going, worked out from the chat at once. Another
// app, such as Crossband, reads it to watch a long build without waiting.

import { describe, expect, it } from "vitest";
import { background, describe as tell, duration, itemsAfter, progress, progressText, requestLine, stageOf, type Item } from "../src/progress.js";

const at = (s: number) => new Date(Date.UTC(2026, 9, 4, 9, 0, s)).toISOString();
const now = Date.parse(at(0)) + 312_000;

const chat: Item[] = [
  { id: "u0", kind: "user", text: "Earlier", at: at(0) },
  { id: "a0", kind: "assistant", text: "Old reply." },
  { id: "u1", kind: "user", text: "Build a bookcase", at: at(0) },
  { id: "k1", kind: "thinking", text: "**Planning the carcass**\n\nSides first. Then shelves." },
  { id: "x1", kind: "tool", name: "set_param", summary: "set param height" },
  { id: "a1", kind: "assistant", text: "Sizes first.\n\nCarcass done. Now the drawers." },
  { id: "x2", kind: "tool", name: "add_panel", summary: "add panel side_l" },
  { id: "d1", kind: "user", text: "Make it oak", during: true, taken: "step", at: at(30) },
  { id: "x3", kind: "tool", name: "add_panel", summary: "add panel side_r" },
  { id: "x4", kind: "tool", name: "add_panel", summary: "add panel top" },
];
const job = { id: "u1", after: "u1", started_at: at(0) };
const base = { chat, job, busy: true, waiting: [], queued: [], now };

describe("progress", () => {
  it("says what Claude is doing while it works, in its own words", () => {
    const p = progress({ ...base, queued: [{ id: "d2", text: "And darker" }] });
    expect(p).toEqual({
      busy: true,
      job: "u1",
      state: "running",
      started_at: at(0),
      elapsed_s: 312,
      steps: 4,
      parts: 0,
      edits: 0,
      error: "",
      answered: "",
      stage: "Carcass done. Now the drawers.",
      recent: ["add panel side_l", "add panel side_r", "add panel top"],
      waiting_for: null,
      ask: "",
      queued: [{ id: "d2", text: "And darker" }],
      reply: "",
    });
    expect(progressText(p)).toBe(
      "Woodchuck's Claude is working: Carcass done. Now the drawers. (4 steps, 5 min 12 s so far.)\nLatest steps: add panel side_l; add panel side_r; add panel top.\nNo parts in the design so far, from 0 edits by Woodchuck's Claude in this request, showing live in the Woodchuck window.\nOne message is waiting to reach it after its current step.",
    );
  });

  it("falls back to the first sentence of Claude's thinking, then its latest step", () => {
    const quiet = chat.filter((c) => c.kind !== "assistant");
    expect(stageOf(quiet)).toBe("Planning the carcass");
    expect(stageOf([{ id: "k", kind: "thinking", text: "Sides first. Then shelves." }])).toBe("Sides first.");
    expect(stageOf(quiet.filter((c) => c.kind !== "thinking"))).toBe("add panel top");
    expect(stageOf([])).toBe("");
    expect(stageOf([{ id: "a", kind: "assistant", text: "x".repeat(400) }])).toHaveLength(160);
  });

  it("says what Claude is waiting on, and stops the clock when it stopped", () => {
    const asked = [...chat, { id: "q1", kind: "question", question: "Oak or ply?", options: ["Oak", "Ply"] }];
    const p = progress({ ...base, chat: asked, busy: false, waiting: ["question"], job: { ...job, ended_at: at(40) } });
    expect(p).toMatchObject({ state: "waiting", waiting_for: "question", ask: "Oak or ply?", elapsed_s: 40 });
    expect(p.reply).toContain("Woodchuck's Claude asks: Oak or ply? (options: Oak; Ply)");
    expect(progressText(p)).toBe("Woodchuck's Claude is waiting for an answer to a question: Oak or ply?\nNo parts in the design.");
  });

  it("gives a preview's title, and Claude's reply once it's done", () => {
    const shown = [...chat, { id: "v1", kind: "preview", title: "Deeper top", explanation: "50 mm deeper.", status: "proposed" }];
    expect(progress({ ...base, chat: shown, busy: false, waiting: ["preview"] })).toMatchObject({ waiting_for: "preview", ask: "Deeper top" });
    const done = progress({ ...base, busy: false, job: { ...job, ended_at: at(50) } });
    expect(done).toMatchObject({ state: "done", elapsed_s: 50, waiting_for: null });
    expect(done.reply).toBe("Sizes first.\n\nCarcass done. Now the drawers.\n\n(It used 4 tools.)");
  });

  it("finds the last request in the chat after a restart, and is idle with none", () => {
    const p = progress({ ...base, job: null, busy: false });
    expect(p).toMatchObject({ job: "u1", state: "done", steps: 4 });
    // A message taken in mid-step doesn't start a request; one that started its own turn does.
    expect(progress({ ...base, job: null, busy: false, chat: [...chat, { id: "d3", kind: "user", during: true, taken: "turn", at: at(60) }] }).job).toBe("d3");
    expect(progress({ ...base, chat: [], job: null, busy: false })).toMatchObject({ job: "", state: "idle", started_at: null, elapsed_s: 0, reply: "" });
  });

  it("hands another app the background block, in exactly the agreed shape", () => {
    const b = background(progress(base)).background;
    expect(Object.keys(b)).toEqual(["job", "state", "title", "progress_tool", "stage", "steps", "elapsed_s", "waiting_for", "ask", "reply", "outcome", "error", "parts", "edits", "answered"]);
    expect(b).toMatchObject({ job: "u1", state: "running", title: "Woodchuck", progress_tool: "woodchuck_progress", steps: 4, elapsed_s: 312, waiting_for: null, outcome: null });
    expect(background(progress({ ...base, busy: false })).background).toMatchObject({ state: "done", outcome: "finished", error: "" });
  });

  it("says a request that an error ended stopped early, with the error first, and keeps the block's state to the agreed four", () => {
    const failed = [...chat, { id: "e1", kind: "error", text: "Claude's API returned an error (no status): Connection error." }, { id: "n1", kind: "usage" }];
    const p = progress({ ...base, chat: failed, busy: false, job: { ...job, ended_at: at(50), error: "Claude's API returned an error (no status): Connection error." } });
    expect(p).toMatchObject({ state: "failed", error: "Claude's API returned an error (no status): Connection error." });
    expect(p.reply).toBe(
      "Woodchuck's Claude stopped with an error before it finished, after 4 steps. The error: Claude's API returned an error (no status): Connection error. The woodworker can ask it to carry on, and it picks up from the design as it is.\n\nSizes first.\n\nCarcass done. Now the drawers.\n\n(It used 4 tools.)",
    );
    expect(progressText(p)).toBe(
      "Woodchuck's Claude stopped with an error before it finished (4 steps, 50 s). The error: Claude's API returned an error (no status): Connection error.\nThe woodworker can ask it to carry on.\nNo parts in the design.",
    );
    expect(background(p).background).toMatchObject({ state: "done", outcome: "failed", error: "Claude's API returned an error (no status): Connection error." });
  });

  it("says a request Stop ended was stopped, not that it failed", () => {
    const stopped = [...chat, { id: "e1", kind: "error", text: "Stopped." }];
    const p = progress({ ...base, chat: stopped, busy: false, job: { ...job, ended_at: at(50), stopped: true } });
    expect(p).toMatchObject({ state: "stopped", error: "" });
    expect(p.reply).toMatch(/^Woodchuck's Claude was stopped before it finished, after 4 steps\. The woodworker can ask it to carry on\.\n\nSizes first\./);
    expect(p.reply).not.toContain("Stopped.");
    expect(progressText(p)).toMatch(/^Woodchuck's Claude was stopped before it finished \(4 steps, 50 s\)\./);
    expect(background(p).background).toMatchObject({ state: "done", outcome: "stopped" });
  });

  it("notices after a restart that the last request ended on an error or a stop, and not on a dropped connection it got past", () => {
    const after = (items: Item[]) => progress({ ...base, chat: [...chat, ...items], job: null, busy: false });
    expect(after([{ id: "e1", kind: "error", text: "Something went wrong: boom" }])).toMatchObject({ state: "failed", error: "Something went wrong: boom" });
    expect(after([{ id: "e1", kind: "error", text: "Stopped." }])).toMatchObject({ state: "stopped" });
    const retried = after([{ id: "e1", kind: "error", text: "The connection to Claude dropped, so Woodchuck is trying again (1 of 2).", retry: true }]);
    expect(retried).toMatchObject({ state: "done" });
    expect(retried.reply).not.toContain("dropped");
  });

  it("says how many parts the design has and Claude's edits so far, counting the change set still open", () => {
    const edited = [...chat, { id: "c1", kind: "change", author: "claude", edits: 3 }, { id: "c2", kind: "change", author: "you", edits: 1 }];
    const p = progress({ ...base, chat: edited, parts: 18, openEdits: 2 });
    expect(p).toMatchObject({ parts: 18, edits: 5 });
    expect(progressText(p)).toContain("\n18 parts in the design so far, from 5 edits by Woodchuck's Claude in this request, showing live in the Woodchuck window.");
    expect(background(p).background).toMatchObject({ parts: 18, edits: 5 });
    // Once it's over, the open change set is closed and its edits are in the chat.
    const done = progress({ ...base, chat: edited, busy: false, parts: 1, openEdits: 2 });
    expect(done.edits).toBe(3);
    expect(progressText(done)).toContain("\n1 part in the design, after 3 edits by Woodchuck's Claude in this request.");
  });

  it("says when a message sent while Claude worked was taken as the reply to its plan", () => {
    const planned: Item[] = [
      ...chat,
      { id: "p1", kind: "plan", plan: { summary: "A walnut record cabinet" }, answered: "Make it oak", answered_by: "d9" },
      { id: "d9", kind: "user", text: "Make it oak", during: true, taken: "turn", at: at(60) },
      { id: "a9", kind: "assistant", text: "Oak it is." },
    ];
    const p = progress({ ...base, chat: planned, job: { id: "d9", after: "d9", started_at: at(60), ended_at: at(70) }, busy: false });
    const line = 'A message the woodworker sent while Woodchuck\'s Claude worked was taken as the reply to its plan, "A walnut record cabinet", so it isn\'t waiting on that any more.';
    expect(p).toMatchObject({ state: "done", answered: line, waiting_for: null });
    expect(background(p).background).toMatchObject({ answered: line, waiting_for: null });
    expect(p.reply).toBe(`${line}\n\nOak it is.`);
    expect(progressText(p).split("\n")[0]).toBe(line);
    expect(tell([planned[planned.length - 3]!], false)).toBe("Woodchuck's Claude pinned a plan: A walnut record cabinet. A message sent while it worked was taken as the reply.");
  });

  it("says where a missing tool's card is and what to press, and that only the woodworker can file it", () => {
    const req = { id: "tr_3", name: "scarf_joint", status: "open" };
    const card = "the Missing tool card in the Woodchuck window's chat, also listed under Missing tools on the All designs and parts page in the design menu";
    expect(requestLine("tr_3", req, "globex/woodchuck")).toBe(
      `Woodchuck's Claude needs a tool the app doesn't have yet, "scarf_joint" (tool request tr_3). To get it built, the woodworker presses "File as a GitHub issue for Claude Code" on ${card}. Nothing in this chat can file it or build it.`,
    );
    expect(requestLine("tr_3", req, null)).toBe(
      `Woodchuck's Claude needs a tool the app doesn't have yet, "scarf_joint" (tool request tr_3). To get it built, the woodworker presses "Copy the spec" on ${card}, and pastes it into Claude Code. Nothing in this chat can file it or build it.`,
    );
    const filed = { ...req, status: "approved", issue_url: "https://github.com/globex/woodchuck/issues/7" };
    expect(requestLine("tr_3", filed, "globex/woodchuck")).toContain("It's filed as a GitHub issue for Claude Code to build: https://github.com/globex/woodchuck/issues/7.");
    // describe() and the reply find the request by the card's id.
    const asked = [...chat, { id: "m1", kind: "tool_request", request: "tr_3" }];
    expect(tell(itemsAfter(asked, "u1"), false, { toolRequests: [filed], repo: "globex/woodchuck" })).toContain("issues/7");
    expect(progress({ ...base, chat: asked, busy: false, toolRequests: [req], repo: null }).reply).toContain('presses "Copy the spec"');
  });

  it("puts times in plain words", () => {
    expect(duration(45)).toBe("45 s");
    expect(duration(120)).toBe("2 min");
    expect(duration(312)).toBe("5 min 12 s");
  });
});
