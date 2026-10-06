// Issue #46: drawers without slides run on wooden runners, which are timber
// on the cut list, and hardware is only what you buy. The design is an
// invented bedside cabinet for Mateo: 450 wide, 520 tall and 360 deep, too
// shallow for 450 mm slides, with two drawers on 12 × 20 mm oak runners.
// Every size is made up.

import { describe, expect, it } from "vitest";
import { applyOp, applyOps, cutList, cutListCsv, derive, emptyDesign, OpError, runChecks, type Design, type Op } from "../src/index.js";

const side = (id: string, name: string, x: Record<string, unknown>): Op =>
  ({ op: "add_panel", id, name, material: "ply18", thickness_axis: "x", grain_axis: "y", x, y: { start: { at: "0" }, size: "height" }, z: { start: { at: "0" }, size: "depth" }, tags: ["carcass"] }) as Op;
const across = (id: string, name: string, y: Record<string, unknown>): Op =>
  ({ op: "add_panel", id, name, material: "ply18", thickness_axis: "y", grain_axis: "x", x: { start: { face: "side_l.right" }, end: { face: "side_r.left" } }, y, z: { start: { at: "0" }, size: "depth" }, tags: ["carcass"] }) as Op;
/** A drawer box part between the drawer sides, as high as they are. */
const end = (id: string, name: string, z: Record<string, unknown>): Op =>
  ({ op: "add_panel", id, name, material: "ply12", thickness_axis: "z", grain_axis: "x", x: { start: { face: "dside_l.right" }, end: { face: "dside_r.left" } }, y: { start: { face: "dside_l.bottom" }, end: { face: "dside_l.top" } }, z, tags: ["drawer"] }) as Op;

const carcass: Op[] = [
  { op: "rename_design", name: "Bedside cabinet" },
  { op: "set_param", name: "width", expr: "450", unit: "mm" },
  { op: "set_param", name: "height", expr: "520", unit: "mm" },
  { op: "set_param", name: "depth", expr: "360", unit: "mm" },
  { op: "set_param", name: "run_gap", expr: "1", unit: "mm", note: "Running clearance each side of a drawer" },
  { op: "set_param", name: "drawer_height", expr: "200", unit: "mm" },
  { op: "set_param", name: "head_room", expr: "10", unit: "mm", note: "From a drawer's top to the runners over it" },
  { op: "define_material", id: "ply18", name: "18 mm birch ply", kind: "sheet", thickness_mm: 18, grained: true },
  { op: "define_material", id: "ply12", name: "12 mm birch ply", kind: "sheet", thickness_mm: 12, grained: true },
  { op: "define_material", id: "ply6", name: "6 mm ply", kind: "sheet", thickness_mm: 6, grained: true },
  { op: "define_material", id: "oak12", name: "12 mm oak strip", kind: "solid", thickness_mm: 12, grained: true, species: "tasmanian_oak" },
  side("side_l", "Left side", { start: { at: "0" } }),
  side("side_r", "Right side", { end: { at: "width" } }),
  across("bottom", "Bottom", { start: { at: "0" } }),
  across("top", "Top", { end: { at: "height" } }),
  { op: "add_joint", id: "bottom_l", type: "screws", host: "side_l", guest: "bottom" },
  { op: "add_joint", id: "bottom_r", type: "screws", host: "side_r", guest: "bottom" },
  { op: "add_joint", id: "top_l", type: "screws", host: "side_l", guest: "top" },
  { op: "add_joint", id: "top_r", type: "screws", host: "side_r", guest: "top" },
];

