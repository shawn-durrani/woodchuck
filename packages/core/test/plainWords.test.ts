// Errors, problems and changes in words a woodworker reads, which still say
// exactly what's wrong for Claude.

import { describe, expect, it } from "vitest";
import {
  applyOp,
  applyOps,
  cutList,
  cutListCsv,
  derive,
  diffDesigns,
  emptyDesign,
  machiningText,
  paramLabel,
  paramShortLabel,
  runChecks,
  workshopDrawings,
  type Design,
  type Op,
} from "../src/index.js";

const ops: Op[] = [
  { op: "set_param", name: "top_length", expr: "400", unit: "mm", note: "length of the top (to the ends)" },
  { op: "set_param", name: "shelf_top", expr: "120", unit: "mm", note: "Low shelf height" },
  { op: "define_material", id: "pine19", name: "19 mm pine", kind: "solid", thickness_mm: 19, grained: true },
  {
    op: "add_panel",
    id: "top",
    name: "Top",
    material: "pine19",
    thickness_axis: "y",
    grain_axis: "x",
    x: { start: { at: "0" }, end: { at: "top_length" } },
    y: { start: { at: "300" } },
    z: { start: { at: "0" }, size: "200" },
  },
  {
    op: "add_panel",
    id: "side",
    name: "Side",
    material: "pine19",
    thickness_axis: "x",
    grain_axis: "y",
    x: { start: { at: "0" } },
    y: { start: { at: "0" }, end: { face: "top.bottom" } },
    z: { start: { at: "0" }, size: "200" },
  },
];

const build = (extra: Op[] = []): Design => applyOps(emptyDesign("Stool"), [...ops, ...extra]);
const errorOf = (d: Design, op: Op) => {
  try {
    applyOp(d, op);
  } catch (e) {
    return (e as Error).message;
  }
  return null;
};

describe("machining, counted properly", () => {
  const withScrews = (count: number) => build([{ op: "add_joint", id: "s", type: "screws", host: "top", guest: "side", count }]);

  it("says 1 screw hole, and 2 screw holes", () => {
    for (const [count, text] of [
      [1, "1 screw hole,"],
      [2, "2 screw holes,"],
    ] as const) {
      const d = derive(withScrews(count));
      const top = d.byId.get("top")!;
      expect(machiningText(top.machining[0]!)).toMatch(new RegExp(`^${text}`));
    }
  });

  it("uses the same words in the cut list, its CSV and the workshop drawings", () => {
    const design = withScrews(1);
    const d = derive(design);
    const list = cutList(design, d);
    expect(list.rows.find((r) => r.name === "Top")!.machining[0]).toMatch(/^1 screw hole, 4 mm, through the top face for side/);
    expect(cutListCsv(list)).toContain("1 screw hole, 4 mm");
    expect(cutListCsv(list)).not.toContain("1 screw holes");
    const notes = workshopDrawings(design, d, { date: "4 October 2026" }).flatMap((s) => s.marks.flatMap((m) => (m.kind === "text" ? [m.text] : [])));
    expect(notes.join("\n")).toContain("1 screw hole, 4 mm");
    expect(notes.join("\n")).not.toContain("1 screw holes");
  });

  it("counts pocket holes, dowel holes and box joint slots the same way", () => {
    const pockets = derive(build([{ op: "add_joint", id: "p", type: "pocket_screws", host: "top", guest: "side", count: 1 }]));
    expect(machiningText(pockets.byId.get("side")!.machining[0]!)).toMatch(/^1 pocket hole in/);
    const dowels = derive(build([{ op: "add_joint", id: "d", type: "dowels", host: "top", guest: "side", count: 3 }]));
    expect(machiningText(dowels.byId.get("top")!.machining[0]!)).toMatch(/^3 dowel holes,/);
  });
});

