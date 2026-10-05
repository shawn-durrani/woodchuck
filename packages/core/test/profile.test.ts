// Cuts on an invented drawer whose sides slope from a tall back down to a
// low front, so you can see into it. Every size here is made up.

import { describe, expect, it } from "vitest";
import {
  applyOp,
  applyOps,
  cutList,
  cutListCsv,
  cutOutline,
  derive,
  emptyDesign,
  explain,
  faceAreas,
  finishSchedule,
  runChecks,
  shapeKey,
  signedArea,
  summarisePart,
  type Design,
  type Op,
} from "../src/index.js";

const drawerOps = (): Op[] => [
  { op: "define_material", id: "ply12", name: "12 mm birch ply", kind: "sheet", thickness_mm: 12, grained: true },
  { op: "set_param", name: "box_width", expr: "360", unit: "mm" },
  { op: "set_param", name: "box_depth", expr: "420", unit: "mm" },
  { op: "set_param", name: "back_height", expr: "160", unit: "mm" },
  { op: "set_param", name: "front_height", expr: "90", unit: "mm" },
  {
    op: "add_panel",
    id: "side_l",
    name: "Drawer side, left",
    material: "ply12",
    thickness_axis: "x",
    grain_axis: "z",
    x: { start: { at: "0" } },
    y: { start: { at: "0" }, size: "back_height" },
    z: { start: { at: "0" }, size: "box_depth" },
  },
  {
    op: "add_panel",
    id: "side_r",
    name: "Drawer side, right",
    material: "ply12",
    thickness_axis: "x",
    grain_axis: "z",
    x: { end: { at: "box_width" } },
    y: { start: { at: "0" }, size: "back_height" },
    z: { start: { at: "0" }, size: "box_depth" },
  },
  {
    op: "add_panel",
    id: "back",
    name: "Drawer back",
    material: "ply12",
    thickness_axis: "z",
    grain_axis: "x",
    x: { start: { face: "side_l.right" }, end: { face: "side_r.left" } },
    y: { start: { at: "0" }, size: "back_height" },
    z: { start: { face: "side_l.back" } },
  },
  {
    op: "add_panel",
    id: "front",
    name: "Drawer front",
    material: "ply12",
    thickness_axis: "z",
    grain_axis: "x",
    x: { start: { face: "side_l.right" }, end: { face: "side_r.left" } },
    y: { start: { at: "0" }, size: "front_height" },
    z: { end: { face: "side_l.front" } },
  },
  { op: "add_joint", id: "back_l", type: "dado", host: "side_l", guest: "back", depth: "4" },
  { op: "add_joint", id: "back_r", type: "dado", host: "side_r", guest: "back", depth: "4" },
  { op: "add_joint", id: "front_l", type: "dado", host: "side_l", guest: "front", depth: "4" },
  { op: "add_joint", id: "front_r", type: "dado", host: "side_r", guest: "front", depth: "4" },
  // The sides slope from the back's top to the front's, so they follow both.
  { op: "set_edge_cut", id: "side_l", cut: "slope", edge: "top", start: { face: "back.top" }, end: { face: "front.top" } },
  { op: "set_edge_cut", id: "side_r", cut: "slope", edge: "top", start: { face: "back.top" }, end: { face: "front.top" } },
];

const drawer = (more: Op[] = []): Design => applyOps(emptyDesign("Sloped drawer"), [...drawerOps(), ...more]);
const codes = (d: Design) => runChecks(d, derive(d)).issues.map((i) => `${i.severity} ${i.code}`);