/** A strip on each carcass side, 20 mm tall, and the drawer sides resting on their tops. */
const onRunners: Op[] = [
  { op: "add_panel", id: "runner_l", name: "Runner", material: "oak12", thickness_axis: "x", grain_axis: "z", x: { start: { face: "side_l.right" } }, y: { start: { face: "bottom.top", offset: "30" }, size: "20" }, z: { start: { at: "0" }, size: "depth" }, tags: ["runner"] },
  { op: "add_panel", id: "runner_r", name: "Runner", material: "oak12", thickness_axis: "x", grain_axis: "z", x: { end: { face: "side_r.left" } }, y: { start: { face: "runner_l.bottom" }, size: "20" }, z: { start: { at: "0" }, size: "depth" }, tags: ["runner"] },
  { op: "add_joint", id: "runner_l_fix", type: "screws", host: "runner_l", guest: "side_l", length: "28" },
  { op: "add_joint", id: "runner_r_fix", type: "screws", host: "runner_r", guest: "side_r", length: "28" },
  { op: "add_panel", id: "dside_l", name: "Drawer side", material: "ply12", thickness_axis: "x", grain_axis: "z", x: { start: { face: "side_l.right", offset: "run_gap" } }, y: { start: { face: "runner_l.top" }, size: "drawer_height" }, z: { start: { at: "10" }, end: { face: "side_l.front" } }, tags: ["drawer"] },
  { op: "add_panel", id: "dside_r", name: "Drawer side", material: "ply12", thickness_axis: "x", grain_axis: "z", x: { end: { face: "side_r.left", offset: "-run_gap" } }, y: { start: { face: "dside_l.bottom" }, end: { face: "dside_l.top" } }, z: { start: { face: "dside_l.back" }, end: { face: "dside_l.front" } }, tags: ["drawer"] },
];

const box: Op[] = [
  end("dfront", "Drawer front", { end: { face: "dside_l.front" } }),
  end("dback", "Drawer back", { start: { face: "dside_l.back" } }),
  { op: "add_panel", id: "dbottom", name: "Drawer bottom", material: "ply6", thickness_axis: "y", grain_axis: "z", x: { start: { face: "dside_l.right" }, end: { face: "dside_r.left" } }, y: { start: { face: "dside_l.bottom", offset: "10" } }, z: { start: { face: "dback.front" }, end: { face: "dfront.back" } }, tags: ["drawer"] },
  { op: "add_joint", id: "front_l", type: "screws", host: "dside_l", guest: "dfront" },
  { op: "add_joint", id: "front_r", type: "screws", host: "dside_r", guest: "dfront" },
  { op: "add_joint", id: "back_l", type: "screws", host: "dside_l", guest: "dback" },
  { op: "add_joint", id: "back_r", type: "screws", host: "dside_r", guest: "dback" },
  { op: "add_joint", id: "bottom_in_l", type: "groove", host: "dside_l", guest: "dbottom" },
  { op: "add_joint", id: "bottom_in_r", type: "groove", host: "dside_r", guest: "dbottom" },
];

const drawers = (parts: string[]): Op => ({ op: "set_array", id: "drawers", parts, axis: "y", count: "2", pitch: "runner_l.size_y + drawer_height + head_room" });
const DRAWER = ["runner_l", "runner_r", "dside_l", "dside_r", "dfront", "dback", "dbottom"];

const cabinet = (): Design => applyOps(emptyDesign("test"), [...carcass, ...onRunners, ...box, drawers(DRAWER)]);
const problems = (d: Design) => runChecks(d, derive(d)).issues.map((i) => ({ severity: i.severity, code: i.code, message: i.message }));
const withParam = (d: Design, name: string, expr: string) => applyOp(d, { op: "set_param", name, expr, unit: "mm" });

