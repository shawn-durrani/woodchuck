// Each joint in the library, pinned to exact numbers.

import { describe, expect, it } from "vitest";
import {
  applyOps,
  cutList,
  derive,
  describeJoints,
  emptyDesign,
  JOINT_LIBRARY,
  JOINT_TYPES,
  runChecks,
  type Design,
  type Op,
} from "../src/index.js";

const mat = (id: string, t: number): Op => ({ op: "define_material", id, name: id, kind: "solid", thickness_mm: t, grained: true });
const build = (ops: Op[]): Design => applyOps(emptyDesign("t"), ops);
const problems = (d: Design) => runChecks(d, derive(d)).issues.filter((i) => i.code !== "floating");

describe("the joint library", () => {
  it("has an entry for every joint type", () => {
    expect(Object.keys(JOINT_LIBRARY).sort()).toEqual([...JOINT_TYPES].sort());
    expect(describeJoints()).toHaveLength(JOINT_TYPES.length);
  });
});

describe("mortise and tenon", () => {
  const ops: Op[] = [
    mat("leg45", 45),
    mat("rail20", 20),
    {
      op: "add_panel",
      id: "leg",
      name: "Leg",
      material: "leg45",
      thickness_axis: "x",
      grain_axis: "y",
      x: { start: { at: "0" } },
      y: { start: { at: "0" }, size: "700" },
      z: { start: { at: "0" }, size: "45" },
    },
    {
      op: "add_panel",
      id: "rail",
      name: "Rail",
      material: "rail20",
      thickness_axis: "z",
      grain_axis: "x",
      x: { start: { face: "leg.right" }, size: "400" },
      y: { start: { at: "600" }, size: "80" },
      z: { start: { face: "leg.back", offset: "12.5" } },
    },
    { op: "add_joint", id: "mt", type: "mortise_tenon", host: "leg", guest: "rail" },
  ];

  it("takes usual proportions from the library and lengthens the rail", () => {
    const d = derive(build(ops));
    const j = d.joints[0]!;
    expect(j.params).toMatchObject({ thickness: 6.5, depth: 30, shoulder: 10, fit: 0 });
    expect(j.defaulted.sort()).toEqual(["depth", "fit", "shoulder", "thickness"]);
    expect(d.byId.get("rail")!.cut.length).toBe(430);
  });

  it("cuts a tenon and a matching mortise", () => {
    const d = derive(build(ops));
    const tenon = d.joints[0]!.features.find((f) => f.kind === "tongue")!;
    expect(tenon.box).toEqual({ min: [15, 610, 19.25], max: [45, 670, 25.75] });
    expect(d.byId.get("leg")!.machining[0]).toMatchObject({ label: "mortise", width_mm: 6.5, length_mm: 60, depth_mm: 30 });
    expect(d.byId.get("rail")!.machining[0]).toMatchObject({ label: "tenon", width_mm: 6.5, length_mm: 60, depth_mm: 30 });
    expect(problems(build(ops))).toEqual([]);
  });

  it("refuses a tenon longer than the leg is deep", () => {
    const d = build([...ops.slice(0, -1), { op: "add_joint", id: "mt", type: "mortise_tenon", host: "leg", guest: "rail", depth: "50" }]);
    expect(problems(d).map((i) => i.message)).toEqual([expect.stringMatching(/longer than the host is deep/)]);
  });
});