describe("a sloped drawer side", () => {
  it("keeps its box as the blank, so faces and sizes read as before", () => {
    const r = derive(drawer());
    const side = r.byId.get("side_l")!;
    expect(side.nominal).toEqual({ min: [0, 0, 0], max: [12, 160, 420] });
    expect(side.box).toEqual(side.nominal);
    expect(side.cut).toEqual({ length: 420, width: 160, thickness: 12 });
    expect(r.evaluate("side_l.top").value).toBe(160);
  });

  it("slopes from the back's top to the front's, on its broad face", () => {
    const side = derive(drawer()).byId.get("side_l")!;
    expect(side.profile).toMatchObject({
      u: "y",
      v: "z",
      outline_mm: [
        [0, 0],
        [160, 0],
        [90, 420],
        [0, 420],
      ],
      edge_faces: ["back", "top", "front", "bottom"],
      holes: [],
      extensions: [],
    });
    const [cut] = side.profile!.cuts;
    expect(cut).toMatchObject({ id: "slope", kind: "slope", start_mm: 160, end_mm: 90, run_mm: 420 });
    expect(cut!.angle_deg).toBeCloseTo((Math.atan(70 / 420) * 180) / Math.PI, 9);
    expect(cut!.text).toBe("top edge sloped from 160 at the back end to 90 at the front end, 9.5°");
    expect(cut!.trace).toBe("top edge from back.top (160) at side_l.back (0) to front.top (90) at side_l.front (420)");
  });

  it("follows the front when it changes height", () => {
    const d = applyOp(drawer(), { op: "set_param", name: "front_height", expr: "110", unit: "mm" });
    const cut = derive(d).byId.get("side_l")!.profile!.cuts[0]!;
    expect(cut.end_mm).toBe(110);
    expect(cut.text).toBe("top edge sloped from 160 at the back end to 110 at the front end, 6.8°");
  });

  it("leaves the uncut parts without a profile, and the design without problems", () => {
    const d = drawer();
    const r = derive(d);
    expect(r.byId.get("back")!.profile).toBeUndefined();
    expect("profile" in r.byId.get("front")!).toBe(false);
    expect(codes(d)).toEqual([]);
  });

  it("puts the slope on the cut list, in the row and in the CSV", () => {
    const d = drawer();
    const list = cutList(d, derive(d));
    const side = list.rows.find((row) => row.parts.includes("side_l"))!;
    expect(side.shape).toEqual(["top edge sloped from 160 at the back end to 90 at the front end, 9.5°"]);
    expect(Object.keys(side)).toEqual(["row", "name", "qty", "material", "material_name", "length_mm", "width_mm", "thickness_mm", "grain", "machining", "shape", "parts"]);
    expect("shape" in list.rows.find((row) => row.parts.includes("back"))!).toBe(false);
    const csv = cutListCsv(list).split("\n");
    expect(csv[0]).toBe("Row,Name,Qty,Material,Length mm,Width mm,Thickness mm,Grain along length,Machining,Shape,Parts");
    expect(csv.find((l) => l.endsWith(",side_l"))).toContain(',"top edge sloped from 160 at the back end to 90 at the front end, 9.5°",side_l');
  });

  it("explains and summarises the cut", () => {
    const d = drawer();
    const r = derive(d);
    const lines = explain(d, r, "side_l");
    expect(lines).toContain("Cut slope: top edge sloped from 160 at the back end to 90 at the front end, 9.5°");
    expect(lines).toContain("  top edge from back.top (160) at side_l.back (0) to front.top (90) at side_l.front (420)");
    expect(summarisePart(r.byId.get("side_l")!).shape).toEqual(["top edge sloped from 160 at the back end to 90 at the front end, 9.5°"]);
    expect(summarisePart(r.byId.get("back")!).shape).toBeUndefined();
  });

  it("counts the faces the slope leaves for the finish", () => {
    const d = applyOp(drawer(), { op: "set_finish", targets: ["side_l"], finish: "natur" });
    const side = derive(d).byId.get("side_l")!;
    const areas = faceAreas(side);
    const broad = ((160 + 90) / 2) * 420;
    expect(areas.left).toBe(broad);
    expect(areas.right).toBe(broad);
    expect(areas.back).toBe(160 * 12);
    expect(areas.front).toBe(90 * 12);
    expect(areas.bottom).toBe(420 * 12);
    expect(areas.top).toBeCloseTo(Math.hypot(70, 420) * 12, 9);
    const sum = Object.values(areas).reduce((s, a) => s + a, 0);
    expect(finishSchedule(d, derive(d).parts)[0]!.area_m2).toBe(Math.round((sum / 1e6) * 100) / 100);
    expect(finishSchedule(d, derive(d).parts)[0]!.area_m2).toBe(0.12);
  });
});