describe("errors a person can act on", () => {
  const d = build();

  it("says there's no size by that name, and how to get one", () => {
    const message = errorOf(d, { op: "update_panel", id: "top", x: { start: { at: "0" }, end: { at: "toplength" } } });
    expect(message).toBe('There\'s no size called "toplength" in top.x.end. Pick one from Sizes, or ask Claude to add it as a parameter.');
    expect(message).not.toMatch(/set_param/);
  });

  it("offers the size it probably meant", () => {
    const message = errorOf(d, { op: "update_panel", id: "top", x: { start: { at: "0" }, end: { at: "length" } } });
    expect(message).toBe('There\'s no size called "length" in top.x.end. Did you mean top_length?');
  });

  it("names a missing part and where it was used", () => {
    expect(errorOf(d, { op: "update_panel", id: "top", x: { start: { at: "0" }, end: { at: "shelf.right" } } })).toBe(
      'There\'s no part called "shelf" for top.x.end, which uses shelf.right. Check the name, or add the part first.',
    );
    expect(errorOf(d, { op: "update_panel", id: "side", y: { start: { at: "0" }, end: { face: "shelf.bottom" } } })).toBe(
      'There\'s no part called "shelf" for side.y.end, which sits against shelf.bottom. Check the name, or add the part first.',
    );
  });

  it("quotes a value it can't read", () => {
    expect(errorOf(d, { op: "update_panel", id: "top", x: { start: { at: "0" }, end: { at: "400 +" } } })).toBe(
      'Couldn\'t read "400 +" for top.x.end: expression ends too early',
    );
  });

  it("says which of start, end and size to clear", () => {
    expect(errorOf(d, { op: "update_panel", id: "top", x: { start: { at: "0" }, end: { at: "400" }, size: "400" } })).toBe(
      "top.x needs two of start, end and size, but it has 3. Clear one of them.",
    );
  });

  it("still reports which operation in a batch failed, for Claude", () => {
    expect(() => applyOps(d, [{ op: "set_param", name: "a", expr: "1", unit: "mm" }, { op: "set_param", name: "b", expr: "nope", unit: "mm" }])).toThrow(
      /^Operation 2 \(set_param\): There's no size called "nope" in parameter b\./,
    );
  });
});

describe("problems, plain words first", () => {
  it("puts a rule's own message before its id, and keeps the working apart", () => {
    const d = build([{ op: "set_rule", id: "basket_room", expr: "top.bottom - shelf_top >= 200", severity: "error", message: "Leave room for a basket under the top." }]);
    const issue = runChecks(d, derive(d)).issues.find((i) => i.code === "rule_failed")!;
    expect(issue.message).toBe("Leave room for a basket under the top. (rule basket_room)");
    expect(issue.trace).toBe("top.bottom (300) - shelf_top (120) >= 200");
  });
});

describe("what changed, by name", () => {
  const before = build();

  it("names a size by its note, not its id", () => {
    const after = applyOp(before, { op: "set_param", name: "shelf_top", expr: "160", unit: "mm" });
    expect(diffDesigns(before, after, { names: true })).toEqual(["Low shelf height from 120 to 160 mm"]);
    // Claude still reads ids.
    expect(diffDesigns(before, after)).toEqual(["Changed shelf_top from 120 to 160"]);
  });

  it("names parts, joints and finishes by name", () => {
    const after = applyOps(before, [
      { op: "add_joint", id: "s", type: "screws", host: "top", guest: "side" },
      { op: "set_finish", targets: ["top.top", "side"], finish: "raw" },
      { op: "update_panel", id: "side", z: { start: { at: "10" }, size: "190" } },
    ]);
    expect(diffDesigns(before, after, { names: true })).toEqual([
      "Changed Side: its size or place",
      "Added a joint: screws, Side into Top",
      expect.stringMatching(/^Finished the top face of Top, Side with /),
    ]);
  });

  it("shortens a long note to its first words", () => {
    expect(paramLabel({ name: "rung_t", note: "rung thickness (matches 22 mm stock)" })).toBe("Rung thickness (matches 22 mm stock)");
    expect(paramShortLabel({ name: "rung_t", note: "rung thickness (matches 22 mm stock)" })).toBe("Rung thickness");
    expect(paramShortLabel({ name: "tray_depth", note: "Tray depth, sets the runner length" })).toBe("Tray depth");
    expect(paramLabel({ name: "top_depth" })).toBe("Top depth");
  });
});
