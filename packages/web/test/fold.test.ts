// A quieter chat: each turn's tool lines and Thinking fold into its change
// line, while errors and the pictures Claude looked at stay in view.

import { describe, expect, it } from "vitest";
import type { ChatItem } from "../src/api.js";
import { duringNote, foldLine, foldTurns, joinYourEdits, latestStep, notYetRead, turnTime, type Folded, type Row } from "../src/fold.js";

const at = "2026-10-04T09:00:00Z";
const user = (id: string, text: string): ChatItem => ({ id, kind: "user", text, selection: [], at });
const said = (id: string, text: string): ChatItem => ({ id, kind: "assistant", text, at });
const think = (id: string): ChatItem => ({ id, kind: "thinking", text: "Working out the rails.", at });
const tool = (id: string, summary: string, extra: { is_error?: boolean; image?: string } = {}): ChatItem => ({
  id,
  kind: "tool",
  name: "set_param",
  summary,
  is_error: extra.is_error ?? false,
  ...(extra.image ? { image: extra.image } : {}),
  at,
});
const change = (id: string, edits: number, author: "claude" | "you" = "claude", n = 1): ChatItem => ({
  id,
  kind: "change",
  change: n,
  author,
  label: "Build the bench",
  edits,
  at,
});

/** The folded chat as ids: a row as its id, a fold as "fold(anchor: steps)". */
const shape = (out: Folded[]) => out.map((f) => (f.kind === "row" ? f.row.id : `fold(${f.id}: ${f.steps.map((s) => s.id).join(" ")})`));

const quiet = { busy: false, showThinking: false };

describe("folding a turn's steps", () => {
  const chat: Row[] = [
    user("u1", "A reading bench"),
    said("a1", "I'll draft it."),
    think("t1"),
    tool("x1", "set param length"),
    tool("x2", "add panel leg_fl"),
    tool("x3", "render views", { image: "r1.png" }),
    tool("x4", "add joint: there's no part called lg_fl", { is_error: true }),
    tool("x5", "add joint mt_fl"),
    said("a2", "Here's the draft."),
    change("c1", 59),
    user("u2", "Make it longer"),
    tool("x6", "set param length"),
    change("c2", 1, "claude", 2),
  ];

  it("folds each turn's tool lines and Thinking into its change line", () => {
    expect(shape(foldTurns(chat, quiet))).toEqual(["u1", "a1", "x3", "x4", "a2", "fold(c1: t1 x1 x2 x5)", "u2", "fold(c2: x6)"]);
  });

  it("keeps errors and Claude's pictures where they were", () => {
    const rows = foldTurns(chat, quiet).flatMap((f) => (f.kind === "row" ? [f.row.id] : []));
    expect(rows).toContain("x3");
    expect(rows).toContain("x4");
  });

  it("says how many edits, and that the steps are there to open", () => {
    const fold = foldTurns(chat, quiet).find((f) => f.kind === "steps" && f.id === "c1") as Extract<Folded, { kind: "steps" }>;
    expect(foldLine(fold, [{ id: 1 }], false)).toBe("Claude made 59 edits · show steps");
    expect(foldLine(fold, [{ id: 1 }], true)).toBe("Claude made 59 edits · hide steps");
  });

  it("says when Undo took the turn's edits back", () => {
    const fold = foldTurns([user("u1", "Go"), tool("x1", "set param a"), { ...change("c1", 3), undone: true } as ChatItem], quiet)[1] as Extract<
      Folded,
      { kind: "steps" }
    >;
    expect(foldLine(fold, [], false)).toBe("Claude made 3 edits. Undone · show steps");
  });

  it("leaves Thinking in place, open, when you've asked to see it", () => {
    expect(shape(foldTurns(chat, { busy: false, showThinking: true }))).toEqual([
      "u1",
      "a1",
      "t1",
      "x3",
      "x4",
      "a2",
      "fold(c1: x1 x2 x5)",
      "u2",
      "fold(c2: x6)",
    ]);
  });

  it("folds a turn with no change line, such as a question, under one line where its steps began", () => {
    const asked: Row[] = [
      user("u1", "Thicker slats?"),
      said("a1", "19 mm is fine for sitting."),
      think("t1"),
      tool("x1", "ask you"),
      { id: "q1", kind: "question", question: "Thicker slats?", options: ["Keep 19 mm"], at },
    ];
    const out = foldTurns(asked, quiet);
    expect(shape(out)).toEqual(["u1", "a1", "fold(t1: t1 x1)", "q1"]);
    expect(foldLine(out[2] as Extract<Folded, { kind: "steps" }>, [], false)).toBe("2 steps · show steps");
  });

  it("leaves a turn with nothing to fold as it is", () => {
    const plain: Row[] = [user("u1", "Hello"), said("a1", "Hi.")];
    expect(shape(foldTurns(plain, quiet))).toEqual(["u1", "a1"]);
  });

  it("never folds into your own change line", () => {
    const yours: Row[] = [user("u1", "Go"), tool("x1", "set param a"), change("c1", 1, "you")];
    expect(shape(foldTurns(yours, quiet))).toEqual(["u1", "fold(x1: x1)", "c1"]);
  });

  it("counts the steps so far in the turn Claude is working on, and names its newest one", () => {
    const working: Row[] = [user("u1", "Build it"), tool("x1", "set param a"), tool("x2", "add panel top")];
    const out = foldTurns(working, { busy: true, showThinking: false });
    const fold = out[1] as Extract<Folded, { kind: "steps" }>;
    expect(fold.live).toBe(true);
    expect(foldLine(fold, [], false)).toBe("2 steps so far · show steps");
    expect(latestStep(working)).toBe("add panel top");
    expect(latestStep([...working, said("a1", "Nearly there.")])).toBeNull();
  });
});