describe("cuts on copies and housed ends", () => {
  it("solves an original once and shares it with its copies", () => {
    const d = drawer([
      { op: "set_array", id: "stack", parts: ["side_l", "side_r", "back", "front"], axis: "y", count: "3", pitch: "back_height + 20" },
      { op: "set_edge_cut", id: "side_l", cut: "nothing", edge: "top", start: { at: "1000" }, end: { at: "1000" } },
    ]);
    const r = derive(d);
    expect(r.byId.get("side_l#3")!.profile).toEqual(r.byId.get("side_l")!.profile);
    expect(r.issues.filter((i) => i.code === "cut_removes_nothing").map((i) => i.parts)).toEqual([["side_l"]]);
    const row = cutList(d, r).rows.find((x) => x.parts.includes("side_l"))!;
    expect(row.qty).toBe(3);
    expect(row.parts).toEqual(["side_l", "side_l#2", "side_l#3"]);
  });

  it("sends a housed end into its host only where no cut has touched it", () => {
    // A notch out of the back's top left corner, run on past its edges for a clean cut.
    const d = drawer([
      {
        op: "set_cutout",
        id: "back",
        cut: "handle",
        shape: "rect",
        x: { start: { face: "back.left", offset: "-5" }, size: "35" },
        y: { start: { face: "back.top", offset: "-40" }, size: "45" },
      },
    ]);
    const r = derive(d);
    const back = r.byId.get("back")!;
    expect(back.cut.length).toBe(344);
    expect(back.profile!.extensions).toEqual([
      { joint: "back_l", face: "left", depth_mm: 4, along_mm: [[0, 120]] },
      { joint: "back_r", face: "right", depth_mm: 4, along_mm: [[0, 160]] },
    ]);
    expect(back.profile!.cuts[0]!.text).toBe("30 × 40 notch out of the top left corner");
    const cut = cutOutline(back)!;
    expect(signedArea(cut.outline)).toBe(336 * 160 - 30 * 40 + 4 * 120 + 4 * 160);
    expect(explain(d, r, "back")).toContain("Joint back_l takes the left end only from 0 to 120 along y, where no cut has touched it");
    expect(codes(d)).toEqual([]);
  });
});