describe("tongue and groove", () => {
  it("adds a thinner tongue and widens the board by its depth", () => {
    const d = build([
      mat("oak19", 19),
      { op: "add_panel", id: "a", name: "A", material: "oak19", thickness_axis: "y", grain_axis: "x", x: { start: { at: "0" }, size: "600" }, y: { start: { at: "0" } }, z: { start: { at: "0" }, size: "150" } },
      { op: "add_panel", id: "b", name: "B", material: "oak19", thickness_axis: "y", grain_axis: "x", x: { start: { at: "0" }, size: "600" }, y: { start: { at: "0" } }, z: { start: { face: "a.front" }, size: "150" } },
      { op: "add_joint", id: "tg", type: "tongue", host: "a", guest: "b" },
    ]);
    const r = derive(d);
    expect(r.joints[0]!.params).toMatchObject({ thickness: 6.5, depth: 9.5 });
    expect(r.byId.get("b")!.cut.width).toBe(159.5);
    expect(r.joints[0]!.features.find((f) => f.kind === "tongue")!.box).toEqual({ min: [0, 6.25, 140.5], max: [600, 12.75, 150] });
    expect(problems(d)).toEqual([]);
  });
});

describe("half lap", () => {
  const rails: Op[] = [
    mat("pine20", 20),
    { op: "add_panel", id: "r1", name: "Rail", material: "pine20", thickness_axis: "y", grain_axis: "x", x: { start: { at: "0" }, size: "600" }, y: { start: { at: "0" } }, z: { start: { at: "0" }, size: "60" } },
    { op: "add_panel", id: "r2", name: "Cross rail", material: "pine20", thickness_axis: "y", grain_axis: "z", x: { start: { at: "270" }, size: "60" }, y: { start: { at: "0" } }, z: { start: { at: "-100" }, size: "260" } },
  ];

  it("is an overlap error without the joint", () => {
    expect(problems(build(rails)).map((i) => i.code)).toEqual(["overlap"]);
  });

  it("takes half the thickness from each rail where they cross", () => {
    const d = build([...rails, { op: "add_joint", id: "lap", type: "half_lap", host: "r1", guest: "r2" }]);
    expect(problems(d)).toEqual([]);
    const r = derive(d);
    expect(r.joints[0]!.features.map((f) => [f.part, f.box])).toEqual([
      ["r1", { min: [270, 10, 0], max: [330, 20, 60] }],
      ["r2", { min: [270, 0, 0], max: [330, 10, 60] }],
    ]);
    expect(r.byId.get("r1")!.cut.length).toBe(600);
    expect(cutList(d, r).rows.map((row) => row.machining)).toEqual([
      ["half lap 60 × 60 × 10 deep in the top face for r2 at (270,10,0)"],
      ["half lap 60 × 60 × 10 deep in the bottom face for r1 at (0,0,100)"],
    ]);
  });
});

describe("box joint", () => {
  it("splits the corner into alternating fingers", () => {
    const d = build([
      mat("ply12", 12),
      { op: "add_panel", id: "front", name: "Front", material: "ply12", thickness_axis: "z", grain_axis: "x", x: { start: { at: "0" }, size: "300" }, y: { start: { at: "0" }, size: "100" }, z: { start: { at: "0" } } },
      { op: "add_panel", id: "side", name: "Side", material: "ply12", thickness_axis: "x", grain_axis: "z", x: { start: { at: "0" } }, y: { start: { at: "0" }, size: "100" }, z: { start: { at: "0" }, size: "250" } },
      { op: "add_joint", id: "bj", type: "box_joint", host: "front", guest: "side" },
    ]);
    expect(problems(d)).toEqual([]);
    const j = derive(d).joints[0]!;
    expect(j.params.finger).toBe(12.5);
    const removed = j.features.filter((f) => f.kind === "removed");
    expect(removed).toHaveLength(8);
    expect(removed.map((f) => f.part)).toEqual(["side", "front", "side", "front", "side", "front", "side", "front"]);
  });
});

