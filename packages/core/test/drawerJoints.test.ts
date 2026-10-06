// Issue #45: a drawer box built the way a woodworker builds one. Its bottom
// sits in grooves in the sides and the front and slides in under a back cut
// above it, its corners are rabbeted, and a dado and rabbet can hold a front
// that takes a pull. The box is invented: 400 wide, 450 deep and 120 tall in
// 12 mm ply, with a 6 mm ply bottom 10 mm up.

import { describe, expect, it } from "vitest";
import {
  applyOp,
  applyOps,
  cutList,
  derive,
  emptyDesign,
  finishSchedule,
  jointExample,
  OpError,
  runChecks,
  workshopDrawings,
  type Design,
  type Op,
} from "../src/index.js";

const ply = (id: string, t: number): Op => ({ op: "define_material", id, name: `${t} mm ply`, kind: "sheet", thickness_mm: t, grained: true, species: "birch_ply" });

/** The back stops on the bottom so the bottom slides in, or runs full height with the bottom in a groove in it too. */
type Back = "above" | "grooved";

function box(back: Back = "above", joints: Op[] = DEFAULT_JOINTS(back)): Design {
  const ops: Op[] = [
    ply("ply12", 12),
    ply("ply6", 6),
    { op: "set_param", name: "bottom_up", expr: "10", unit: "mm", note: "From the sides' bottom edge to the groove" },
    { op: "add_panel", id: "front", name: "Box front", material: "ply12", thickness_axis: "z", grain_axis: "x", x: { start: { at: "0" }, size: "400" }, y: { start: { at: "0" }, size: "120" }, z: { end: { at: "450" } } },
    { op: "add_panel", id: "back", name: "Box back", material: "ply12", thickness_axis: "z", grain_axis: "x", x: { start: { at: "0" }, size: "400" }, y: { start: { at: "0" }, end: { at: "120" } }, z: { start: { at: "0" } } },
    ...(["side_l", "side_r"] as const).map(
      (id, i): Op => ({
        op: "add_panel",
        id,
        name: "Side",
        material: "ply12",
        thickness_axis: "x",
        grain_axis: "z",
        x: i ? { end: { at: "400" } } : { start: { at: "0" } },
        y: { start: { at: "0" }, size: "120" },
        z: { start: { face: "back.front" }, end: { face: "front.back" } },
      }),
    ),
    {
      op: "add_panel",
      id: "bottom",
      name: "Bottom",
      material: "ply6",
      thickness_axis: "y",
      grain_axis: "z",
      x: { start: { face: "side_l.right" }, end: { face: "side_r.left" } },
      y: { start: { face: "side_l.bottom", offset: "bottom_up" } },
      z: { start: { face: back === "above" ? "back.back" : "back.front" }, end: { face: "front.back" } },
    },
    ...(back === "above" ? [{ op: "update_panel", id: "back", y: { start: { face: "bottom.top" }, end: { at: "120" } } } as Op] : []),
    ...joints,
  ];
  return applyOps(emptyDesign("Invented drawer box"), ops);
}

function DEFAULT_JOINTS(back: Back): Op[] {
  return [
    ...["front", "back"].flatMap((host) =>
      ["side_l", "side_r"].map((guest): Op => ({ op: "add_joint", id: `${guest}_in_${host}`, type: "rabbet", host, guest, depth: "6" })),
    ),
    ...["side_l", "side_r", "front", ...(back === "grooved" ? ["back"] : [])].map(
      (host): Op => ({ op: "add_joint", id: `bottom_in_${host}`, type: "groove", host, guest: "bottom", depth: "6" }),
    ),
    ...(back === "above" ? [{ op: "add_joint", id: "bottom_to_back", type: "screws", host: "bottom", guest: "back", count: 2 } as Op] : []),
  ];
}

const problems = (d: Design) => runChecks(d, derive(d)).issues.map((i) => `${i.severity}: ${i.message}`);
const rows = (d: Design) => cutList(d, derive(d)).rows.map((r) => [r.name, r.qty, r.length_mm, r.width_mm, r.thickness_mm, r.machining]);
/** The box with one joint swapped for another. */
const swap = (id: string, joint: Op, back: Back = "above") => box(back, [...DEFAULT_JOINTS(back).filter((j) => j.op !== "add_joint" || j.id !== id), joint]);

