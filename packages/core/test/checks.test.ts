import { describe, expect, it } from "vitest";
import {
  applyOps,
  cutLayout,
  cutList,
  derive,
  emptyDesign,
  measure,
  OpError,
  renderSheet,
  runChecks,
  verifyPlan,
  type Design,
  type Op,
} from "../src/index.js";

const base: Op[] = [
  { op: "define_material", id: "ply18", name: "18 mm ply", kind: "sheet", thickness_mm: 18, grained: true, sheet_sizes_mm: [[2440, 1220]] },
  {
    op: "add_panel",
    id: "left",
    name: "Left",
    material: "ply18",
    thickness_axis: "x",
    grain_axis: "y",
    x: { start: { at: "0" } },
    y: { start: { at: "0" }, size: "600" },
    z: { start: { at: "0" }, size: "300" },
  },
  {
    op: "add_panel",
    id: "right",
    name: "Right",
    material: "ply18",
    thickness_axis: "x",
    grain_axis: "y",
    x: { start: { at: "500" } },
    y: { start: { at: "0" }, size: "600" },
    z: { start: { at: "0" }, size: "300" },
  },
  {
    op: "add_panel",
    id: "shelf",
    name: "Shelf",
    material: "ply18",
    thickness_axis: "y",
    grain_axis: "x",
    x: { start: { face: "left.right" }, end: { face: "right.left" } },
    y: { start: { at: "300" } },
    z: { start: { at: "0" }, size: "300" },
  },
];

const build = (extra: Op[] = []): Design => applyOps(emptyDesign("t"), [...base, ...extra]);
const codes = (d: Design) => runChecks(d, derive(d)).issues.map((i) => i.code);

describe("operations", () => {
  it("rejects a bound on the wrong axis and says which faces fit", () => {
    expect(() =>
      build([{ op: "update_panel", id: "shelf", x: { start: { face: "left.top" }, end: { face: "right.left" } } }]),
    ).toThrow(/x axis, so its face must be left or right/);
  });

  it("rejects a size on the thickness axis", () => {
    expect(() => build([{ op: "update_panel", id: "shelf", y: { start: { at: "300" }, size: "18" } }])).toThrow(/thickness axis/);
  });

  it("rejects names that don't exist yet", () => {
    expect(() => build([{ op: "set_param", name: "w", expr: "widht * 2", unit: "mm" }])).toThrow(OpError);
  });

  it("won't delete a part other parts depend on", () => {
    expect(() => build([{ op: "delete_part", id: "left" }])).toThrow(/still used by part shelf/);
  });

  it("lets a part position itself by its own thickness", () => {
    const d = build([{ op: "update_panel", id: "shelf", y: { end: { at: "300 + shelf.thickness" } } }]);
    expect(derive(d).byId.get("shelf")!.nominal.min[1]).toBe(300);
  });

  it("clears the whole design in one step", () => {
    const d = build([{ op: "clear_design" }]);
    expect(d.parts).toEqual([]);
    expect(d.materials).toEqual([]);
    expect(d.name).toBe("t");
  });

  it("reports which operation in a batch failed", () => {
    expect(() =>
      applyOps(emptyDesign("t"), [
        { op: "set_param", name: "a", expr: "1", unit: "mm" },
        { op: "set_param", name: "b", expr: "nope", unit: "mm" },
      ]),
    ).toThrow(/Operation 2 \(set_param\)/);
  });
});