describe("a drawer on wooden runners", () => {
  it("is timber on the cut list, with nothing on the hardware list and a note to wax the runners", () => {
    const d = cabinet();
    const r = derive(d);
    expect(runChecks(d, r)).toMatchObject({ issues: [], ready_to_cut: true });
    const list = cutList(d, r);
    const runners = list.rows.filter((row) => row.name === "Runner");
    expect(runners.map((row) => ({ row: row.row, qty: row.qty, size: [row.length_mm, row.width_mm, row.thickness_mm], material: row.material_name, parts: row.parts }))).toEqual([
      { row: 1, qty: 2, size: [360, 20, 12], material: "12 mm oak strip", parts: ["runner_l", "runner_l#2"] },
      { row: 2, qty: 2, size: [360, 20, 12], material: "12 mm oak strip", parts: ["runner_r", "runner_r#2"] },
    ]);
    expect(runners[0]!.machining).toEqual(["2 screw holes, 4 mm, through the right face for side_l"]);
    expect(list.hardware).toEqual([]);
    expect(list.notes).toEqual(["Wax the runners in rows 1 and 2, and the drawer edges or grooves that run on them, so the drawers slide freely."]);
    expect(cutListCsv(list).endsWith('\nNotes\n"Wax the runners in rows 1 and 2, and the drawer edges or grooves that run on them, so the drawers slide freely."\n')).toBe(true);
  });

  it("is held up by the runners it rests on, with no joint to them", () => {
    const r = derive(cabinet());
    const side = r.byId.get("dside_l#2")!;
    const runner = r.byId.get("runner_l#2")!;
    expect(side.box.min[1]).toBe(runner.box.max[1]);
    expect(side.box.min[0] - r.byId.get("side_l")!.box.max[0]).toBe(1);
  });

  it("can't slide with no running clearance beside it", () => {
    expect(problems(withParam(cabinet(), "run_gap", "0"))).toEqual(
      ["dside_l", "dside_r", "dside_l#2", "dside_r#2"].map((id) => ({
        severity: "error",
        code: "runner_clearance",
        message: `${id} touches ${id.startsWith("dside_l") ? "side_l" : "side_r"} beside it, so the drawer on ${id.endsWith("#2") ? "runner_l#2 and runner_r#2" : "runner_l and runner_r"} can't slide. Leave 0.5 to 1 mm running clearance`,
      })),
    );
  });

  it("binds when the running clearance is under 0.5 mm, and runs from 0.5 mm", () => {
    const tight = problems(withParam(cabinet(), "run_gap", "0.3"));
    expect(tight).toHaveLength(4);
    expect(tight[0]).toEqual({
      severity: "warning",
      code: "runner_clearance",
      message: "dside_l has 0.3 mm running clearance to side_l beside it, so the drawer on runner_l and runner_r will bind when the timber swells. Leave 0.5 to 1 mm",
    });
    expect(problems(withParam(cabinet(), "run_gap", "0.5"))).toEqual([]);
  });

  it("needs room over it, under the next drawer's runners", () => {
    expect(problems(withParam(cabinet(), "head_room", "0"))).toEqual([
      { severity: "error", code: "runner_clearance", message: "dside_l touches runner_l#2 over it, so the drawer on runner_l and runner_r can't slide. Leave 0.5 to 1 mm running clearance" },
      { severity: "error", code: "runner_clearance", message: "dside_r touches runner_r#2 over it, so the drawer on runner_l and runner_r can't slide. Leave 0.5 to 1 mm running clearance" },
    ]);
  });

  it("can't slide on a runner it's screwed to", () => {
    const screwed = applyOp(cabinet(), { op: "add_joint", id: "stuck", type: "screws", host: "runner_l", guest: "dside_l", length: "20" });
    expect(problems(screwed).filter((p) => p.code === "runner_fixed")).toEqual([
      { severity: "error", code: "runner_fixed", message: "dside_l is joined to runner runner_l by stuck, so it can't slide on it. A drawer rests on its runner with no joint, so take the joint off" },
      { severity: "error", code: "runner_fixed", message: "dside_l#2 is joined to runner runner_l#2 by stuck#2, so it can't slide on it. A drawer rests on its runner with no joint, so take the joint off" },
    ]);
  });

  it("says when nothing slides on a runner", () => {
    // The right side follows the left, so both drawers lift 2 mm off their runners.
    const lifted = applyOp(cabinet(), { op: "update_panel", id: "dside_l", y: { start: { face: "runner_l.top", offset: "2" }, size: "drawer_height" } });
    expect(problems(lifted).filter((p) => p.code === "runner_idle").map((p) => p.message)).toEqual(
      ["runner_l", "runner_l#2", "runner_r", "runner_r#2"].map((id) => `Nothing slides on runner ${id}. Rest a drawer side's bottom edge on its top, or hold the runner in a groove in the drawer side`),
    );
  });
});