describe("an invented drawer box with its bottom in grooves", () => {
  it("grows the bottom into each groove, slides it under the back, and checks clean", () => {
    const d = box();
    expect(problems(d)).toEqual([]);
    expect(rows(d)).toEqual([
      ["Side", 1, 438, 120, 12, ["groove 6 wide × 6 deep × 438 long in the right face for bottom at (6,10,0)"]],
      ["Side", 1, 438, 120, 12, ["groove 6 wide × 6 deep × 438 long in the left face for bottom at (0,10,0)"]],
      [
        "Box front",
        1,
        400,
        120,
        12,
        [
          "groove 6 wide × 6 deep × 388 long in the back face for bottom at (6,10,0)",
          "rabbet 12 wide × 6 deep × 120 long in the back face for side_l at (0,0,0)",
          "rabbet 12 wide × 6 deep × 120 long in the back face for side_r at (388,0,0)",
        ],
      ],
      [
        "Box back",
        1,
        400,
        104,
        12,
        ["rabbet 12 wide × 6 deep × 104 long in the front face for side_l at (0,0,6)", "rabbet 12 wide × 6 deep × 104 long in the front face for side_r at (388,0,6)"],
      ],
      ["Bottom", 1, 444, 388, 6, ["2 screw holes, 4 mm, through the bottom face for back"]],
    ]);
    const r = derive(d);
    // The bottom is 376 between the sides and 438 from the back's back face to the front, plus 6 into each groove.
    expect(r.byId.get("bottom")!.extensions.map((e) => [e.host, e.axis, e.side, e.depth_mm])).toEqual([
      ["side_l", "x", "start", 6],
      ["side_r", "x", "end", 6],
      ["front", "z", "end", 6],
    ]);
    // The sides' grooves run out of their back ends, under the back, so the bottom slides in from behind.
    const groove = r.byId.get("side_l")!.machining[0]!;
    expect(groove.region).toEqual({ min: [6, 10, 6], max: [12, 16, 444] });
    expect(r.byId.get("side_l")!.box).toEqual({ min: [0, 0, 6], max: [12, 120, 444] });
    expect(r.byId.get("back")!.nominal.min[1]).toBe(16);
    expect(r.joints.map((j) => [j.id, j.params.depth, j.problems.length])).toEqual([
      ["side_l_in_front", 6, 0],
      ["side_r_in_front", 6, 0],
      ["side_l_in_back", 6, 0],
      ["side_r_in_back", 6, 0],
      ["bottom_in_side_l", 6, 0],
      ["bottom_in_side_r", 6, 0],
      ["bottom_in_front", 6, 0],
      ["bottom_to_back", undefined, 0],
    ]);
  });

  it("grows the bottom on all four edges when the back has a groove too", () => {
    const d = box("grooved");
    expect(problems(d)).toEqual([]);
    const r = derive(d);
    expect(r.byId.get("bottom")!.cut).toEqual({ length: 438, width: 388, thickness: 6 });
    expect(r.byId.get("back")!.cut).toEqual({ length: 400, width: 120, thickness: 12 });
    expect(rows(d).find((x) => x[0] === "Box back")![5]).toContain("groove 6 wide × 6 deep × 388 long in the front face for bottom at (6,10,6)");
  });

  it("dimensions each groove and rabbet on the workshop drawings", () => {
    const d = box();
    const sheets = workshopDrawings(d, derive(d), { date: "6 October 2026" });
    const sheet = (title: string) => sheets.find((s) => s.title === title)!;
    const notes = (title: string) => sheet(title).marks.flatMap((m) => (m.kind === "text" && /^(groove|rabbet)/.test(m.text) ? [m.text] : []));
    // The side: the groove is 10 up and 6 wide, and runs its whole length.
    expect(sheet("Part 1: Side").dims).toContainEqual({ view: "face", along: "width", kind: "chain", values_mm: [10, 6, 104] });
    expect(notes("Part 1: Side")).toEqual(["groove 6 wide × 6 deep × 438 long in the right face for bottom. At 0 along, 10 up."]);
    // The front: a rabbet as wide as each side at each end, and the groove between them. It's turned over, so the groove is 10 from its top on the sheet.
    expect(sheet("Part 3: Box front").dims).toContainEqual({ view: "face", along: "length", kind: "chain", values_mm: [6, 6, 376, 6, 6] });
    expect(sheet("Part 3: Box front").dims).toContainEqual({ view: "face", along: "width", kind: "chain", values_mm: [104, 6, 10] });
    expect(notes("Part 3: Box front")).toEqual([
      "rabbet 12 wide × 6 deep × 120 long in the back face for side_l. At 0 along, 0 up.",
      "rabbet 12 wide × 6 deep × 120 long in the back face for side_r. At 388 along, 0 up.",
      "groove 6 wide × 6 deep × 388 long in the back face for bottom. At 6 along, 104 up.",
    ]);
  });

  it("leaves the finish areas as the parts' boxes give them", () => {
    const finish: Op = { op: "set_finish", targets: ["material:ply12", "material:ply6"], finish: "natur" };
    const joined = applyOp(box(), finish);
    const bare = applyOp(box("above", []), finish);
    expect(finishSchedule(joined, derive(joined).parts)).toEqual(finishSchedule(bare, derive(bare).parts));
    // Five boxes' faces: two sides, the front, the back above the bottom, and the bottom.
    const faces = (l: number, w: number, t: number) => 2 * (l * w + l * t + w * t);
    const m2 = (2 * faces(426, 120, 12) + faces(400, 120, 12) + faces(400, 104, 12) + faces(438, 376, 6)) / 1e6;
    expect(finishSchedule(joined, derive(joined).parts)[0]!.area_m2).toBe(Math.round(m2 * 100) / 100);
  });
});

