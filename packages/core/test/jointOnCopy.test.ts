// Issue #43: a joint can name one copy of an array, such as shelf#2, and then
// joins that copy alone. A joint on the original still repeats on every copy.
// The fixture is an invented bookcase in 18 mm ply: two 1200 mm sides 600 mm
// apart, and three shelves 250 mm apart, each housed into both sides. A
// drawer divider stands between the first shelf and the second. Its top is
// housed into the underside of shelf#2 alone, and its foot is pocket screwed
// into shelf#1, the original alone. Every size is made up.

import { describe, expect, it } from "vitest";
import {
  applyOp,
  applyOps,
  cutList,
  cutListCsv,
  derive,
  drillingList,
  emptyDesign,
  explainPart,
  OpError,
  recordConsoleOps,
  renderView,
  runChecks,
  toPlain,
  workshopDrawings,
  type Design,
  type Op,
  type Sheet,
} from "../src/index.js";

const side = (id: string, name: string, x: Record<string, unknown>): Op =>
  ({
    op: "add_panel",
    id,
    name,
    material: "ply18",
    thickness_axis: "x",
    grain_axis: "y",
    x,
    y: { start: { at: "0" }, size: "1200" },
    z: { start: { at: "0" }, size: "250" },
    tags: ["side"],
  }) as Op;

const bookcase: Op[] = [
  { op: "define_material", id: "ply18", name: "18 mm birch ply", kind: "sheet", thickness_mm: 18, grained: true },
  { op: "set_param", name: "width", expr: "600", unit: "mm" },
  { op: "set_param", name: "shelves", expr: "3", unit: "count" },
  side("left", "Left side", { start: { at: "0" } }),
  side("right", "Right side", { end: { at: "width" } }),
  {
    op: "add_panel",
    id: "shelf",
    name: "Shelf",
    material: "ply18",
    thickness_axis: "y",
    grain_axis: "x",
    x: { start: { face: "left.right" }, end: { face: "right.left" } },
    y: { start: { at: "250" } },
    z: { start: { at: "0" }, size: "250" },
    tags: ["shelf"],
  },
  { op: "set_array", id: "shelf_row", parts: ["shelf"], axis: "y", count: "shelves", pitch: "250" },
  {
    op: "add_panel",
    id: "divider",
    name: "Divider",
    material: "ply18",
    thickness_axis: "x",
    grain_axis: "y",
    x: { start: { at: "width / 2 - 9" } },
    y: { start: { face: "shelf.top" }, end: { face: "shelf#2.bottom" } },
    z: { start: { at: "0" }, size: "250" },
  },
  { op: "add_joint", id: "shelf_l", type: "dado", host: "left", guest: "shelf" },
  { op: "add_joint", id: "shelf_r", type: "dado", host: "right", guest: "shelf" },
  { op: "add_joint", id: "divider_top", type: "dado", host: "shelf#2", guest: "divider" },
  { op: "add_joint", id: "divider_foot", type: "pocket_screws", host: "shelf#1", guest: "divider" },
];

const build = (more: Op[] = []): Design => applyOps(emptyDesign("t"), [...bookcase, ...more]);
const labels = (d: ReturnType<typeof derive>, id: string) => d.byId.get(id)!.machining.map((m) => `${m.label} in the ${m.face} face for ${m.with}`);
const rows = (design: Design) =>
  cutList(design, derive(design)).rows.map((r) => ({ name: r.name, qty: r.qty, length_mm: r.length_mm, width_mm: r.width_mm, machining: r.machining, parts: r.parts }));
const problems = (design: Design) => runChecks(design, derive(design)).issues.map((i) => ({ severity: i.severity, code: i.code, message: i.message }));
const texts = (s: Sheet) => s.marks.flatMap((m) => (m.kind === "text" ? [m.text] : []));

const sides = [
  {
    name: "Left side",
    qty: 1,
    length_mm: 1200,
    width_mm: 250,
    machining: [250, 500, 750].map((y) => `dado 18 wide × 6 deep × 250 long in the right face for shelf at (12,${y},0)`),
    parts: ["left"],
  },
  {
    name: "Right side",
    qty: 1,
    length_mm: 1200,
    width_mm: 250,
    machining: [250, 500, 750].map((y) => `dado 18 wide × 6 deep × 250 long in the left face for shelf at (0,${y},0)`),
    parts: ["right"],
  },
];
const dividerRow = { name: "Divider", qty: 1, length_mm: 238, width_mm: 250, machining: ["2 pocket holes in the left face, screwing into shelf#1"], parts: ["divider"] };