describe("checks", () => {
  it("is clean for a simple shelf unit", () => {
    expect(codes(build())).toEqual([]);
  });

  it("finds circular references", () => {
    const d = build([
      { op: "set_param", name: "a", expr: "10", unit: "mm" },
      { op: "set_param", name: "b", expr: "a + 1", unit: "mm" },
      { op: "set_param", name: "a", expr: "b + 1", unit: "mm" },
    ]);
    const issues = runChecks(d, derive(d)).issues;
    expect(issues.some((i) => /Circular reference/.test(i.message))).toBe(true);
  });

  it("flags overlaps no joint explains", () => {
    const d = build([{ op: "update_panel", id: "shelf", x: { start: { at: "10" }, end: { face: "right.left" } } }]);
    expect(codes(d)).toContain("overlap");
  });

  it("accepts the overlap a housing joint makes", () => {
    const d = build([
      { op: "add_joint", id: "s_l", type: "dado", host: "left", guest: "shelf", depth: "6" },
      { op: "add_joint", id: "s_r", type: "dado", host: "right", guest: "shelf", depth: "6" },
    ]);
    expect(codes(d)).toEqual([]);
    expect(derive(d).byId.get("shelf")!.cut.length).toBe(482 + 12);
  });

  it("warns about deep housings and refuses ones past half the thickness", () => {
    const issues = (depth: string) => {
      const d = build([{ op: "add_joint", id: "j", type: "dado", host: "left", guest: "shelf", depth }]);
      return runChecks(d, derive(d)).issues.filter((i) => i.code === "joint_check");
    };
    expect(issues("8")).toMatchObject([{ severity: "warning", message: expect.stringMatching(/usual limit/) }]);
    expect(issues("10")).toMatchObject([{ severity: "error", message: expect.stringMatching(/half the thickness/) }]);
  });

  it("says when a joint's parts don't touch", () => {
    const d = build([
      { op: "update_panel", id: "shelf", x: { start: { face: "left.right", offset: "5" }, end: { face: "right.left" } } },
      { op: "add_joint", id: "j", type: "dado", host: "left", guest: "shelf", depth: "6" },
    ]);
    expect(codes(d)).toContain("joint_not_touching");
  });

  it("finds parts nothing holds up", () => {
    const d = build([
      {
        op: "add_panel",
        id: "loose",
        name: "Loose",
        material: "ply18",
        thickness_axis: "y",
        grain_axis: "x",
        x: { start: { at: "100" }, size: "100" },
        y: { start: { at: "700" } },
        z: { start: { at: "0" }, size: "100" },
      },
    ]);
    expect(runChecks(d, derive(d)).issues.find((i) => i.code === "floating")?.parts).toEqual(["loose"]);
  });

  it("flags parts bigger than any sheet", () => {
    const d = build([{ op: "update_panel", id: "right", x: { start: { at: "3000" } } }]);
    expect(codes(d)).toContain("stock_too_small");
  });

  it("blocks cutting while an unverified part remains", () => {
    const d = build([{ op: "add_unverified_box", id: "pull", name: "Finger pull", min_mm: [200, 280, 300], max_mm: [300, 300, 310], reason: "No tool for routed pulls yet" }]);
    const report = runChecks(d, derive(d));
    expect(report.issues.map((i) => i.code)).toContain("unverified_present");
    expect(report.ready_to_cut).toBe(false);
  });
});

describe("queries", () => {
  it("measures between faces on one axis", () => {
    const d = derive(build());
    expect(measure(d, "left.right", "right.left").mm).toBe(482);
    expect(() => measure(d, "left.right", "shelf.top")).toThrow(/same axis/);
  });

  it("checks the model against its plan", () => {
    const d = build([
      {
        op: "set_plan",
        plan: {
          status: "proposed",
          summary: "A shelf unit",
          parts: [{ label: "Sides", qty: 2, tag: "side" }],
          key_dims: [{ label: "Shelf span", expr: "right.left - left.right", expected_mm: 482 }],
          joints: [],
          assumptions: [],
        },
      },
    ]);
    const checks = verifyPlan(d, derive(d));
    expect(checks.map((c) => c.ok)).toEqual([false, true]);
  });

  it("draws every view with part labels", () => {
    const sheet = renderSheet(["front", "top", "left", "iso"], derive(build()), { labels: true });
    expect(sheet.svg).toContain(">shelf<");
    expect(sheet.svg).toContain("Isometric");
    expect(sheet.width).toBe(1120);
  });
});