describe("fasteners", () => {
  const pair = (t: number, joint: Op): Design =>
    build([
      mat("stock", t),
      { op: "add_panel", id: "top", name: "Top", material: "stock", thickness_axis: "y", grain_axis: "x", x: { start: { at: "0" }, size: "400" }, y: { start: { at: "300" } }, z: { start: { at: "0" }, size: "200" } },
      { op: "add_panel", id: "side", name: "Side", material: "stock", thickness_axis: "x", grain_axis: "y", x: { start: { at: "0" } }, y: { start: { at: "0" }, end: { face: "top.bottom" } }, z: { start: { at: "0" }, size: "200" } },
      joint,
    ]);

  it("places pocket screws in the guest and warns in thin stock", () => {
    const d = pair(10, { op: "add_joint", id: "p", type: "pocket_screws", host: "top", guest: "side" });
    const r = derive(d);
    expect(r.joints[0]!.features.filter((f) => f.kind === "fastener")).toHaveLength(2);
    expect(r.byId.get("side")!.machining[0]).toMatchObject({ label: "pocket holes", count: 2 });
    expect(problems(d).map((i) => i.message)).toEqual([expect.stringMatching(/Pocket-hole jigs need about 12 mm/)]);
  });

  it("drills matching dowel holes in both parts and warns about fat dowels", () => {
    const d = pair(18, { op: "add_joint", id: "dw", type: "dowels", host: "top", guest: "side", count: 3, diameter: "10" });
    const r = derive(d);
    expect(r.byId.get("top")!.machining[0]).toMatchObject({ label: "dowel holes", count: 3, diameter_mm: 10 });
    expect(r.byId.get("side")!.machining[0]).toMatchObject({ label: "dowel holes", count: 3 });
    expect(problems(d).map((i) => i.message)).toEqual([expect.stringMatching(/more than half of 18 mm stock/)]);
  });

  it("drives screws down through the host into the guest", () => {
    const r = derive(pair(18, { op: "add_joint", id: "s", type: "screws", host: "top", guest: "side", count: 2 }));
    const screws = r.joints[0]!.features.filter((f) => f.kind === "fastener");
    expect(screws.map((f) => [f.from![1], f.to![1]])).toEqual([
      [318, 275],
      [318, 275],
    ]);
  });
});

