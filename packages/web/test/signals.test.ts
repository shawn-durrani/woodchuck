// The glow and the switch to the Finished look follow only a new change by
// Claude on the open design, and change lines say when Undo took edits
// back.

import { describe, expect, it } from "vitest";
import { changeLine, isUndone, nextSeen, savedNote, type Seen } from "../src/signals.js";

type Entry = { id: number; author: "you" | "claude" | "example" };

/** Just enough of the server's state for the signals: parts by box, finishes and history. */
function state(slug: string, history: Entry[], boxes: Record<string, number>, finishes: Record<string, string> = {}, busy = false) {
  return {
    project: { slug, name: slug },
    history: history.map((h) => ({ ...h, label: `change ${h.id}`, at: "2026-10-04T09:00:00Z" })),
    derived: { parts: Object.entries(boxes).map(([id, x]) => ({ id, nominal: { min: [x, 0, 0], max: [x + 10, 10, 10] } })) },
    design: { finishes },
    busy,
  } as unknown as Parameters<typeof nextSeen>[1];
}

/** Feeds states in order, as the window receives them, and returns what each one set off. */
function run(states: Parameters<typeof nextSeen>[1][]) {
  let seen: Seen | null = null;
  return states.map((s) => {
    const r = nextSeen(seen, s);
    seen = r.seen;
    return { claude: r.claude, moved: r.moved };
  });
}

describe("Claude's glow", () => {
  it("lights the parts Claude moved when its new change set arrives", () => {
    const [, , done] = run([
      state("bench", [{ id: 1, author: "claude" }], { leg: 0, seat: 0 }),
      // Claude's turn: the design changes before its change set closes.
      state("bench", [{ id: 1, author: "claude" }], { leg: 0, seat: 5 }, {}, true),
      state("bench", [{ id: 1, author: "claude" }, { id: 2, author: "claude" }], { leg: 0, seat: 5 }),
    ]);
    expect(done!.claude).toEqual({ parts: ["seat"], finishes: false });
  });

  it("says when Claude's change set changed colours", () => {
    const [, done] = run([
      state("bench", [], { seat: 0 }),
      state("bench", [{ id: 1, author: "claude" }], { seat: 0 }, { seat: "satin_wood_oil/oslo" }),
    ]);
    expect(done!.claude).toEqual({ parts: [], finishes: true });
  });

  it("stays dark when you open another design whose last change was Claude's", () => {
    const [, opened] = run([
      state("stool", [{ id: 3, author: "you" }], { top: 0 }),
      state("bench", [{ id: 9, author: "claude" }], { leg: 0, seat: 0 }, { seat: "satin_wood_oil/oslo" }),
    ]);
    expect(opened).toEqual({ claude: null, moved: false });
  });

  it("stays dark on undo, and clears an old glow", () => {
    const [, , undone] = run([
      state("bench", [{ id: 1, author: "claude" }], { seat: 0 }),
      state("bench", [{ id: 1, author: "claude" }, { id: 2, author: "you" }], { seat: 5 }),
      state("bench", [{ id: 1, author: "claude" }], { seat: 0 }),
    ]);
    expect(undone).toEqual({ claude: null, moved: true });
  });

  it("stays dark when redo brings back a change set Claude made earlier", () => {
    const [, , , redone] = run([
      state("bench", [{ id: 1, author: "you" }], { seat: 0 }),
      state("bench", [{ id: 1, author: "you" }, { id: 2, author: "claude" }], { seat: 5 }),
      state("bench", [{ id: 1, author: "you" }], { seat: 0 }),
      state("bench", [{ id: 1, author: "you" }, { id: 2, author: "claude" }], { seat: 5 }),
    ]);
    expect(redone!.claude).toBeNull();
  });

  it("stays dark for your own edits and for restoring a version", () => {
    const steps = run([
      state("bench", [{ id: 1, author: "claude" }], { seat: 0 }),
      state("bench", [{ id: 1, author: "claude" }, { id: 2, author: "you" }], { seat: 5 }, { seat: "raw" }),
      state("bench", [{ id: 1, author: "claude" }, { id: 2, author: "you" }, { id: 3, author: "you" }], { seat: 0 }),
    ]);
    expect(steps.map((s) => s.claude)).toEqual([null, null, null]);
  });

  it("lights only Claude's own changes when you edit while it works", () => {
    const steps = run([
      state("bench", [{ id: 1, author: "claude" }], { leg: 0, seat: 0 }),
      state("bench", [{ id: 1, author: "claude" }], { leg: 0, seat: 5 }, {}, true),
      // Your edit splits Claude's turn: its work so far, then yours.
      state("bench", [{ id: 1, author: "claude" }, { id: 2, author: "claude" }, { id: 3, author: "you" }], { leg: 7, seat: 5 }, {}, true),
      state("bench", [{ id: 1, author: "claude" }, { id: 2, author: "claude" }, { id: 3, author: "you" }], { leg: 7, seat: 9 }, {}, true),
      state("bench", [{ id: 1, author: "claude" }, { id: 2, author: "claude" }, { id: 3, author: "you" }, { id: 4, author: "claude" }], { leg: 7, seat: 9 }),
    ]);
    expect(steps[2]!.claude).toBeNull();
    expect(steps[4]!.claude).toEqual({ parts: ["seat"], finishes: false });
  });

  it("stays dark on the first state a window sees", () => {
    expect(run([state("bench", [{ id: 4, author: "claude" }], { seat: 0 })])[0]!.claude).toBeNull();
  });
});

describe("change lines after Undo", () => {
  it("uses the server's mark when there is one", () => {
    expect(isUndone({ change: 2, undone: true }, [{ id: 1 }])).toBe(true);
    expect(isUndone({ change: 2 }, [{ id: 1 }, { id: 2 }])).toBe(false);
  });

  it("works out older lines from the history: a change set missing from between those in force was undone", () => {
    const history = [{ id: 1 }, { id: 4 }];
    expect(isUndone({ change: 2 }, history)).toBe(true);
    expect(isUndone({ change: 3 }, history)).toBe(true);
    expect(isUndone({ change: 4 }, history)).toBe(false);
  });

  it("never calls a change undone just because the saved history was trimmed", () => {
    expect(isUndone({ change: 1 }, [{ id: 5 }, { id: 6 }])).toBe(false);
    expect(isUndone({ change: 1 }, [])).toBe(false);
  });

  it("says so in the line", () => {
    expect(changeLine("you", 2, 0)).toBe("You made 2 edits.");
    expect(changeLine("you", 2, 2)).toBe("You made 2 edits. Undone.");
    expect(changeLine("you", 3, 1)).toBe("You made 3 edits. 1 undone.");
    expect(changeLine("claude", 1, 1)).toBe("Claude made 1 edit. Undone.");
  });
});

describe("saved files", () => {
  it("says what was saved and its file name", () => {
    expect(savedNote("the cut list", "reading-bench-cut-list.csv")).toBe('Saved the cut list to your downloads as "reading-bench-cut-list.csv".');
  });
});
