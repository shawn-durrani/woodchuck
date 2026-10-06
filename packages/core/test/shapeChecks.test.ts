// The checks and joints on parts with cuts, and gap_x, gap_y and gap_z.
// Every part and size here is invented: a small shelf unit, a sloped
// drawer, and the joint library's own worked examples.

import { describe, expect, it } from "vitest";
import {
  applyOp,
  applyOps,
  derive,
  emptyDesign,
  explain,
  jointExample,
  OpError,
  runChecks,
  type Design,
  type JointType,
  type Op,
} from "../src/index.js";

const side = (id: string, x0: string): Op => ({
  op: "add_panel",
  id,
  name: id,
  material: "ply18",
  thickness_axis: "x",
  grain_axis: "y",
  x: { start: { at: x0 } },
  y: { start: { at: "0" }, size: "500" },
  z: { start: { at: "0" }, size: "300" },
});

/** Two 18 mm sides 500 apart, 500 high and 300 deep, with a shelf between them at 250. */
const shelfUnit = (more: Op[] = []): Design =>
  applyOps(emptyDesign("Shelf unit"), [
    { op: "define_material", id: "ply18", name: "18 mm ply", kind: "sheet", thickness_mm: 18, grained: true },
    { op: "define_material", id: "ply12", name: "12 mm ply", kind: "sheet", thickness_mm: 12, grained: true },
    side("side_l", "0"),
    side("side_r", "482"),
    {
      op: "add_panel",
      id: "shelf",
      name: "Shelf",
      material: "ply18",
      thickness_axis: "y",
      grain_axis: "x",
      x: { start: { face: "side_l.right" }, end: { face: "side_r.left" } },
      y: { start: { at: "250" } },
      z: { start: { at: "0" }, size: "300" },
    },
    ...more,
  ]);

const report = (d: Design) => runChecks(d, derive(d)).issues;
const codes = (d: Design) => report(d).map((i) => i.code);
const said = (d: Design, code: string) => report(d).filter((i) => i.code === code).map((i) => i.message);

/** The side's top sloping from 500 at the back to 300 at the front. */
const slopeTop: Op = { op: "set_edge_cut", id: "side_l", cut: "slope", edge: "top", start: { at: "500" }, end: { at: "300" } };
const board = (y: string): Op => ({
  op: "add_panel",
  id: "board",
  name: "Board",
  material: "ply18",
  thickness_axis: "y",
  grain_axis: "x",
  x: { start: { at: "0" }, size: "200" },
  y: { start: { at: y } },
  z: { start: { at: "200" }, end: { at: "300" } },
});