describe("a joint on one copy of an array", () => {
  const design = build();
  const d = derive(design);

  it("houses the divider into shelf#2 alone, while the shelves' own dados repeat on every shelf", () => {
    expect(d.joints.map((j) => [j.id, j.host, j.guest, j.on_copy ?? false])).toEqual([
      ["shelf_l", "left", "shelf", false],
      ["shelf_l#2", "left", "shelf#2", false],
      ["shelf_l#3", "left", "shelf#3", false],
      ["shelf_r", "right", "shelf", false],
      ["shelf_r#2", "right", "shelf#2", false],
      ["shelf_r#3", "right", "shelf#3", false],
      // Named on a copy, each is placed once. shelf#1 is the original, called shelf.
      ["divider_top", "shelf#2", "divider", true],
      ["divider_foot", "shelf", "divider", true],
    ]);
    expect(labels(d, "shelf#2")).toEqual(["dado in the bottom face for divider"]);
    expect(labels(d, "shelf")).toEqual([]);
    expect(labels(d, "shelf#3")).toEqual([]);
    // The divider goes 6 mm into shelf#2, a third of its 18 mm.
    expect(d.byId.get("divider")!.extensions).toEqual([{ joint: "divider_top", host: "shelf#2", axis: "y", side: "end", depth_mm: 6 }]);
    expect(d.byId.get("divider")!.cut.length).toBe(238);
    // Every shelf still goes 6 mm into each side.
    for (const id of ["shelf", "shelf#2", "shelf#3"]) expect(d.byId.get(id)!.cut.length).toBe(576);
  });

  it("passes the checks, with the tongue in shelf#2 explained and the divider held up", () => {
    expect(problems(design)).toEqual([]);
    const top = d.joints.find((j) => j.id === "divider_top")!;
    expect(top.features.map((f) => [f.kind, f.part])).toEqual([
      ["tongue", "divider"],
      ["removed", "shelf#2"],
    ]);
  });

  it("refuses at the checks a copy the divider doesn't touch, like any other joint", () => {
    const wrong = applyOps(design, [
      { op: "delete_joint", id: "divider_top" },
      { op: "add_joint", id: "divider_top", type: "dado", host: "shelf#3", guest: "divider" },
    ]);
    expect(problems(wrong)).toEqual([
      {
        severity: "error",
        code: "joint_not_touching",
        message: "Joint divider_top: divider doesn't touch shelf#3, so the dado (housing) can't be placed. Position the guest against a face of the host first",
      },
    ]);
  });

  it("gives shelf#2 a row of its own on the cut list, named for the copy, with the dado in its notes", () => {
    expect(rows(design)).toEqual([
      ...sides,
      { name: "Shelf", qty: 2, length_mm: 576, width_mm: 250, machining: [], parts: ["shelf", "shelf#3"] },
      {
        name: "Shelf (shelf#2)",
        qty: 1,
        length_mm: 576,
        width_mm: 250,
        machining: ["dado 18 wide × 6 deep × 250 long in the bottom face for divider at (279,0,0)"],
        parts: ["shelf#2"],
      },
      dividerRow,
    ]);
    expect(cutListCsv(cutList(design, d))).toContain(
      '4,Shelf (shelf#2),1,18 mm birch ply,576,250,18,yes,"dado 18 wide × 6 deep × 250 long in the bottom face for divider at (279,0,0)",,shelf#2',
    );
  });

  it("draws shelf#2 on a sheet of its own, and drills the divider for shelf#1", () => {
    const sheets = workshopDrawings(design, d, { date: "6 October 2026" });
    expect(sheets.filter((s) => s.kind === "part").map((s) => s.title)).toEqual([
      "Part 1: Left side",
      "Part 2: Right side",
      "Part 3: Shelf",
      "Part 4: Shelf (shelf#2)",
      "Part 5: Divider",
    ]);
    const own = texts(sheets.find((s) => s.title === "Part 4: Shelf (shelf#2)")!);
    expect(own).toContain("Make 1");
    expect(own).toContain("Parts: shelf#2");
    expect(own.join("\n")).toMatch(/dado 18 wide × 6 deep × 250 long in the bottom face for divider\. At /);
    expect(texts(sheets.find((s) => s.title === "Part 3: Shelf")!).join("\n")).not.toMatch(/divider/);
    expect(drillingList(design, d).map((r) => [r.part, r.holes, r.with, r.count])).toEqual([["Divider", "pocket holes", "shelf#1", 2]]);
  });

  it("shows the housing in shelf#2 alone when you see through", () => {
    const red = (isolate: string[]) => (renderView("front", d, { xray: true, isolate }).svg.match(/fill="#e03131"/g) ?? []).length;
    expect(red(["shelf#2"])).toBe(1);
    expect(red(["shelf#3"])).toBe(0);
  });

  it("says which copy the divider goes into when it explains its length", () => {
    expect(explainPart(d, "divider")).toEqual(
      expect.arrayContaining([
        "Cut length 238 = visible 232 + 6 into shelf#2 (divider_top)",
        "2 pocket holes in the left face, screwing into shelf#1",
        "Joint divider_top: Dado (housing), divider into shelf#2. depth 6 (library default), fit 0 (library default)",
      ]),
    );
  });

  it("names the original alone as shelf#1 when its own joint sets it apart", () => {
    const housed = applyOps(design, [
      { op: "delete_joint", id: "divider_foot" },
      { op: "add_joint", id: "divider_foot", type: "dado", host: "shelf#1", guest: "divider" },
    ]);
    expect(rows(housed).filter((r) => r.name.startsWith("Shelf"))).toEqual([
      {
        name: "Shelf (shelf#1)",
        qty: 1,
        length_mm: 576,
        width_mm: 250,
        machining: ["dado 18 wide × 6 deep × 250 long in the top face for divider at (279,12,0)"],
        parts: ["shelf"],
      },
      {
        name: "Shelf (shelf#2)",
        qty: 1,
        length_mm: 576,
        width_mm: 250,
        machining: ["dado 18 wide × 6 deep × 250 long in the bottom face for divider at (279,0,0)"],
        parts: ["shelf#2"],
      },
      { name: "Shelf", qty: 1, length_mm: 576, width_mm: 250, machining: [], parts: ["shelf#3"] },
    ]);
    expect(derive(housed).byId.get("divider")!.cut.length).toBe(244);
    expect(problems(housed)).toEqual([]);
  });

  it("lengthens a copy named as the guest, which then gets a row of its own", () => {
    const backed = build([
      {
        op: "add_panel",
        id: "back",
        name: "Back",
        material: "ply18",
        thickness_axis: "z",
        grain_axis: "y",
        x: { start: { face: "left.right" }, end: { face: "right.left" } },
        y: { start: { at: "0" }, size: "1200" },
        z: { end: { face: "shelf.back" } },
      },
      { op: "add_joint", id: "fixed_shelf", type: "dado", host: "back", guest: "shelf#3" },
    ]);
    const r = derive(backed);
    expect(r.byId.get("shelf#3")!.cut.width).toBe(256);
    expect(labels(r, "back")).toEqual(["dado in the front face for shelf#3"]);
    expect(rows(backed).find((x) => x.parts.includes("shelf#3"))).toEqual({
      name: "Shelf (shelf#3)",
      qty: 1,
      length_mm: 576,
      width_mm: 256,
      machining: [],
      parts: ["shelf#3"],
    });
    expect(problems(backed)).toEqual([]);
  });

  it("leaves a design with no joint on a copy as it was", () => {
    const console = applyOps(emptyDesign("t"), recordConsoleOps());
    const r = derive(console);
    expect(JSON.stringify(toPlain(r))).not.toContain("on_copy");
    expect(cutList(console, r).rows.every((row) => !row.name.includes("("))).toBe(true);
  });
});