describe("through slot", () => {
  // A 70 × 35 leg with a 22 × 45 rail passing front to back through it.
  const frame = (railX = "24"): Op[] => [
    mat("oak35", 35),
    mat("oak22", 22),
    { op: "add_panel", id: "leg", name: "Leg", material: "oak35", thickness_axis: "z", grain_axis: "y", x: { start: { at: "0" }, size: "70" }, y: { start: { at: "0" }, size: "900" }, z: { start: { at: "130" } } },
    { op: "add_panel", id: "rail", name: "Rail", material: "oak22", thickness_axis: "x", grain_axis: "z", x: { start: { at: railX } }, y: { start: { at: "400" }, size: "45" }, z: { start: { at: "0" }, size: "300" } },
    { op: "add_joint", id: "slot", type: "through_slot", host: "leg", guest: "rail" },
  ];

  it("cuts a slot right through the leg and leaves the rail whole", () => {
    const d = build(frame());
    expect(problems(d)).toEqual([]);
    const r = derive(d);
    expect(r.byId.get("rail")!.cut).toEqual({ length: 300, width: 45, thickness: 22 });
    expect(r.joints[0]!.features).toEqual([{ kind: "removed", part: "leg", box: { min: [24, 400, 130], max: [46, 445, 165] } }]);
    expect(cutList(d, r).rows.find((x) => x.name === "Leg")!.machining).toEqual(["through slot 22 × 45, right through 35, for rail at (24,400,0)"]);
  });

  it("calls a slot at the edge a notch", () => {
    const d = build(frame("0"));
    expect(problems(d).map((i) => i.message)).toEqual([expect.stringMatching(/breaks out of the edge/)]);
  });

  it("warns when the walls beside the slot get thin", () => {
    const d = build(frame("6"));
    expect(problems(d).map((i) => i.message)).toEqual([expect.stringMatching(/Only 6 mm of the host is left/)]);
  });

  // A rail at the very end of the leg: the slot opens out of the end.
  const atY = (y: string, ops = frame()): Op[] =>
    ops.map((o) => (o.op === "add_panel" && o.id === "rail" ? { ...o, y: { start: { at: y }, size: "45" } } : o));
  const legMachining = (d: Design) => cutList(d, derive(d)).rows.find((x) => x.name === "Leg")!.machining;

  it("opens a slot at the bottom end of the leg as a bridle", () => {
    const d = build(atY("0"));
    expect(problems(d)).toEqual([]);
    const r = derive(d);
    expect(r.byId.get("rail")!.cut).toEqual({ length: 300, width: 45, thickness: 22 });
    expect(r.byId.get("leg")!.cut.length).toBe(900);
    expect(r.joints[0]!.features).toEqual([{ kind: "removed", part: "leg", box: { min: [24, 0, 130], max: [46, 45, 165] } }]);
    expect(legMachining(d)).toEqual(["open slot (bridle) 22 × 45 from the bottom end, right through 35, for rail at (24,0,0)"]);
  });

  it("adds the fit across the slot and at its closed end only", () => {
    const ops = atY("0").map((o) => (o.op === "add_joint" ? { ...o, fit: "0.5" } : o));
    const m = derive(build(ops)).byId.get("leg")!.machining[0]!;
    expect([m.width_mm, m.length_mm, m.depth_mm, m.open_end]).toEqual([22.5, 45.25, 35, "bottom"]);
  });

  it("opens at the top end too", () => {
    expect(legMachining(build(atY("855")))).toEqual(["open slot (bridle) 22 × 45 from the top end, right through 35, for rail at (24,855,0)"]);
  });

  it("cuts open and enclosed slots from one joint across an array", () => {
    const d = build([...atY("0"), { op: "set_array", id: "levels", parts: ["rail"], axis: "y", count: "3", pitch: "400" }]);
    expect(problems(d)).toEqual([]);
    expect(legMachining(d)).toEqual([
      "open slot (bridle) 22 × 45 from the bottom end, right through 35, for rail at (24,0,0)",
      "through slot 22 × 45, right through 35, for rail at (24,400,0)",
      "through slot 22 × 45, right through 35, for rail at (24,800,0)",
    ]);
  });

  it("still calls a slot open at a corner a notch", () => {
    const d = build(atY("0", frame("0")));
    expect(problems(d).map((i) => i.message)).toEqual([expect.stringMatching(/breaks out of the edge/)]);
  });

  it("refuses a slot that would cut the leg in two", () => {
    const ops = atY("0").map((o) => (o.op === "add_panel" && o.id === "leg" ? { ...o, y: { start: { at: "0" }, size: "45" } } : o));
    expect(problems(build(ops)).map((i) => i.message)).toEqual([expect.stringMatching(/cut it in two/)]);
  });

  it("says when the member doesn't pass all the way through", () => {
    const ops = frame();
    ops[3] = { ...(ops[3] as Extract<Op, { op: "add_panel" }>), z: { start: { at: "140" }, size: "160" } };
    expect(problems(build(ops)).map((i) => i.message)).toEqual([expect.stringMatching(/must pass right through leg/), expect.stringMatching(/overlap/)]);
  });
});

describe("hardware on the floor", () => {
  it("lets castors hold up a raised carcass", () => {
    const ops: Op[] = [
      mat("ply18", 18),
      { op: "add_panel", id: "bottom", name: "Bottom", material: "ply18", thickness_axis: "y", grain_axis: "x", x: { start: { at: "0" }, size: "600" }, y: { start: { at: "125" } }, z: { start: { at: "0" }, size: "500" } },
    ];
    const raised = build(ops);
    expect(runChecks(raised, derive(raised)).issues.map((i) => i.code)).toEqual(["floating"]);
    const onCastors = build([...ops, { op: "set_hardware", id: "castors", kind: "castor", name: "Braked castor, 100 mm", connects: ["bottom"], qty: 4, on_floor: true }]);
    expect(runChecks(onCastors, derive(onCastors)).issues).toEqual([]);
  });
});