describe("overlaps and contact on the shape you cut", () => {
  it("finds no overlap where a slope took the wood, and the deepest overlap where it didn't", () => {
    expect(said(shelfUnit([board("420")]), "overlap")).toEqual(["side_l and board overlap by 18 × 18 × 100 mm and no joint explains it"]);
    // The slope is under 367 mm high wherever the board is, so a board at 420 clears it.
    expect(codes(shelfUnit([slopeTop, board("420")]))).not.toContain("overlap");
    // At 340 it runs 18 into the slope across x and down y, and 40 along z at its lowest face.
    expect(said(shelfUnit([slopeTop, board("340")]), "overlap")).toEqual(["side_l and board overlap by up to 18 × 18 × 40 mm and no joint explains it"]);
  });

  it("lets hardware sit in a notch, and says how far it runs into the wood when it doesn't", () => {
    const glide = (y: string): Op => ({
      op: "set_hardware",
      id: "glide",
      kind: "glide",
      name: "Floor glide",
      connects: ["side_r"],
      qty: 1,
      spec: { load_kg: 50 },
      shape: [{ name: "body", min_mm: [0, 0, 0], max_mm: [18, 50, 40] }],
      place: { x: "482", y, z: "260" },
    });
    const notch: Op = { op: "set_cutout", id: "side_r", cut: "pocket", shape: "rect", y: { start: { at: "-5" }, end: { at: "60" } }, z: { start: { at: "250" }, end: { at: "305" } } };
    expect(said(shelfUnit([glide("0")]), "hardware_overlap")).toEqual(["Floor glide (glide) runs into side_r by 18 × 50 × 40 mm. Check the gap left for it"]);
    expect(codes(shelfUnit([notch, glide("0")]))).not.toContain("hardware_overlap");
    expect(said(shelfUnit([notch, glide("40")]), "hardware_overlap")).toEqual(["Floor glide (glide) runs into side_r by up to 18 × 30 × 40 mm. Check the gap left for it"]);
  });

  it("holds a part up only where the shape it rests on reaches", () => {
    const block: Op = {
      op: "add_panel",
      id: "block",
      name: "Block",
      material: "ply18",
      thickness_axis: "y",
      grain_axis: "x",
      x: { start: { at: "0" }, size: "18" },
      y: { start: { at: "500" } },
      z: { start: { at: "0" }, size: "60" },
    };
    const notch: Op = { op: "set_cutout", id: "side_l", cut: "notch", shape: "rect", y: { start: { at: "450" }, end: { at: "505" } }, z: { start: { at: "-5" }, end: { at: "100" } } };
    expect(codes(shelfUnit([block]))).not.toContain("floating");
    expect(said(shelfUnit([block, notch]), "floating")).toEqual(["Nothing holds up block. Join it to the rest with a joint or hardware, or tag a part wall_mounted"]);
  });

  it("stands a part on the floor only where its shape reaches down", () => {
    const kick: Op = {
      op: "add_panel",
      id: "kick",
      name: "Kick",
      material: "ply18",
      thickness_axis: "x",
      grain_axis: "z",
      x: { start: { at: "600" } },
      y: { start: { at: "0" }, size: "80" },
      z: { start: { at: "0" }, size: "300" },
    };
    const raise: Op = { op: "set_edge_cut", id: "kick", cut: "raise", edge: "bottom", start: { at: "5" }, end: { at: "5" } };
    expect(codes(shelfUnit([kick]))).not.toContain("floating");
    expect(said(shelfUnit([kick, raise]), "floating")).toEqual(["Nothing holds up kick. Join it to the rest with a joint or hardware, or tag a part wall_mounted"]);
  });
});

describe("wood a cut leaves too thin", () => {
  const taper = (top: string): Op => ({ op: "set_edge_cut", id: "side_l", cut: "taper", edge: "front", start: { at: "300" }, end: { at: top } });

  it("warns when an edge cut leaves a strip under half the thickness", () => {
    expect(said(shelfUnit([taper("5")]), "cut_thin")).toEqual([
      "Cut taper on side_l leaves only 5 mm of wood between it and the back edge. Wood narrower than 9 mm, half the part's 18 mm thickness, can split or snap off, so leave at least that much.",
    ]);
    expect(codes(shelfUnit([taper("40")]))).not.toContain("cut_thin");
  });

  it("warns when a cutout comes close to the outline", () => {
    const hole = (z: string): Op => ({ op: "set_cutout", id: "side_r", cut: "hole", shape: "circle", centre: { y: { at: "100" }, z: { at: z } }, diameter: "30" });
    expect(said(shelfUnit([hole("20")]), "cut_thin")).toEqual([
      "Cut hole on side_r leaves only 5 mm of wood between it and the back edge. Wood narrower than 9 mm, half the part's 18 mm thickness, can split or snap off, so leave at least that much.",
    ]);
    expect(codes(shelfUnit([hole("40")]))).not.toContain("cut_thin");
  });

  it("warns when two cutouts leave too thin a web between them", () => {
    const round: Op = { op: "set_cutout", id: "side_r", cut: "round", shape: "circle", centre: { y: { at: "134" }, z: { at: "100" } }, diameter: "30" };
    const square = (z0: string): Op => ({ op: "set_cutout", id: "side_r", cut: "square", shape: "rect", y: { start: { at: "100" }, size: "40" }, z: { start: { at: z0 }, size: "40" } });
    expect(report(shelfUnit([round, square("120")])).filter((i) => i.code.startsWith("cut_"))).toEqual([
      {
        severity: "warning",
        code: "cut_web",
        message:
          "Cuts round and square on side_r leave only 5 mm of wood between them. Wood narrower than 9 mm, half the part's 18 mm thickness, can split or snap off, so leave at least that much.",
        parts: ["side_r"],
        key: "cut_web:side_r:",
      },
    ]);
    expect(codes(shelfUnit([round, square("140")]))).not.toContain("cut_web");
  });

  it("holds a thin part to 6 mm, and lists each thin place", () => {
    const divider: Op = {
      op: "add_panel",
      id: "divider",
      name: "Divider",
      material: "ply12",
      thickness_axis: "z",
      grain_axis: "x",
      x: { start: { at: "100" }, size: "200" },
      y: { start: { at: "0" }, size: "100" },
      z: { start: { at: "100" } },
    };
    const d = shelfUnit([
      divider,
      { op: "set_edge_cut", id: "divider", cut: "bevel", edge: "top", start: { at: "100" }, end: { at: "4" } },
      { op: "set_cutout", id: "divider", cut: "slot", shape: "rect", x: { start: { at: "180" }, size: "20" }, y: { start: { at: "3" }, end: { at: "40" } } },
    ]);
    expect(said(d, "cut_thin")).toEqual([
      "Cut slot on divider leaves only 3 mm of wood between it and the bottom edge. Wood narrower than 6 mm can split or snap off, so leave at least that much. It's 4 mm between cut bevel and the bottom edge too.",
    ]);
  });

  it("reads neither a slope run out to a point nor a corner cut off as thin", () => {
    const point: Op = { op: "set_edge_cut", id: "side_l", cut: "wedge", edge: "top", start: { at: "500" }, end: { at: "0" } };
    const chamfer: Op = {
      op: "set_edge_cut",
      id: "side_r",
      cut: "corner",
      edge: "front",
      start: { at: "300" },
      start_along: { at: "495" },
      end: { at: "295" },
      end_along: { at: "500" },
    };
    expect(codes(shelfUnit([point, chamfer])).filter((c) => c.startsWith("cut_"))).toEqual([]);
  });
});

