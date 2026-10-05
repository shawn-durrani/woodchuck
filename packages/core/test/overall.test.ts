// Issue #56: a rule can read the whole piece. overall.width, overall.height
// and overall.depth are the box around every part, back, feet and top
// included, so "300 deep" holds the whole piece and not just its sides. The
// fixture is an invented hall cabinet in 18 mm ply, 600 mm wide, with sides
// 700 mm tall and 300 mm deep on two 100 mm plinth runners. A 6 mm back is
// fixed on behind the sides, and a 20 mm top overhangs each side by 10 mm.
// Every size is made up.

import { describe, expect, it } from "vitest";
import { applyOps, checkKeySizes, derive, emptyDesign, explain, OpError, runChecks, type Design, type Op } from "../src/index.js";

const side = (id: string, x: Record<string, unknown>): Op => ({
  op: "add_panel",
  id,
  name: id === "side_l" ? "Left side" : "Right side",
  material: "ply18",
  thickness_axis: "x",
  grain_axis: "y",
  x,
  y: { start: { face: "runner_l.top" }, size: "700" },
  z: { start: { at: "0" }, size: "side_depth" },
});

const runner = (id: string, x: Record<string, unknown>, name = "Plinth runner"): Op => ({
  op: "add_panel",
  id,
  name,
  material: "pine45",
  thickness_axis: "x",
  grain_axis: "z",
  x,
  y: { start: { at: "0" }, size: "100" },
  z: { start: { at: "20" }, size: "260" },
});

const cabinet: Op[] = [
  { op: "define_material", id: "ply18", name: "18 mm birch ply", kind: "sheet", thickness_mm: 18, grained: true },
  { op: "define_material", id: "ply6", name: "6 mm ply", kind: "sheet", thickness_mm: 6, grained: true },
  { op: "define_material", id: "oak20", name: "20 mm oak", kind: "solid", thickness_mm: 20, grained: true },
  { op: "define_material", id: "pine45", name: "45 mm pine", kind: "solid", thickness_mm: 45, grained: true },
  { op: "set_param", name: "side_depth", expr: "300", unit: "mm" },
  runner("runner_l", { start: { at: "30" } }),
  runner("runner_r", { end: { at: "570" } }),
  side("side_l", { start: { at: "0" } }),
  side("side_r", { end: { at: "600" } }),
  {
    op: "add_panel",
    id: "bottom",
    name: "Bottom",
    material: "ply18",
    thickness_axis: "y",
    grain_axis: "x",
    x: { start: { face: "side_l.right" }, end: { face: "side_r.left" } },
    y: { start: { face: "side_l.bottom" } },
    z: { start: { at: "0" }, size: "side_depth" },
  },
  {
    op: "add_panel",
    id: "back",
    name: "Back",
    material: "ply6",
    thickness_axis: "z",
    grain_axis: "y",
    x: { start: { face: "side_l.left" }, end: { face: "side_r.right" } },
    y: { start: { face: "side_l.bottom" }, end: { face: "side_l.top" } },
    z: { end: { face: "side_l.back" } },
  },
  {
    op: "add_panel",
    id: "top",
    name: "Top",
    material: "oak20",
    thickness_axis: "y",
    grain_axis: "x",
    x: { start: { face: "side_l.left", offset: "-10" }, end: { face: "side_r.right", offset: "10" } },
    y: { start: { face: "side_l.top" } },
    z: { start: { face: "side_l.back" }, end: { face: "side_l.front" } },
  },
  // A prop on the top, and a handle that stands out in front. Neither is part of the piece's size.
  {
    op: "add_panel",
    id: "vase",
    name: "Vase",
    material: "oak20",
    thickness_axis: "z",
    grain_axis: "y",
    x: { start: { at: "250" }, size: "100" },
    y: { start: { face: "top.top" }, size: "250" },
    z: { start: { at: "140" } },
    decor: true,
  },
  {
    op: "set_hardware",
    id: "handle",
    kind: "handle",
    name: "Bar handle",
    connects: ["bottom"],
    qty: 1,
    shape: [{ name: "bar", min_mm: [0, 0, 0], max_mm: [120, 12, 30] }],
    place: { x: "240", y: "650", z: "300" },
  },
];

const build = (extra: Op[] = []): Design => applyOps(emptyDesign("Hall cabinet"), [...cabinet, ...extra]);
const value = (d: Design, expr: string) => derive(d).evaluate(expr).value;

const depthRule: Op = { op: "set_rule", id: "depth_300", expr: "overall.depth == 300", severity: "error", message: "The cabinet is 300 mm deep overall, back included" };