describe("the too-big check follows the stock you set", () => {
  /** A flat part whose length runs along x, the grain. */
  const flat = (id: string, material: string, length: number, width: number, at = 0): Op => ({
    op: "add_panel",
    id,
    name: id,
    material,
    thickness_axis: "z",
    grain_axis: "x",
    x: { start: { at: String(at) }, size: String(length) },
    y: { start: { at: "0" }, size: String(width) },
    z: { start: { at: "0" } },
  });
  const wood: Op[] = [
    { op: "define_material", id: "ply", name: "18 mm ply", kind: "sheet", thickness_mm: 18, grained: true },
    { op: "define_material", id: "mdf", name: "16 mm MDF", kind: "sheet", thickness_mm: 16, grained: false },
    { op: "define_material", id: "oak", name: "30 mm oak", kind: "solid", thickness_mm: 30, grained: true },
  ];
  const make = (ops: Op[]): Design => applyOps(emptyDesign("Fairhaven bench"), [...wood, ...ops]);
  const tooBig = (d: Design) => runChecks(d, derive(d)).issues.filter((i) => i.code === "stock_too_small");
  const flagged = (d: Design) => tooBig(d).flatMap((i) => i.parts).sort();

  it("flags a part that fits the default stock but not a smaller sheet you set", () => {
    const parts = [flat("rail", "ply", 600, 300), flat("top", "ply", 482, 300, 1000)];
    expect(flagged(make(parts))).toEqual([]);
    const small = make([...parts, { op: "set_stock", material: "ply", sheet_mm: [550, 400] }]);
    expect(flagged(small)).toEqual(["rail"]);
    expect(tooBig(small)[0]!.message).toBe(
      "rail (600 × 300 mm) doesn't fit a 550 × 400 mm 18 mm ply sheet inside its 10 mm trim with the grain running along its length",
    );
  });

  it("stops flagging a part once you set a sheet it fits", () => {
    const parts = [flat("rail", "ply", 3000, 300)];
    expect(flagged(make(parts))).toEqual(["rail"]);
    expect(flagged(make([...parts, { op: "set_stock", material: "ply", sheet_mm: [3200, 1220] }]))).toEqual([]);
    // The material's own listed sheet is what the layout buys when the design says nothing.
    const listed: Op = { op: "define_material", id: "ply", name: "18 mm ply", kind: "sheet", thickness_mm: 18, grained: true, sheet_sizes_mm: [[3050, 1525]] };
    expect(flagged(make([listed, ...parts]))).toEqual([]);
  });

  it("keeps the trim inside the sheet, like the layout does", () => {
    const parts = [flat("rail", "ply", 2395, 300)];
    expect(flagged(make(parts))).toEqual(["rail"]);
    expect(flagged(make([...parts, { op: "set_stock", trim_mm: 0 }]))).toEqual([]);
    expect(flagged(make([...parts, { op: "set_stock", trim_mm: 2 }]))).toEqual([]);
  });

  it("turns a part across the sheet only when the material has no grain", () => {
    // 1170 along the grain and 2300 across: only a turned part fits a 1180 wide sheet.
    const parts = [flat("top_mdf", "mdf", 1170, 2300), flat("top_ply", "ply", 1170, 2300, 5000)];
    expect(flagged(make(parts))).toEqual(["top_ply"]);
    expect(flagged(make([...parts, { op: "set_stock", material: "mdf", sheet_mm: [1200, 2400] }, { op: "set_stock", material: "ply", sheet_mm: [1200, 2400] }]))).toEqual([]);
    expect(flagged(make([...parts, { op: "set_stock", material: "mdf", sheet_mm: [1000, 2400] }]))).toEqual(["top_mdf", "top_ply"]);
  });

  it("flags a solid part longer than the longest stock length", () => {
    const parts = [flat("rail", "oak", 3500, 90), flat("beam", "oak", 3700, 90, 5000)];
    expect(flagged(make(parts))).toEqual(["beam"]);
    expect(tooBig(make(parts))[0]!.message).toBe(
      "beam is 3700 mm long, but the longest 30 mm oak length is 3600 mm. Join two lengths, or add a longer stock length",
    );
    const short = make([...parts, { op: "set_stock", material: "oak", lengths_mm: [2400, 3000] }]);
    expect(flagged(short)).toEqual(["beam", "rail"]);
    expect(tooBig(short)[0]!.message).toContain("the longest 30 mm oak length is 3000 mm");
    expect(flagged(make([...parts, { op: "set_stock", material: "oak", lengths_mm: [4000] }]))).toEqual([]);
  });

  it("lets stock lengths you set go past the material's longest board", () => {
    const capped: Op = { op: "define_material", id: "oak", name: "30 mm oak", kind: "solid", thickness_mm: 30, grained: true, board_max_length_mm: 2000 };
    const parts = [flat("rail", "oak", 2500, 90)];
    expect(flagged(make([capped, ...parts]))).toEqual(["rail"]);
    expect(flagged(make([capped, ...parts, { op: "set_stock", material: "oak", lengths_mm: [3000] }]))).toEqual([]);
  });

  it("still asks for a glue-up when a solid part is wider than the board", () => {
    const wide: Op = { op: "define_material", id: "oak", name: "30 mm oak", kind: "solid", thickness_mm: 30, grained: true, board_max_width_mm: 250 };
    const d = make([wide, flat("top", "oak", 1200, 600)]);
    expect(tooBig(d).map((i) => i.message)).toEqual(["top is 600 mm wide, but the widest 30 mm oak board is 250 mm. It needs a glue-up"]);
  });

  it("flags the parts the cutting layout can't place, and no others", () => {
    const parts = [
      flat("short_ply", "ply", 900, 400),
      flat("long_ply", "ply", 2390, 400, 5000),
      flat("turned_mdf", "mdf", 1100, 2350, 10000),
      flat("big_mdf", "mdf", 2600, 1300, 15000),
      flat("short_oak", "oak", 1800, 90, 20000),
      flat("long_oak", "oak", 3300, 90, 25000),
    ];
    const settings: Op[][] = [
      [],
      [{ op: "set_stock", material: "ply", sheet_mm: [2440, 1220] }],
      [{ op: "set_stock", material: "ply", sheet_mm: [1200, 600] }, { op: "set_stock", material: "mdf", sheet_mm: [2800, 1400] }],
      [{ op: "set_stock", trim_mm: 0 }],
      [{ op: "set_stock", trim_mm: 40 }, { op: "set_stock", material: "oak", lengths_mm: [2400, 3000] }],
      [{ op: "set_stock", material: "oak", lengths_mm: [3300] }],
    ];
    for (const extra of settings) {
      const d = make([...parts, ...extra]);
      const unplaced = cutLayout(d, cutList(d, derive(d))).materials.flatMap((m) => m.unplaced.map((u) => u.part));
      expect(flagged(d)).toEqual(unplaced.sort());
    }
  });
});