describe("joints on parts with cuts", () => {
  const dado: Op = { op: "add_joint", id: "shelf_l", type: "dado", host: "side_l", guest: "shelf", depth: "6" };
  const example = (t: JointType, ops: Op[]) => applyOps(jointExample(t), ops);

  it("refuses a joint whose contact a cut has taken away", () => {
    // A window in the side right where the shorter shelf meets it, leaving the side whole at the front.
    const d = shelfUnit([
      { op: "update_panel", id: "shelf", z: { start: { at: "0" }, size: "250" } },
      dado,
      { op: "set_cutout", id: "side_l", cut: "window", shape: "rect", y: { start: { at: "240" }, size: "50" }, z: { start: { at: "-10" }, end: { at: "260" } } },
    ]);
    expect(report(d).filter((i) => i.code === "joint_on_cut")).toEqual([
      {
        severity: "error",
        code: "joint_on_cut",
        message: "Joint shelf_l: cut window on side_l takes away all the wood where shelf meets side_l, so the dado (housing) can't be placed. Move the cut, or join the parts somewhere else",
        parts: ["side_l", "shelf"],
        key: "joint_on_cut:shelf,side_l:",
      },
    ]);
    const r = derive(d);
    expect(r.byId.get("shelf")!.cut.length).toBe(464);
    expect(r.byId.get("side_l")!.machining).toEqual([]);
  });

  it("places a housing over the wood that's left, and warns when it runs out into a cutout", () => {
    const port: Op = { op: "set_cutout", id: "side_l", cut: "port", shape: "circle", centre: { y: { at: "259" }, z: { at: "150" } }, diameter: "40" };
    const d = shelfUnit([dado, port]);
    expect(said(d, "housing_runs_out")).toEqual([
      "Joint shelf_l: the dado for shelf in side_l runs out into cut port for 40 mm, so shelf shows there and has less to hold it. Move the cut clear, unless that's the look you want",
    ]);
    expect(derive(d).byId.get("shelf")!.cut.length).toBe(470);
    // A slope that the housing runs out through is like the blank's own edge.
    const slope: Op = { op: "set_edge_cut", id: "side_l", cut: "rake", edge: "front", start: { at: "300" }, end: { at: "200" } };
    expect(codes(shelfUnit([dado, slope]))).toEqual([]);
  });

  it("spreads screws over the part of the contact a cut has left", () => {
    const at = (d: Design) => derive(d).joints[0]!.features.map((f) => f.from![2]);
    expect(at(jointExample("screws"))).toEqual([45, 135]);
    // A notch out of the side's top back corner takes the first 60 mm of where the top meets it.
    const d = example("screws", [{ op: "set_cutout", id: "side", cut: "notch", shape: "rect", y: { start: { at: "250" }, end: { at: "305" } }, z: { start: { at: "-5" }, end: { at: "60" } } }]);
    expect(at(d)).toEqual([90, 150]);
    expect(derive(d).byId.get("top")!.machining[0]!.length_mm).toBe(120);
    expect(codes(d)).toEqual([]);
    const gone = example("screws", [{ op: "set_edge_cut", id: "side", cut: "drop", edge: "top", start: { at: "290" }, end: { at: "290" } }]);
    expect(said(gone, "joint_on_cut")).toEqual([
      "Joint joint: cut drop on side takes away all the wood where side meets top, so the screwed joint can't be placed. Move the cut, or join the parts somewhere else",
    ]);
    expect(derive(gone).joints[0]!.features).toEqual([]);
  });

  it("refuses a cut into a mortise or under its tenon", () => {
    const peg = (y: string): Op => ({ op: "set_cutout", id: "leg", cut: "peg", shape: "circle", centre: { y: { at: y }, z: { at: "22.5" } }, diameter: "10" });
    expect(said(example("mortise_tenon", [peg("380")]), "cut_joint")).toEqual([
      "Joint joint: cut peg on leg breaks into the mortise for rail, over 10 mm of its 60 mm length. A mortise needs wood all round, so move the cut clear of it",
    ]);
    expect(codes(example("mortise_tenon", [peg("200")]))).not.toContain("cut_joint");
    const nick: Op = { op: "set_cutout", id: "rail", cut: "nick", shape: "rect", x: { start: { at: "40" }, end: { at: "75" } }, y: { start: { at: "400" }, end: { at: "425" } } };
    expect(said(example("mortise_tenon", [nick]), "cut_joint")).toEqual([
      "Joint joint: cut nick on rail takes wood from under its tenon, over 10 mm of its 60 mm width. Move the cut clear of the tenon, or set the tenon in further with a bigger shoulder",
    ]);
  });

  it("refuses a cut inside a half lap, and a half lap with nothing left to cross", () => {
    const bolt = (x: string): Op => ({ op: "set_cutout", id: "rail", cut: "bolt", shape: "circle", centre: { z: { at: "30" }, x: { at: x } }, diameter: "10" });
    expect(said(example("half_lap", [bolt("200")]), "cut_joint")).toEqual([
      "Joint joint: cut bolt on rail takes 10 × 10 mm of wood from inside the half lap, where both parts need all of theirs. Move the cut clear of the joint",
    ]);
    expect(codes(example("half_lap", [bolt("100")]))).toEqual([]);
    const shortened = example("half_lap", [
      { op: "update_panel", id: "cross_rail", z: { start: { at: "-120" }, end: { at: "30" } } },
      { op: "set_cutout", id: "cross_rail", cut: "short", shape: "rect", x: { start: { at: "160" }, end: { at: "240" } }, z: { start: { at: "-5" }, end: { at: "35" } } },
    ]);
    expect(said(shortened, "joint_on_cut")).toEqual([
      "Joint joint: cut short on cross_rail takes away all the wood where cross_rail crosses rail, so the half lap can't be placed. Move the cut, or join the parts somewhere else",
    ]);
  });

  it("refuses a cut where a part passes through a slot, and measures the slot's walls to the outline", () => {
    const nick: Op = { op: "set_cutout", id: "bearer", cut: "nick", shape: "rect", y: { start: { at: "440" }, end: { at: "455" } }, z: { start: { at: "140" }, end: { at: "160" } } };
    expect(said(example("through_slot", [nick]), "cut_joint")).toEqual([
      "Joint joint: cut nick on bearer takes 10 × 20 mm of wood from where it passes through post. The slot is cut to the blank, so bearer would sit loose in it. Move the cut clear of post",
    ]);
    // The post's right edge tapers in to 69 mm at the top of the slot, 10 mm past it, where the blank leaves 31.
    expect(codes(jointExample("through_slot"))).toEqual([]);
    const taper: Op = { op: "set_edge_cut", id: "post", cut: "taper", edge: "right", start: { at: "90" }, end: { at: "62" } };
    expect(said(example("through_slot", [taper]), "joint_check")).toEqual([
      "joint (through slot (through mortise or bridle) joining bearer to post): Only 10 mm of the host is left beside the slot. Thin walls split; leave at least 10.5 mm",
    ]);
  });
});