describe("the groove's checks", () => {
  const groove = (more: Record<string, string>): Op => ({ op: "add_joint", id: "bottom_in_side_l", type: "groove", host: "side_l", guest: "bottom", depth: "6", ...more });

  it("let a groove go to half the side's thickness, and warn past it", () => {
    expect(problems(swap("bottom_in_side_l", groove({ depth: "7" })))).toEqual([
      "warning: bottom_in_side_l (groove joining bottom to side_l): The groove is 7 mm deep in 12 mm of material, which leaves 5 mm behind it. Half the thickness (6 mm) is the usual limit",
    ]);
  });

  it("refuse a groove deeper than two thirds of the side", () => {
    expect(problems(swap("bottom_in_side_l", groove({ depth: "9" })))).toEqual([
      "error: bottom_in_side_l (groove joining bottom to side_l): The groove is 9 mm deep in 12 mm of material, which leaves 3 mm behind it. Keep it to half the thickness or less",
    ]);
  });

  it("warn when the groove sits too near the side's edge", () => {
    const d = applyOp(box(), { op: "set_param", name: "bottom_up", expr: "4", unit: "mm" });
    const strip = (host: string) =>
      `warning: bottom_in_${host} (groove joining bottom to ${host}): The groove is 4 mm from the host's edge, and a strip that thin breaks off. Set the panel at least 6 mm in, or about 10 mm for a drawer bottom`;
    expect(problems(d)).toEqual([strip("side_l"), strip("side_r"), strip("front")]);
  });

  it("say nothing of a groove run out of the edge, which is cut the way a rabbet is", () => {
    expect(problems(applyOp(box(), { op: "set_param", name: "bottom_up", expr: "0", unit: "mm" }))).toEqual([]);
  });

  it("refuse a panel thicker than the groove the cutter makes, and cut the groove that wide", () => {
    const d = swap("bottom_in_side_l", groove({ width: "5.5" }));
    expect(problems(d)).toEqual([
      "error: bottom_in_side_l (groove joining bottom to side_l): The groove is 5.5 mm wide and the panel 6 mm thick, so the panel won't go in. Cut the groove 6 mm wide, or thin the panel's edge to fit with a tongue joint",
    ]);
    expect(derive(d).byId.get("side_l")!.machining[0]).toMatchObject({ width_mm: 5.5, region: { min: [6, 10.25, 6], max: [12, 15.75, 444] } });
  });

  it("centre a wider groove on the panel, and warn when the panel rattles in it", () => {
    const easy = swap("bottom_in_side_l", groove({ width: "6.5" }));
    expect(problems(easy)).toEqual([]);
    expect(derive(easy).byId.get("side_l")!.machining[0]).toMatchObject({ width_mm: 6.5, region: { min: [6, 9.75, 6], max: [12, 16.25, 444] } });
    expect(rows(easy)[0]![5]).toEqual(["groove 6.5 wide × 6 deep × 438 long in the right face for bottom at (6,9.8,0)"]);
    expect(problems(swap("bottom_in_side_l", groove({ width: "8" })))).toEqual([
      "warning: bottom_in_side_l (groove joining bottom to side_l): The groove is 8 mm wide for a 6 mm panel, so the panel rattles in it. Keep the groove within 1 mm of the panel's thickness",
    ]);
  });

  it("take a width only on a groove, and never with a fit", () => {
    expect(() => swap("bottom_in_side_l", groove({ width: "6", fit: "0.5" }))).toThrow(/Give a groove its width or its fit, not both/);
    expect(() => swap("side_l_in_front", { op: "add_joint", id: "side_l_in_front", type: "rabbet", host: "front", guest: "side_l", width: "12" })).toThrow(OpError);
    expect(() => swap("side_l_in_front", { op: "add_joint", id: "side_l_in_front", type: "rabbet", host: "front", guest: "side_l", width: "12" })).toThrow(/width only applies to groove/);
  });
});