describe("a count change under a joint on one copy", () => {
  const design = build();

  it("keeps the joint on shelf#2 when the count goes up", () => {
    const four = applyOp(design, { op: "set_param", name: "shelves", expr: "4", unit: "count" });
    expect(derive(four).joints.find((j) => j.id === "divider_top")).toMatchObject({ host: "shelf#2", guest: "divider" });
    expect(rows(four).filter((r) => r.name.startsWith("Shelf")).map((r) => [r.name, r.qty, r.parts])).toEqual([
      ["Shelf", 3, ["shelf", "shelf#3", "shelf#4"]],
      ["Shelf (shelf#2)", 1, ["shelf#2"]],
    ]);
    expect(problems(four)).toEqual([]);
  });

  it("follows shelf#2 to a new pitch, with the divider's length", () => {
    const wider = applyOp(design, { op: "set_array", id: "shelf_row", parts: ["shelf"], axis: "y", count: "shelves", pitch: "300" });
    const r = derive(wider);
    expect(r.byId.get("shelf#2")!.nominal.min[1]).toBe(550);
    expect(labels(r, "shelf#2")).toEqual(["dado in the bottom face for divider"]);
    expect(r.byId.get("divider")!.cut.length).toBe(288);
    expect(problems(wider)).toEqual([]);
  });

  it("names the joint as an error once its copy is gone, and works again when it's back", () => {
    const one = applyOp(design, { op: "set_param", name: "shelves", expr: "1", unit: "count" });
    expect(problems(one)).toEqual([
      // The divider sits against shelf#2 too, so it loses its place as well.
      { severity: "error", code: "geometry_error", message: 'divider: "shelf#2" doesn\'t exist: array "shelf_row" has 1 items' },
      {
        severity: "error",
        code: "joint_copy_missing",
        message:
          "Joint divider_top names shelf#2, but array shelf_row has 1 item, so there's no shelf#2. It joins that one copy, so it can't be placed. Delete it, or add it again on a copy that's there",
      },
    ]);
    expect(cutList(one, derive(one)).excluded).toEqual([{ id: "divider", reason: "geometry error" }]);
    const back = applyOp(one, { op: "set_param", name: "shelves", expr: "3", unit: "count" });
    expect(toPlain(derive(back))).toEqual(toPlain(derive(design)));
  });

  it("names the joint as an error once the array is deleted", () => {
    const gone = applyOp(design, { op: "delete_array", id: "shelf_row" });
    expect(problems(gone).find((p) => p.code === "joint_copy_missing")).toEqual({
      severity: "error",
      code: "joint_copy_missing",
      message:
        "Joint divider_top names shelf#2, but shelf isn't in an array, so there's no shelf#2. It joins that one copy, so it can't be placed. Delete it, or add it again on a copy that's there",
    });
    // shelf#1 is the original, which stays.
    expect(derive(gone).joints.find((j) => j.id === "divider_foot")).toMatchObject({ host: "shelf", guest: "divider" });
  });
});