describe("rules that read a face a cut has taken wood from", () => {
  const rule = (id: string, expr: string): Op => ({ op: "set_rule", id, expr, severity: "warning", message: "Leave room above the shelf" });

  it("warns that the face is still the blank's, once for each rule", () => {
    const d = shelfUnit([slopeTop, rule("headroom", "side_l.top - shelf.top >= 200"), rule("headroom_too", "side_l.top >= shelf.top")]);
    expect(said(d, "rule_reads_cut_face")).toEqual([
      "Rule headroom reads side_l.top, and cut slope takes wood off that end. side_l.top still means the blank's top, its highest point before any cut, so the rule may not see what the cut took. To measure to the shape, use gap_y",
      "Rule headroom_too reads side_l.top, and cut slope takes wood off that end. side_l.top still means the blank's top, its highest point before any cut, so the rule may not see what the cut took. To measure to the shape, use gap_y",
    ]);
    expect(report(d).find((i) => i.code === "rule_reads_cut_face")!.parts).toEqual(["side_l"]);
  });

  it("stays quiet for a face no cut has touched", () => {
    expect(codes(shelfUnit([slopeTop, rule("standing", "side_l.bottom <= 0 && side_r.top >= 500 && side_l.left >= 0")]))).toEqual([]);
  });

  it("names a notch that takes wood off a corner, from each face it reaches", () => {
    const kick: Op = { op: "set_cutout", id: "side_r", cut: "kick", shape: "rect", y: { start: { at: "-5" }, end: { at: "60" } }, z: { start: { at: "250" }, end: { at: "305" } } };
    expect(said(shelfUnit([kick, rule("floor", "side_r.bottom <= 0 && side_r.front >= 300")]), "rule_reads_cut_face").map((m) => m.split(". ")[0])).toEqual([
      "Rule floor reads side_r.bottom, and cut kick takes wood off that end",
      "Rule floor reads side_r.front, and cut kick takes wood off that edge",
    ]);
  });
});

