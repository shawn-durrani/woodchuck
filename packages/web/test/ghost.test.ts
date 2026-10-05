// A suggested change drawn on the model itself: which parts it changes,
// how far each moves, the Now and With the change sides, and when the
// ghost shows and goes.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ChatItem } from "../src/api.js";
import {
  ghostOf,
  ghostShown,
  hideGhost,
  livePreview,
  MAX_MARKS,
  modelView,
  previewChange,
  seeIt,
  showGhost,
  signed,
  type PreviewResult,
} from "../src/ghost.js";
import { partNamer } from "../src/names.js";
import { readScene } from "../src/theme.js";
import type { Op } from "@woodchuck/core";
import { bench, stateOf } from "./bench.js";

const lowShelf = stateOf(bench());
const fits = (r: ReturnType<typeof previewChange>): PreviewResult => {
  if ("error" in r) throw new Error(r.error);
  return r;
};
const raise = fits(previewChange(lowShelf, [{ op: "set_param", name: "shelf_top", expr: "140", unit: "mm" }]));
const SHELF = ["rail_front_low", "shelf_slat", "shelf_slat#2", "shelf_slat#3", "shelf_slat#4"];

describe("which parts a suggested change changes", () => {
  it("raising the book shelf moves the slats and the low rail, and nothing else", () => {
    expect(raise.changed.sort()).toEqual([...SHELF].sort());
    expect(raise.added).toEqual([]);
    expect(raise.removed).toEqual([]);
    expect(raise.changes).toEqual(["Book shelf height from 100 to 140 mm"]);
  });

  it("lists the problems it brings and the ones it fixes", () => {
    expect(raise.newProblems).toEqual(["Under the front rail needs at least 240 mm above the shelf for books. (rule book_room)"]);
    expect(raise.fixes).toEqual([]);
    const high = stateOf(bench([{ op: "set_param", name: "shelf_top", expr: "140", unit: "mm" }]));
    const lower = fits(previewChange(high, [{ op: "set_param", name: "shelf_top", expr: "110", unit: "mm" }]));
    expect(lower.fixes).toEqual(["Under the front rail needs at least 240 mm above the shelf for books. (rule book_room)"]);
    expect(lower.newProblems).toEqual([]);
  });

  it("finds a new part and a part taken away", () => {
    const more = fits(
      previewChange(lowShelf, [
        {
          op: "add_panel",
          id: "rail_back_low",
          name: "Back low rail",
          material: "gum18",
          thickness_axis: "z",
          grain_axis: "x",
          x: { start: { face: "leg_bl.right" }, end: { face: "leg_br.left" } },
          y: { end: { at: "shelf_top - slat_t" }, size: "40" },
          z: { start: { at: "0" } },
        },
        { op: "delete_part", id: "seat" },
      ]),
    );
    expect(more.added).toEqual(["rail_back_low"]);
    expect(more.removed).toEqual(["seat"]);
    const ghost = ghostOf(lowShelf.derived.parts, more.after.parts);
    expect(ghost.parts).toEqual([{ id: "rail_back_low", box: more.after.parts.find((p) => p.id === "rail_back_low")!.nominal, added: true }]);
    expect(ghost.faded).toEqual(["seat"]);
    expect(ghost.marks).toEqual([]);
  });

  it("says when a change no longer fits the design", () => {
    expect(previewChange(lowShelf, [{ op: "delete_part", id: "no_such_part" }])).toEqual({ error: expect.stringContaining("no_such_part") });
  });

  it("knows a change of colour only shows in the Finished look", () => {
    const oil = fits(previewChange(lowShelf, [{ op: "set_finish", targets: ["material:gum18"], finish: "raw" }]));
    expect(oil.aboutFinish).toBe(true);
    expect(raise.aboutFinish).toBe(false);
  });
});