describe("your own edits", () => {
  it("still join into one line, and drop usage lines with no timing", () => {
    const rows = joinYourEdits(
      [
        change("c1", 1, "you", 1),
        change("c2", 2, "you", 2),
        { id: "g1", kind: "usage", input: 1, cached: 0, output: 1, at },
        user("u1", "Hi"),
      ],
      [{ id: 1 }, { id: 2 }],
    );
    expect(rows.map((r) => r.kind)).toEqual(["your_edits", "user"]);
    expect(rows[0]).toMatchObject({ edits: 3, undoneEdits: 0 });
  });
});

describe("a message sent while Claude works", () => {
  const sent = (id: string, taken?: "step" | "turn"): ChatItem => ({ id, kind: "user", text: "Make it oak", selection: [], during: true, ...(taken ? { taken } : {}), at });

  it("waits at the foot of the chat until Claude reads it, and says so", () => {
    const chat = [user("u1", "Build it"), tool("x1", "set param a"), sent("d1"), tool("x2", "add panel top")];
    expect(notYetRead(chat).map((c) => c.id)).toEqual(["d1"]);
    expect(joinYourEdits(chat, []).map((r) => r.id)).toEqual(["u1", "x1", "x2"]);
    expect(duringNote(notYetRead(chat)[0]!)).toBe("Sent while Claude worked · Claude reads it after its current step");
  });

  it("stays inside the turn once Claude takes it in at a step", () => {
    const chat: Row[] = [user("u1", "Build it"), tool("x1", "set param a"), sent("d1", "step"), tool("x2", "add panel top"), change("c1", 2)];
    expect(shape(foldTurns(chat, quiet))).toEqual(["u1", "d1", "fold(c1: x1 x2)"]);
    expect(duringNote(chat[2] as Extract<ChatItem, { kind: "user" }>)).toBe("Sent while Claude worked · taken in");
    expect(duringNote(chat[0] as Extract<ChatItem, { kind: "user" }>)).toBeNull();
  });

  it("keeps counting the steps so far when your edit splits Claude's turn", () => {
    const chat: Row[] = [user("u1", "Build it"), tool("x1", "set param a"), change("c1", 1), change("c2", 1, "you", 2), tool("x2", "add panel top")];
    const out = foldTurns(chat, { busy: true, showThinking: false });
    expect(shape(out)).toEqual(["u1", "fold(x1: x1 x2)", "c1", "c2"]);
    expect(foldLine(out[1] as Extract<Folded, { kind: "steps" }>, [], false)).toBe("2 steps so far · show steps");
  });

  it("starts a turn of its own when Claude's turn ended before reading it", () => {
    const chat: Row[] = [user("u1", "Build it"), tool("x1", "set param a"), change("c1", 1), sent("d1", "turn"), tool("x2", "add panel top"), change("c2", 1, "claude", 2)];
    expect(shape(foldTurns(chat, quiet))).toEqual(["u1", "fold(c1: x1)", "d1", "fold(c2: x2)"]);
  });
});

describe("a turn's timing line", () => {
  type Usage = Extract<ChatItem, { kind: "usage" }>;
  const round = (ms: number, calls: number, retries?: number, effort = "high") => ({ effort, ttft_ms: 900, ms, input: 10, cached: 9000, written: 40, output: 300, calls, ...(retries ? { retries } : {}) });
  const timed = (id: string, ms: number, rounds = [round(ms, 0)]): Usage => ({
    id,
    kind: "usage",
    input: 40,
    cached: 36_000,
    written: 160,
    output: 1_200,
    at,
    model: "claude-sonnet-5-5",
    route: "build",
    ms,
    tool_ms: 300,
    rounds,
  });

  it("sits at the foot of its turn, below the change line written after it", () => {
    const chat = joinYourEdits([user("u1", "Build it"), tool("x1", "set param a"), timed("n1", 38_000), change("c1", 1), user("u2", "Thanks"), said("a1", "Any time.")], []);
    expect(shape(foldTurns(chat, quiet))).toEqual(["u1", "fold(c1: x1)", "n1", "u2", "a1"]);
    expect(shape(foldTurns([user("u1", "Hi"), said("a1", "Hello."), timed("n1", 2_000)], quiet))).toEqual(["u1", "a1", "n1"]);
  });

  it("reads as the time and the rounds, with the rest on hover", () => {
    const u = timed("n1", 38_400, [round(12_000, 2), round(20_000, 3, 1), round(6_400, 0)]);
    expect(turnTime(u)).toEqual({
      line: "38 s · 3 rounds",
      title: "Claude took 38 s over 3 requests, with 5 tool calls. The tools took 0.3 s of it. 1 request was tried again. 1,200 tokens written out by claude-sonnet-5-5 at high effort.",
    });
    expect(turnTime(timed("n2", 4_250))!.line).toBe("4.3 s · 1 round");
    expect(turnTime(timed("n3", 125_000))!.line).toBe("2 min 5 s · 1 round");
  });

  it("names each change of level in order, and the edits made in batches", () => {
    const u = timed("n1", 9_000, [{ ...round(3_000, 1, undefined, "low"), edits: 12 }, round(3_000, 1, undefined, "high"), round(3_000, 0, undefined, "high")]);
    expect(turnTime(u)!.title).toBe(
      "Claude took 9 s over 3 requests, with 2 tool calls, making 12 edits in batches. The tools took 0.3 s of it. 1,200 tokens written out by claude-sonnet-5-5 at low, then high effort.",
    );
  });

  it("is left out for turns from before timing was kept", () => {
    expect(turnTime({ id: "g1", kind: "usage", input: 1, cached: 0, output: 1, at })).toBeNull();
  });
});
