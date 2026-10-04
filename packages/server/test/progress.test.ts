// How a build is going, worked out from the chat at once. Another
// app, such as Crossband, reads it to watch a long build without waiting.

import { describe, expect, it } from "vitest";
import { background, duration, progress, progressText, stageOf, type Item } from "../src/progress.js";

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
      stage: "Carcass done. Now the drawers.",
      recent: ["add panel side_l", "add panel side_r", "add panel top"],
      waiting_for: null,
      ask: "",
      queued: [{ id: "d2", text: "And darker" }],
      reply: "",
    });
    expect(progressText(p)).toBe(
      "Woodchuck's Claude is working: Carcass done. Now the drawers. (4 steps, 5 min 12 s so far.)\nLatest steps: add panel side_l; add panel side_r; add panel top.\nOne message is waiting to reach it after its current step.",
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
    expect(progressText(p)).toBe("Woodchuck's Claude is waiting for an answer to a question: Oak or ply?");
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
    expect(Object.keys(b)).toEqual(["job", "state", "title", "progress_tool", "stage", "steps", "elapsed_s", "waiting_for", "ask", "reply"]);
    expect(b).toMatchObject({ job: "u1", state: "running", title: "Woodchuck", progress_tool: "woodchuck_progress", steps: 4, elapsed_s: 312, waiting_for: null });
  });

  it("puts times in plain words", () => {
    expect(duration(45)).toBe("45 s");
    expect(duration(120)).toBe("2 min");
    expect(duration(312)).toBe("5 min 12 s");
  });
});