describe("add_joint on a copy", () => {
  const design = build();
  const refusal = (op: Partial<Extract<Op, { op: "add_joint" }>>) => {
    try {
      applyOp(design, { op: "add_joint", id: "extra", type: "dado", host: "shelf#2", guest: "divider", ...op });
    } catch (e) {
      expect(e).toBeInstanceOf(OpError);
      return (e as Error).message;
    }
    throw new Error("expected a refusal");
  };

  it("refuses a copy past the array's count", () => {
    expect(refusal({ host: "shelf#4" })).toBe(
      'host "shelf#4" doesn\'t exist: array shelf_row has 3 items, so its copies run from shelf#2 to shelf#3. Name shelf#1 for the original alone',
    );
  });

  it("refuses a copy of a part that isn't in an array, and a copy number it can't read", () => {
    expect(refusal({ guest: "divider#2" })).toBe('guest "divider#2" names a copy, but divider isn\'t in an array. Name divider itself');
    expect(refusal({ host: "shelf#0" })).toBe('host "shelf#0" isn\'t a part. Name a part, or one copy of an array, such as shelf#2');
    expect(refusal({ host: "shelf#two" })).toBe('host "shelf#two" isn\'t a part. Name a part, or one copy of an array, such as shelf#2');
    expect(refusal({ host: "cupboard#2" })).toBe('host "cupboard#2" isn\'t a part: there\'s no part "cupboard"');
  });

  it("refuses the original joined to itself as shelf#1", () => {
    expect(refusal({ host: "shelf#1", guest: "shelf" })).toBe("host and guest must be different parts");
  });

  it("changes nothing when the same joint on a copy is sent again", () => {
    expect(applyOp(design, bookcase.at(-2)!)).toBe(design);
  });
});

describe("deleting a part a joint names a copy of", () => {
  it("takes the joint with it", () => {
    const loose = applyOps(build(), [
      { op: "update_panel", id: "divider", y: { start: { at: "268" }, end: { at: "500" } } },
      { op: "delete_part", id: "shelf" },
    ]);
    expect(loose.joints).toEqual([]);
    expect(derive(loose).issues).toEqual([]);
  });
});