describe("the rabbet's checks", () => {
  const rabbet = (depth: string): Op => ({ op: "add_joint", id: "side_l_in_front", type: "rabbet", host: "front", guest: "side_l", depth });

  it("let a rabbet go to two thirds of the front's thickness, and warn past it", () => {
    expect(problems(swap("side_l_in_front", rabbet("8")))).toEqual([]);
    expect(problems(swap("side_l_in_front", rabbet("9")))).toEqual([
      "warning: side_l_in_front (rabbet joining side_l to front): The rabbet is 9 mm deep in 12 mm of material and leaves a 3 mm lip. Two thirds of the thickness (8 mm) is the usual limit",
    ]);
  });

  it("refuse a rabbet as deep as the front is thick", () => {
    expect(problems(swap("side_l_in_front", rabbet("12")))).toContain(
      "error: side_l_in_front (rabbet joining side_l to front): The rabbet is 12 mm deep in 12 mm of material, so it leaves no lip. Make it shallower, or use a butt joint",
    );
  });

  it("call a rabbet with wood on both sides a dado", () => {
    // A front 20 mm wider each side than the box has a housing, not a rabbet, at each end.
    const wide = applyOps(box(), [{ op: "update_panel", id: "front", x: { start: { at: "-20" }, size: "440" } }]);
    const dado = (side: string, a: number, b: number) =>
      `warning: ${side}_in_front (rabbet joining ${side} to front): The rabbet has ${a} mm of the host on one side and ${b} mm on the other, so it's a dado or a groove. Set the guest flush with the host's end or edge, or use a dado or a groove`;
    expect(problems(wide)).toEqual([dado("side_l", 20, 408), dado("side_r", 408, 20)]);
  });
});

describe("the dado and rabbet", () => {
  it("puts the tongue on the face away from the side's end, and leaves the most wood beyond the dado", () => {
    const d = jointExample("dado_rabbet");
    expect(problems(d)).toEqual([]);
    const r = derive(d);
    const j = r.joints[0]!;
    expect(j.params).toEqual({ depth: 4, fit: 0, thickness: 6 });
    expect(j.defaulted.sort()).toEqual(["depth", "fit", "thickness"]);
    // The front sits at the side's front end, so its tongue is on its back face and 6 mm of the side is left beyond the dado.
    expect(j.features).toEqual([
      { kind: "tongue", part: "front", box: { min: [8, 0, 288], max: [12, 120, 294] } },
      { kind: "removed", part: "side", box: { min: [8, 0, 288], max: [12, 120, 294] } },
    ]);
    expect(r.byId.get("front")!.cut).toEqual({ length: 254, width: 120, thickness: 12 });
    expect(rows(d)).toEqual([
      ["Drawer side", 1, 300, 120, 12, ["dado for tongue 6 wide × 4 deep × 120 long in the right face for front at (8,0,288)"]],
      ["Drawer front", 1, 254, 120, 12, ["tongue 6 thick × 120 wide × 4 long on the left end, flush with the back face, into side"]],
    ]);
  });

  it("turns the tongue round for a back at the side's other end", () => {
    const d = applyOps(jointExample("dado_rabbet"), [
      { op: "add_panel", id: "back", name: "Drawer back", material: "stock", thickness_axis: "z", grain_axis: "x", x: { start: { face: "side.right" }, size: "250" }, y: { start: { at: "0" }, size: "120" }, z: { start: { face: "side.back" } } },
      { op: "add_joint", id: "back_joint", type: "dado_rabbet", host: "side", guest: "back" },
    ]);
    expect(problems(d)).toEqual([]);
    expect(derive(d).byId.get("side")!.machining.map((m) => m.region)).toEqual([
      { min: [8, 0, 288], max: [12, 120, 294] },
      { min: [8, 0, 6], max: [12, 120, 12] },
    ]);
    expect(rows(d).find((x) => x[0] === "Drawer back")![5]).toEqual(["tongue 6 thick × 120 wide × 4 long on the left end, flush with the front face, into side"]);
  });

  it("warns when the dado leaves too little short grain, and refuses a tongue as thick as the front", () => {
    const thick = (t: string) => applyOps(jointExample("dado_rabbet"), [{ op: "delete_joint", id: "joint" }, { op: "add_joint", id: "joint", type: "dado_rabbet", host: "side", guest: "front", thickness: t }]);
    expect(problems(thick("8"))).toEqual([
      "warning: joint (dado and rabbet joining front to side): Only 4 mm of the host is left beyond the dado, and short grain that thin breaks off. Leave 6 mm or more with a thinner tongue, or set the guest in from the host's end",
    ]);
    expect(problems(thick("12"))).toContain("error: joint (dado and rabbet joining front to side): The tongue (12 mm) must be thinner than the guest (12 mm)");
    // Set 10 mm in from the side's end, an 8 mm tongue leaves 14 mm beyond its dado.
    const setIn = applyOp(thick("8"), { op: "update_panel", id: "front", z: { end: { face: "side.front", offset: "-10" } } });
    expect(problems(setIn)).toEqual([]);
  });
});