/** A thinner strip laid flat, held in a groove in the drawer side's outside face. */
const inGrooves = (fit: string): Op[] => [
  { op: "add_panel", id: "dside_l", name: "Drawer side", material: "ply12", thickness_axis: "x", grain_axis: "z", x: { start: { face: "side_l.right", offset: "run_gap" } }, y: { start: { face: "bottom.top", offset: "20" }, size: "drawer_height" }, z: { start: { at: "10" }, end: { face: "side_l.front" } }, tags: ["drawer"] },
  { op: "add_panel", id: "dside_r", name: "Drawer side", material: "ply12", thickness_axis: "x", grain_axis: "z", x: { end: { face: "side_r.left", offset: "-run_gap" } }, y: { start: { face: "dside_l.bottom" }, end: { face: "dside_l.top" } }, z: { start: { face: "dside_l.back" }, end: { face: "dside_l.front" } }, tags: ["drawer"] },
  { op: "add_panel", id: "runner_l", name: "Runner", material: "oak12", thickness_axis: "y", grain_axis: "z", x: { start: { face: "side_l.right" }, end: { face: "dside_l.left" } }, y: { start: { face: "dside_l.bottom", offset: "90" } }, z: { start: { at: "0" }, size: "depth" }, tags: ["runner"] },
  { op: "add_panel", id: "runner_r", name: "Runner", material: "oak12", thickness_axis: "y", grain_axis: "z", x: { start: { face: "dside_r.right" }, end: { face: "side_r.left" } }, y: { start: { face: "runner_l.bottom" } }, z: { start: { at: "0" }, size: "depth" }, tags: ["runner"] },
  { op: "add_joint", id: "runner_l_fix", type: "screws", host: "runner_l", guest: "side_l", length: "28" },
  { op: "add_joint", id: "runner_r_fix", type: "screws", host: "runner_r", guest: "side_r", length: "28" },
  { op: "add_joint", id: "runs_l", type: "groove", host: "dside_l", guest: "runner_l", depth: "4", fit },
  { op: "add_joint", id: "runs_r", type: "groove", host: "dside_r", guest: "runner_r", depth: "4", fit },
];
const grooved = (fit: string) =>
  applyOps(emptyDesign("test"), [...carcass, ...inGrooves(fit), ...box, { ...(drawers(DRAWER) as Extract<Op, { op: "set_array" }>), pitch: "drawer_height + 30" }]);

describe("a drawer riding its runners in grooves", () => {
  it("is cut with a groove 1 mm wider than the runner, and runs", () => {
    const d = grooved("1");
    const r = derive(d);
    expect(runChecks(d, r).issues).toEqual([]);
    const list = cutList(d, r);
    const left = list.rows.find((row) => row.parts.includes("dside_l"))!;
    expect(left.machining).toContain("groove 13 wide × 4 deep × 350 long in the left face for runner_l at (0,89.5,0)");
    expect(list.rows.filter((row) => row.name === "Runner").map((row) => [row.length_mm, row.width_mm, row.thickness_mm])).toEqual([
      [360, 5, 12],
      [360, 5, 12],
    ]);
    expect(list.hardware).toEqual([]);
  });

  it("binds in a groove that fits the runner tight", () => {
    expect(problems(grooved("0")).map((p) => p.message)).toEqual([
      "The groove for runner runner_l in dside_l (runs_l) is only 0 mm wider than the runner, so the drawer will bind. Give it a fit of 0.5 to 1 mm",
      "The groove for runner runner_l#2 in dside_l#2 (runs_l#2) is only 0 mm wider than the runner, so the drawer will bind. Give it a fit of 0.5 to 1 mm",
      "The groove for runner runner_r in dside_r (runs_r) is only 0 mm wider than the runner, so the drawer will bind. Give it a fit of 0.5 to 1 mm",
      "The groove for runner runner_r#2 in dside_r#2 (runs_r#2) is only 0 mm wider than the runner, so the drawer will bind. Give it a fit of 0.5 to 1 mm",
    ]);
  });
});