describe("the whole piece in an expression", () => {
  it("is the box around every part, back, feet and top included", () => {
    const d = build();
    // The top overhangs each side by 10 mm.
    expect(value(d, "overall.width")).toBe(620);
    expect(value(d, "overall.left")).toBe(-10);
    expect(value(d, "overall.right")).toBe(610);
    // The runners lift the sides 100 mm, and the top sits on them.
    expect(value(d, "overall.height")).toBe(820);
    expect(value(d, "overall.bottom")).toBe(0);
    expect(value(d, "overall.top")).toBe(820);
    // The back sits behind the 300 mm sides, so the piece is 306 deep.
    expect(value(d, "overall.depth")).toBe(306);
    expect(value(d, "overall.back")).toBe(-6);
    expect(value(d, "overall.front")).toBe(300);
    expect(value(d, "overall.size_x")).toBe(620);
    expect(value(d, "overall.size_y")).toBe(820);
    expect(value(d, "overall.size_z")).toBe(306);
    // The vase on top and the handle in front aren't the piece.
    expect(derive(d).overall).toEqual({
      box: { min: [-10, 0, -6], max: [610, 820, 300] },
      ends: { x: ["top", "top"], y: ["runner_l", "top"], z: ["back", "side_l"] },
    });
  });

  it("counts a stand-in box, which takes the place of a real part", () => {
    const d = build([{ op: "add_unverified_box", id: "crest", name: "Carved crest", min_mm: [200, 820, 0], max_mm: [400, 880, 20], reason: "A carved crest the tools can't make yet" }]);
    expect(value(d, "overall.height")).toBe(880);
  });

  it("can't be worked out with no parts, or while a part's size can't be", () => {
    expect(() => derive(emptyDesign("Empty")).evaluate("overall.depth")).toThrow("overall.depth can't be worked out, since there are no parts yet");
    const broken = build([{ op: "set_param", name: "side_depth", expr: "300 / (back.thickness - 6)", unit: "mm" }]);
    expect(() => derive(broken).evaluate("overall.depth")).toThrow(/overall.depth can't be worked out, since side_l's size couldn't be worked out/);
  });

  it("is for rules alone, since it's worked out after every size", () => {
    const d = build();
    expect(() => applyOps(d, [{ op: "set_param", name: "deep", expr: "overall.depth - 6", unit: "mm" }])).toThrow(
      "parameter deep can't use overall.depth. It measures the whole piece, which is worked out after every size, so only a rule or a plan's key size can use it",
    );
    expect(() => applyOps(d, [{ op: "update_panel", id: "back", z: { end: { at: "overall.back" } } }])).toThrow(/can't use overall.back/);
    expect(() => applyOps(d, [{ op: "set_rule", id: "long", expr: "overall.length <= 700", severity: "error", message: "Fits the hall" }])).toThrow(
      '"overall.length" in rule long isn\'t something the whole piece has. Use overall.width, overall.height, overall.depth or a face such as overall.top',
    );
    expect(() => derive(d).evaluate("overall.thickness")).toThrow(/isn't something the whole piece has/);
    // Nothing that sets a size can read it, even a design file written by hand.
    const byHand = { ...d, params: [...d.params, { name: "deep", expr: "overall.depth", unit: "mm" as const }] };
    expect(derive(byHand).params.deep).toEqual({ error: "overall.depth measures the whole piece, which is worked out after every size, so only a rule or a plan's key size can use it" });
  });

  it("keeps the name overall for the whole piece", () => {
    const panel = runner("overall", { start: { at: "200" } }, "Middle runner");
    expect(() => applyOps(build(), [panel])).toThrow(OpError);
    expect(() => applyOps(build(), [panel])).toThrow('Part id "overall" is kept for the whole piece');
    expect(() => applyOps(build(), [{ op: "add_unverified_box", id: "overall", name: "Box", min_mm: [0, 0, 0], max_mm: [1, 1, 1], reason: "test" }])).toThrow(
      'Part id "overall" is kept for the whole piece',
    );
  });
});

describe("a rule on the overall depth", () => {
  it("fails while the back sits behind 300 mm sides, and names the part at each end", () => {
    const d = build([depthRule]);
    const issue = runChecks(d, derive(d)).issues.find((i) => i.code === "rule_failed");
    expect(issue).toMatchObject({
      severity: "error",
      message: "The cabinet is 300 mm deep overall, back included (rule depth_300)",
      parts: [],
      trace: "overall.depth (306) == 300, where overall.depth runs from back.back (-6) to side_l.front (300)",
    });
    expect(explain(d, derive(d), "depth_300")).toEqual([
      "depth_300: overall.depth == 300",
      "  = overall.depth (306) == 300",
      "  → fails",
      "  overall.depth runs from back.back (-6) to side_l.front (300)",
    ]);
  });

  it("passes once the sides give up the back's thickness", () => {
    const d = build([depthRule, { op: "set_param", name: "side_depth", expr: "300 - back.thickness", unit: "mm" }]);
    expect(value(d, "side_l.size_z")).toBe(294);
    expect(value(d, "overall.depth")).toBe(300);
    expect(runChecks(d, derive(d)).issues.filter((i) => i.code.startsWith("rule_"))).toEqual([]);
  });

  it("doesn't stop a part being deleted, since it reads no part by name", () => {
    const d = applyOps(build([depthRule]), [{ op: "delete_part", id: "back" }]);
    expect(value(d, "overall.depth")).toBe(300);
    expect(runChecks(d, derive(d)).issues.filter((i) => i.code.startsWith("rule_"))).toEqual([]);
  });

  it("works out as a plan's key size, and explains itself", () => {
    const d = derive(build());
    expect(checkKeySizes([{ label: "Depth overall, back included", expr: "overall.depth", expected_mm: 300 }], d)).toEqual([
      {
        label: "Depth overall, back included",
        expr: "overall.depth",
        expected_mm: 300,
        tolerance_mm: 0.5,
        ok: false,
        model_mm: 306,
        working: "overall.depth (306)",
      },
    ]);
    expect(explain(build(), d, "overall.height - top.thickness")).toEqual([
      "overall.height - top.thickness",
      "  = overall.height (820) - top.thickness (20)",
      "  = 800",
      "  overall.height runs from runner_l.bottom (0) to top.top (820)",
    ]);
  });
});