describe("the shapes a cut can make", () => {
  const sideWith = (cut: Op) => derive(drawer([cut])).byId.get("side_l")!.profile!;

  it("comes to a point when the slope runs through the far corner", () => {
    const p = sideWith({ op: "set_edge_cut", id: "side_l", cut: "slope", edge: "top", start: { at: "160" }, end: { at: "0" } });
    expect(p.outline_mm).toEqual([
      [0, 0],
      [160, 0],
      [0, 420],
    ]);
    expect(p.cuts[0]!.text).toBe("top edge sloped from 160 at the back end to 0 at the front end, 20.9°");
  });

  it("cuts a corner off when the line leaves the edge before the far end", () => {
    const p = sideWith({
      op: "set_edge_cut",
      id: "side_l",
      cut: "slope",
      edge: "top",
      start: { face: "side_l.top" },
      start_along: { face: "side_l.front", offset: "-40" },
      end: { face: "side_l.top", offset: "-30" },
    });
    expect(p.cuts[0]).toMatchObject({ kind: "chamfer", start_mm: 160, end_mm: 130, run_mm: 40 });
    expect(p.cuts[0]!.text).toBe("top front corner cut off 40 along the top edge and 30 along the front end, 36.9°");
    expect(p.outline_mm).toHaveLength(5);
  });

  it("calls a round cutout crossing the bottom edge a notch, and one inside a hole", () => {
    const notch = sideWith({ op: "set_cutout", id: "side_l", cut: "pull", shape: "circle", centre: { y: { at: "10" }, z: { at: "200" } }, diameter: "30" });
    expect(notch.cuts[1]).toMatchObject({ kind: "notch", text: "30 mm round notch in the bottom edge, centre 200 from the back and 10 from the bottom" });
    expect(notch.holes).toEqual([]);
    const hole = sideWith({ op: "set_cutout", id: "side_l", cut: "pull", shape: "circle", centre: { y: { at: "50" }, z: { at: "200" } }, diameter: "30" });
    expect(hole.cuts[1]).toMatchObject({ kind: "hole", text: "30 mm hole, centre 200 from the back and 50 from the bottom" });
    expect(hole.holes).toHaveLength(1);
    expect(hole.holes[0]!.circle).toEqual({ centre_mm: [50, 200], diameter_mm: 30 });
    expect(signedArea(hole.holes[0]!.points_mm)).toBeLessThan(0);
  });

  it("notches a corner, sized on the wood it takes", () => {
    const p = sideWith({
      op: "set_cutout",
      id: "side_l",
      cut: "kick",
      shape: "rect",
      y: { start: { at: "-5" }, end: { at: "40" } },
      z: { start: { at: "380" }, end: { face: "side_l.front", offset: "10" } },
    });
    expect(p.cuts.map((c) => [c.kind, c.text])).toEqual([
      ["slope", "top edge sloped from 160 at the back end to 90 at the front end, 9.5°"],
      ["notch", "40 × 40 notch out of the bottom front corner"],
    ]);
    expect(p.edge_faces).toEqual(["back", "top", "front", "bottom", "front", "bottom"]);
  });
});

describe("problems with cuts", () => {
  const problems = (cut: Op) => {
    const d = drawer([cut]);
    return derive(d).issues.map((i) => ({ severity: i.severity, code: i.code, message: i.message, parts: i.parts }));
  };

  it("warns when a cut misses the wood", () => {
    expect(problems({ op: "set_edge_cut", id: "side_l", cut: "high", edge: "top", start: { face: "back.top", offset: "10" }, end: { at: "200" } })).toEqual([
      {
        severity: "warning",
        code: "cut_removes_nothing",
        message: "Cut high on side_l: its line misses the wood, so it takes nothing off. Check where it starts and ends",
        parts: ["side_l"],
      },
    ]);
    expect(problems({ op: "set_cutout", id: "back", cut: "far", shape: "circle", centre: { x: { at: "-50" }, y: { at: "50" } }, diameter: "20" })[0]).toMatchObject({
      code: "cut_removes_nothing",
      message: "Cut far on back: it misses the wood, so it takes nothing off. Check where it sits",
    });
  });

  it("refuses a line whose two points sit at the same place", () => {
    expect(
      problems({ op: "set_edge_cut", id: "side_l", cut: "bad", edge: "top", start: { at: "100" }, end: { at: "50" }, start_along: { at: "200" }, end_along: { at: "200" } }),
    ).toEqual([
      {
        severity: "error",
        code: "cut_error",
        message: "Cut bad on side_l: its two points sit at the same place along z (200), so they don't make a line. Move start_along or end_along apart",
        parts: ["side_l"],
      },
    ]);
  });

  it("refuses a cut that takes the whole part", () => {
    expect(problems({ op: "set_edge_cut", id: "side_r", cut: "slope", edge: "top", start: { at: "-10" }, end: { at: "-10" } })[0]).toMatchObject({
      severity: "error",
      code: "cut_error",
      message: "Cut slope on side_r: it takes off the whole of side_r. Check where it starts and ends",
    });
  });

  it("refuses sizes that work out to nothing", () => {
    expect(problems({ op: "set_cutout", id: "back", cut: "dot", shape: "circle", centre: { x: { at: "50" }, y: { at: "50" } }, diameter: "front_height - 90" })[0]).toMatchObject({
      code: "cut_error",
      message: "Cut dot on back: its diameter works out to 0 mm. It needs to be more than nothing",
    });
    expect(
      problems({ op: "set_cutout", id: "back", cut: "slot", shape: "rect", x: { start: { at: "50" }, size: "60" }, y: { start: { at: "50" }, size: "20" }, radius: "12" })[0],
    ).toMatchObject({ code: "cut_error", message: "Cut slot on back: its corner radius of 12 mm is more than half its narrower side (10 mm)" });
  });

  it("refuses cuts that split a part in two", () => {
    const found = problems({ op: "set_cutout", id: "back", cut: "split", shape: "rect", x: { start: { at: "100" }, size: "20" }, y: { start: { at: "-5" }, end: { at: "200" } } });
    expect(found).toEqual([
      {
        severity: "error",
        code: "cut_severs",
        message: "The cuts on back split it into 2 pieces. A part has to stay in one piece, so move the cutouts or make each piece a part of its own",
        parts: ["back"],
      },
    ]);
    const back = derive(drawer([{ op: "set_cutout", id: "back", cut: "split", shape: "rect", x: { start: { at: "100" }, size: "20" }, y: { start: { at: "-5" }, end: { at: "200" } } }])).byId.get("back")!;
    expect(back.profile!.cuts[0]!.text).toBe("20 × 160 notch right across the width, 88 from the left and 0 from the bottom");
  });
});