describe("a drawer running on a shelf", () => {
  it("counts the shelf as its runner, and leaves a partition fixed on it alone", () => {
    const d = applyOps(emptyDesign("test"), [
      ...carcass.filter((o) => o.op !== "rename_design"),
      { op: "update_panel", id: "bottom", tags: ["carcass", "runner"] },
      { op: "add_panel", id: "dside_l", name: "Drawer side", material: "ply12", thickness_axis: "x", grain_axis: "z", x: { start: { face: "side_l.right", offset: "run_gap" } }, y: { start: { face: "bottom.top" }, size: "drawer_height" }, z: { start: { at: "10" }, end: { face: "side_l.front" } }, tags: ["drawer"] },
      { op: "add_panel", id: "dside_r", name: "Drawer side", material: "ply12", thickness_axis: "x", grain_axis: "z", x: { start: { face: "dside_l.right", offset: "300" } }, y: { start: { face: "dside_l.bottom" }, end: { face: "dside_l.top" } }, z: { start: { face: "dside_l.back" }, end: { face: "dside_l.front" } }, tags: ["drawer"] },
      ...box,
      { op: "add_panel", id: "partition", name: "Partition", material: "ply18", thickness_axis: "x", grain_axis: "y", x: { start: { face: "dside_r.right", offset: "run_gap" } }, y: { start: { face: "bottom.top" }, end: { face: "top.bottom" } }, z: { start: { at: "0" }, size: "depth" }, tags: ["carcass"] },
      { op: "add_joint", id: "partition_in_bottom", type: "dado", host: "bottom", guest: "partition" },
    ]);
    const r = derive(d);
    expect(runChecks(d, r).issues).toEqual([]);
    expect(cutList(d, r).notes).toEqual(["Wax the runners in row 7, and the drawer edges or grooves that run on them, so the drawers slide freely."]);
    expect(problems(applyOp(d, { op: "set_param", name: "run_gap", expr: "0", unit: "mm" })).map((p) => p.message)).toEqual([
      "dside_l touches side_l beside it, so the drawer on bottom can't slide. Leave 0.5 to 1 mm running clearance",
      "dside_r touches partition beside it, so the drawer on bottom can't slide. Leave 0.5 to 1 mm running clearance",
    ]);
  });
});

describe("hardware", () => {
  const glides: Op = { op: "set_hardware", id: "glides", kind: "drawer_slide", name: "Drawer wax glides", connects: ["dside_l", "side_l"], qty: 2 };

  it("refuses a placeholder with nothing to buy, and says to make runners as timber", () => {
    const refused = () => applyOp(cabinet(), glides);
    expect(refused).toThrow(OpError);
    expect(refused).toThrow(
      'Drawer wax glides (glides) names nothing to buy: it has no library_part and no spec. Hardware is only what you buy, so give library_part, or the maker\'s figures in spec, such as {"length_mm": 450}. ' +
        "Wooden runners and glides are timber: add each with add_panel, tagged runner, and the drawer slides on it with no hardware",
    );
    expect(() => applyOp(cabinet(), { ...glides, spec: {} })).toThrow(/names nothing to buy/);
  });

  it("takes a part from the library, or one with the maker's figures", () => {
    const listed = applyOp(cabinet(), { ...glides, name: "Nylon drawer glide", kind: "glide", connects: ["side_l"], spec: { length_mm: 30 } });
    expect(cutList(listed, derive(listed)).hardware).toEqual([{ name: "Nylon drawer glide", kind: "glide", qty: 2, spec: "length_mm 30", ids: ["glides"] }]);
    expect(() => applyOp(cabinet(), { ...glides, library_part: "acmeco-glide-450" })).not.toThrow();
  });

  it("flags a placeholder a design already holds, and says what to do", () => {
    const held: Design = { ...cabinet(), hardware: [{ id: "glides", kind: "drawer_slide", name: "Drawer wax glides", connects: ["dside_l", "side_l"], qty: 2 }] };
    expect(problems(held)).toEqual([
      {
        severity: "warning",
        code: "hardware_nothing_to_buy",
        message:
          "Drawer wax glides (glides) is on the hardware list with nothing to buy: no library part and no maker's figures. Give it library_part or spec. Wooden runners and glides are timber, so delete it and add each runner as a part tagged runner",
      },
    ]);
  });
});