describe("the ghost's geometry", () => {
  const ghost = ghostOf(lowShelf.derived.parts, raise.after.parts, partNamer(lowShelf.derived.parts));

  it("draws each moved part at its new place, and fades it where it is", () => {
    expect(ghost.parts.map((g) => g.id).sort()).toEqual([...SHELF].sort());
    for (const g of ghost.parts) {
      expect(g.added).toBe(false);
      expect(g.box).toEqual(raise.after.parts.find((p) => p.id === g.id)!.nominal);
    }
    expect(ghost.faded.sort()).toEqual([...SHELF].sort());
  });

  it("dimensions the move once for the parts that move together, as +40 mm", () => {
    expect(ghost.marks).toHaveLength(1);
    const [m] = ghost.marks;
    expect(m).toMatchObject({ axis: 1, kind: "move", amount: 40, label: "+40 mm", words: "5 parts move up 40 mm" });
    expect(m!.parts.sort()).toEqual([...SHELF].sort());
    // The line runs up from the old bottom of the low rail to its new one.
    expect(m!.from[1]).toBeCloseTo(42);
    expect(m!.to[1]).toBeCloseTo(82);
    // It stands off to the right of the parts, at their front, with ticks across it.
    expect(m!.from[0]).toBeGreaterThan(1060);
    expect(m!.from[0]).toBe(m!.to[0]);
    expect(m!.from[2]).toBe(360);
    expect(m!.tick[0]).toBeGreaterThan(0);
    expect(m!.tick[1]).toBe(0);
  });

  it("dimensions a size change on the edge that moved, and a move along the length", () => {
    const longer = fits(previewChange(lowShelf, [{ op: "set_param", name: "bench_length", expr: "1300", unit: "mm" }]));
    const g = ghostOf(lowShelf.derived.parts, longer.after.parts, partNamer(longer.after.parts));
    const byKind = Object.fromEntries(g.marks.map((m) => [m.kind, m]));
    expect(byKind.size).toMatchObject({ axis: 0, amount: 200, label: "+200 mm", words: "3 parts grow 200 mm" });
    // The seat and both rails grow at their right-hand ends, the seat's from 1100 to 1300.
    expect(byKind.size!.parts.sort()).toEqual(["rail_front_low", "rail_front_top", "seat"]);
    expect(byKind.size!.from[0]).toBe(1100);
    expect(byKind.size!.to[0]).toBe(1300);
    expect(byKind.move).toMatchObject({ axis: 0, amount: 200, label: "+200 mm", words: "2 parts move right 200 mm" });
    // A move across stands above the parts.
    expect(byKind.move!.from[1]).toBeGreaterThan(422);
    expect(byKind.move!.tick[1]).toBeGreaterThan(0);
  });

  it("names a single part, and signs a move down with a minus", () => {
    const shorter = fits(previewChange(lowShelf, [{ op: "set_param", name: "rail_w", expr: "50", unit: "mm" }]));
    const [m] = ghostOf(lowShelf.derived.parts, shorter.after.parts, partNamer(shorter.after.parts)).marks;
    expect(m).toMatchObject({ kind: "size", amount: -10, label: "−10 mm", words: "Front top rail shrinks 10 mm" });
    expect(signed(12.5)).toBe("+12.5 mm");
    expect(signed(-3)).toBe("−3 mm");
  });

  it("keeps to a few dimensions however much changes", () => {
    const busy = fits(
      previewChange(lowShelf, [
        { op: "set_param", name: "bench_length", expr: "1300", unit: "mm" },
        { op: "set_param", name: "bench_depth", expr: "420", unit: "mm" },
        { op: "set_param", name: "seat_height", expr: "460", unit: "mm" },
        { op: "set_param", name: "shelf_top", expr: "120", unit: "mm" },
        { op: "set_param", name: "slat_gap", expr: "14", unit: "mm" },
      ]),
    );
    expect(ghostOf(lowShelf.derived.parts, busy.after.parts).marks.length).toBe(MAX_MARKS);
  });
});

describe("a change to a part's shape", () => {
  const grip = (x: string): Op => ({ op: "set_cutout", id: "seat", cut: "grip", shape: "rect", x: { start: { at: x }, size: "100" }, z: { start: { at: "150" }, size: "30" }, radius: "15" });

  it("counts a part whose cuts change as changed, though its box stays put", () => {
    const cut = fits(previewChange(lowShelf, [grip("500")]));
    expect(cut.changed).toEqual(["seat"]);
    const ghost = ghostOf(lowShelf.derived.parts, cut.after.parts);
    expect(ghost.parts).toEqual([{ id: "seat", box: lowShelf.derived.parts.find((p) => p.id === "seat")!.nominal, profile: cut.after.parts.find((p) => p.id === "seat")!.profile, added: false }]);
    expect(ghost.parts[0]!.profile!.holes).toHaveLength(1);
    expect(ghost.faded).toEqual(["seat"]);
    // Nothing moved, so there's no move to size.
    expect(ghost.marks).toEqual([]);
  });

  it("notices a hole moving, and a shape taken off", () => {
    const holed = stateOf(bench([grip("500")]));
    expect(fits(previewChange(holed, [grip("520")])).changed).toEqual(["seat"]);
    expect(fits(previewChange(holed, [{ op: "delete_cut", id: "seat", cut: "grip" }])).changed).toEqual(["seat"]);
    expect(fits(previewChange(holed, [grip("500")])).changed).toEqual([]);
  });
});