describe("shapes on the cut list", () => {
  // Plain boards with no machining, so only their shapes tell them apart.
  const board = (id: string, y0: number): Op => ({
    op: "add_panel",
    id,
    name: "Shelf end",
    material: "ply12",
    thickness_axis: "x",
    grain_axis: "z",
    x: { start: { at: "0" } },
    y: { start: { at: String(y0) }, size: "100" },
    z: { start: { at: "0" }, size: "300" },
  });
  const slope = (id: string, start: string, end: string): Op => ({
    op: "set_edge_cut",
    id,
    cut: "slope",
    edge: "top",
    start: { face: `${id}.top`, offset: start },
    end: { face: `${id}.top`, offset: end },
  });
  const boards = applyOps(emptyDesign("Shelf ends"), [
    { op: "define_material", id: "ply12", name: "12 mm birch ply", kind: "sheet", thickness_mm: 12, grained: true },
    board("a", 0),
    board("b", 200),
    board("c", 400),
    board("d", 600),
    slope("a", "0", "-40"),
    slope("b", "0", "-40"),
    slope("c", "-40", "0"),
  ]);

  it("groups the same shape, and keeps a mirror image and an uncut blank apart", () => {
    const r = derive(boards);
    expect(shapeKey(r.byId.get("a")!)).toBe(shapeKey(r.byId.get("b")!));
    expect(shapeKey(r.byId.get("a")!)).not.toBe(shapeKey(r.byId.get("c")!));
    expect(shapeKey(r.byId.get("d")!)).toBe("");
    const rows = cutList(boards, r).rows.map((row) => [row.qty, row.parts.join(" "), row.shape ?? []]);
    expect(rows).toEqual([
      [2, "a b", ["top edge sloped from 100 at the back end to 60 at the front end, 7.6°"]],
      [1, "c", ["top edge sloped from 60 at the back end to 100 at the front end, 7.6°"]],
      [1, "d", []],
    ]);
  });

  it("keys the shape in the part's own length and width, wherever it sits", () => {
    expect(shapeKey(derive(boards).byId.get("a")!)).toBe("0,0 0,100 300,60 300,0");
  });
});