describe("gap_x, gap_y and gap_z", () => {
  it("measures the clear space between plain boxes, and minus their overlap", () => {
    const r = derive(shelfUnit());
    expect(r.evaluate("gap_x(side_l, side_r)").value).toBe(464);
    expect(r.evaluate("gap_x(shelf, side_l)").value).toBe(0);
    expect(r.evaluate("gap_x(side_r, shelf)").value).toBe(0);
    const overlapping = derive(shelfUnit([{ op: "update_panel", id: "shelf", x: { start: { at: "10" }, end: { face: "side_r.left" } } }]));
    expect(overlapping.evaluate("gap_x(shelf, side_l)").value).toBe(-8);
  });

  it("refuses two parts that don't line up along the axis", () => {
    expect(() => derive(shelfUnit()).evaluate("gap_y(shelf, side_l)")).toThrow(
      "seen along y, shelf and side_l don't cover any of each other, so gap_y has nothing to measure. Use the axis they're apart on",
    );
    const d = shelfUnit([{ op: "set_rule", id: "gap", expr: "gap_y(shelf, side_l) >= 6", severity: "error", message: "Gap" }]);
    expect(said(d, "rule_error")).toEqual(["Rule gap: seen along y, shelf and side_l don't cover any of each other, so gap_y has nothing to measure. Use the axis they're apart on"]);
  });

  it("measures between array copies", () => {
    const d = shelfUnit([{ op: "set_array", id: "shelves", parts: ["shelf"], axis: "y", count: "3", pitch: "120" }]);
    expect(derive(d).evaluate("gap_y(shelf#2, shelf)").value).toBe(102);
  });

  // An invented drawer box whose sides slope from 160 at the back to 90 at the front, with a rail over its front.
  const drawer = (more: Op[] = []): Design =>
    applyOps(emptyDesign("Sloped drawer"), [
      { op: "define_material", id: "ply12", name: "12 mm birch ply", kind: "sheet", thickness_mm: 12, grained: true },
      ...(["side_l", "side_r"] as const).map(
        (id, i): Op => ({
          op: "add_panel",
          id,
          name: id,
          material: "ply12",
          thickness_axis: "x",
          grain_axis: "z",
          x: i ? { end: { at: "360" } } : { start: { at: "0" } },
          y: { start: { at: "0" }, size: "160" },
          z: { start: { at: "0" }, size: "420" },
        }),
      ),
      ...(["side_l", "side_r"] as const).map((id): Op => ({ op: "set_edge_cut", id, cut: "slope", edge: "top", start: { at: "160" }, end: { at: "90" } })),
      {
        op: "add_panel",
        id: "rail",
        name: "Rail",
        material: "ply12",
        thickness_axis: "y",
        grain_axis: "x",
        x: { start: { at: "0" }, size: "360" },
        y: { start: { at: "130" } },
        z: { start: { at: "250" }, end: { at: "420" } },
        tags: ["fixed"],
      },
      ...more,
    ]);

  it("follows a sloped drawer side under a rail, where the blank's top would fail", () => {
    const d = drawer([
      { op: "set_rule", id: "blank_clear", expr: "rail.bottom - side_l.top >= 6", severity: "error", message: "The drawer needs 6 mm under the rail" },
      { op: "set_rule", id: "shape_clear", expr: "gap_y(rail, side_l) >= 6", severity: "error", message: "The drawer needs 6 mm under the rail" },
    ]);
    const r = derive(d);
    // The slope is 118.3 high where the rail starts, at z 250.
    expect(r.evaluate("gap_y(rail, side_l)").value).toBe(11.666667);
    expect(explain(d, r, "shape_clear")).toEqual(["shape_clear: gap_y(rail, side_l) >= 6", "  = gap_y(rail, side_l) (11.67) >= 6", "  → passes"]);
    expect(report(d).map((i) => `${i.code} ${i.message}`)).toEqual([
      "rule_failed The drawer needs 6 mm under the rail (rule blank_clear)",
      "rule_reads_cut_face Rule blank_clear reads side_l.top, and cut slope takes wood off that edge. side_l.top still means the blank's top, its highest point before any cut, so the rule may not see what the cut took. To measure to the shape, use gap_y",
    ]);
    // Lower the rail to 120 and the shape rule fails too.
    const low = applyOp(d, { op: "update_panel", id: "rail", y: { start: { at: "120" } } });
    expect(derive(low).evaluate("gap_y(rail, side_l)").value).toBe(1.666667);
    expect(report(low).map((i) => i.code)).toEqual(["rule_failed", "rule_reads_cut_face", "rule_failed"]);
  });

  it("is for rules only, and keeps the parts it measures from being deleted", () => {
    expect(() => applyOp(shelfUnit(), { op: "set_param", name: "room", expr: "gap_y(shelf, side_l)", unit: "mm" })).toThrow(
      new OpError("parameter room can't use gap_x, gap_y or gap_z. They measure the parts' shapes, which are worked out after every size, so only a rule can use them"),
    );
    expect(() => applyOp(shelfUnit(), { op: "set_edge_cut", id: "side_l", cut: "slope", edge: "top", start: { at: "gap_x(side_l, side_r)" }, end: { at: "300" } })).toThrow(/can't use gap_x, gap_y or gap_z/);
    expect(() => applyOp(shelfUnit(), { op: "set_rule", id: "r", expr: "gap_x(shelf, sides) >= 0", severity: "error", message: "m" })).toThrow(
      `There's no part called "sides" for rule r, which measures to it. Check the name, or add the part first.`,
    );
    const d = applyOp(shelfUnit(), { op: "set_rule", id: "room", expr: "gap_x(side_l, side_r) >= 400", severity: "error", message: "Room" });
    expect(() => applyOp(d, { op: "delete_part", id: "side_r" })).toThrow("side_r is still used by part shelf, rule room. Change those first");
  });
});