describe("Now and With the change", () => {
  it("Now draws the design as it is, with the ghost over it", () => {
    const now = modelView(lowShelf, raise, "now");
    expect(now.parts).toBe(lowShelf.derived.parts);
    expect(now.design).toBe(lowShelf.design);
    expect(now.ghost?.parts.map((g) => g.id).sort()).toEqual([...SHELF].sort());
    expect(now.outline).toEqual([]);
  });

  it("With the change draws the design as it would be, with the changed parts outlined and no ghost", () => {
    const after = modelView(lowShelf, raise, "after");
    expect(after.parts).toBe(raise.after.parts);
    expect(after.design).toBe(raise.proposed);
    expect(after.ghost).toBeNull();
    expect(after.outline.sort()).toEqual([...SHELF].sort());
    // Nothing's applied: the design the server holds is untouched.
    expect(lowShelf.design.params.find((p) => p.name === "shelf_top")!.expr).toBe("100");
  });

  it("with nothing to show, or a side put away, draws the design alone", () => {
    for (const v of [modelView(lowShelf, null, "now"), modelView(lowShelf, raise, null)]) {
      expect(v.parts).toBe(lowShelf.derived.parts);
      expect(v.ghost).toBeNull();
      expect(v.outline).toEqual([]);
    }
  });
});

describe("when the ghost shows and goes", () => {
  const preview = (status: "proposed" | "applied" | "not_applied", id = "v1"): ChatItem => ({
    id,
    kind: "preview",
    at: "2026-10-04T09:00:00Z",
    title: "Raise the book shelf",
    explanation: "Lifts the book shelf to 140 mm.",
    ops: [],
    status,
  });

  it("is the change Claude is waiting on, and goes while Claude works on the answer or once it's answered", () => {
    expect(livePreview({ chat: [preview("proposed")], waiting: ["preview"], busy: false })?.id).toBe("v1");
    // Apply or Not now: Claude is busy at once, so the ghost clears.
    expect(livePreview({ chat: [preview("proposed")], waiting: ["preview"], busy: true })).toBeNull();
    expect(livePreview({ chat: [preview("applied")], waiting: [], busy: false })).toBeNull();
    expect(livePreview({ chat: [preview("not_applied")], waiting: [], busy: false })).toBeNull();
    expect(livePreview({ chat: [], waiting: [], busy: false })).toBeNull();
  });

  it("a new change shows by itself, on Now", () => {
    expect(ghostShown("v1", null)).toEqual({ id: "v1", side: "now" });
    expect(ghostShown(null, { id: "v1", side: "after", hidden: false })).toBeNull();
    // A newer change starts over, whatever you did with the last one.
    expect(ghostShown("v2", { id: "v1", side: "after", hidden: true })).toEqual({ id: "v2", side: "now" });
  });

  it("See it flips to With the change and back", () => {
    const once = seeIt("v1", null);
    expect(ghostShown("v1", once)).toEqual({ id: "v1", side: "after" });
    expect(ghostShown("v1", seeIt("v1", once))).toEqual({ id: "v1", side: "now" });
  });

  it("Hide puts it away, and See it or Show brings it back", () => {
    const hidden = hideGhost("v1", seeIt("v1", null));
    expect(ghostShown("v1", hidden)).toBeNull();
    expect(ghostShown("v1", showGhost("v1", hidden))).toEqual({ id: "v1", side: "after" });
    expect(ghostShown("v1", seeIt("v1", hideGhost("v1", null)))).toEqual({ id: "v1", side: "after" });
    expect(ghostShown("v1", showGhost("v1", hidden, "now"))).toEqual({ id: "v1", side: "now" });
  });

  it("draws in a colour the themes set, and reads it from the page", () => {
    const themes = readFileSync(new URL("../src/themes.css", import.meta.url), "utf8");
    expect(themes).toMatch(/--wc-scene-ghost:\s*var\(--wc-scene-glow\);/);
    const style = { getPropertyValue: (n: string) => (n === "--wc-scene-ghost" ? " #d6336c" : "") };
    expect(readScene(style).ghost).toBe("#d6336c");
  });
});
