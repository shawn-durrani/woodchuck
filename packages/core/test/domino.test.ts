// Issue #63: a Domino joint cuts matching mortises in both parts for a
// bought beech tenon, and lists the tenons on the hardware list. Issue #89:
// every mortise in the loose piece, the host unless the joint says the
// guest, takes the fit as play, 6 mm unless the joint gives one, and the
// other piece's are tight. The pieces are invented: a bedside carcass in
// 18 mm ply, 450 wide, 500 tall and 300 deep, with its top on the sides and
// its bottom between them, and a face frame whose 60 mm rail meets a 45 mm
// stile.

import { describe, expect, it } from "vitest";
import {
  applyOp,
  applyOps,
  cutList,
  derive,
  DOMINO_SIZES,
  dominoDepthStops,
  dominoGuestDepth,
  emptyDesign,
  jointExample,
  runChecks,
  workshopDrawings,
  type Design,
  type Op,
} from "../src/index.js";

const ply = (id: string, t: number): Op => ({ op: "define_material", id, name: `${t} mm birch ply`, kind: "sheet", thickness_mm: t, grained: true });
const build = (ops: Op[]): Design => applyOps(emptyDesign("Bedside carcass"), ops);
const problems = (d: Design) =>
  runChecks(d, derive(d))
    .issues.filter((i) => i.code !== "floating")
    .map((i) => i.message);
const regions = (d: Design, part: string, joint: string) =>
  derive(d)
    .byId.get(part)!
    .machining.filter((m) => m.joint === joint)
    .map((m) => [m.region.min, m.region.max]);

const carcass: Op[] = [
  ply("ply18", 18),
  { op: "add_panel", id: "top", name: "Top", material: "ply18", thickness_axis: "y", grain_axis: "x", x: { start: { at: "0" }, size: "450" }, y: { start: { at: "500" } }, z: { start: { at: "0" }, size: "300" } },
  { op: "add_panel", id: "side_l", name: "Side", material: "ply18", thickness_axis: "x", grain_axis: "y", x: { start: { at: "0" } }, y: { start: { at: "0" }, end: { face: "top.bottom" } }, z: { start: { at: "0" }, size: "300" } },
  { op: "add_panel", id: "side_r", name: "Side", material: "ply18", thickness_axis: "x", grain_axis: "y", x: { end: { at: "450" } }, y: { start: { at: "0" }, end: { face: "top.bottom" } }, z: { start: { at: "0" }, size: "300" } },
  {
    op: "add_panel",
    id: "bottom",
    name: "Bottom",
    material: "ply18",
    thickness_axis: "y",
    grain_axis: "x",
    x: { start: { face: "side_l.right" }, end: { face: "side_r.left" } },
    y: { start: { at: "60" } },
    z: { start: { at: "0" }, size: "300" },
  },
];
const carcassJoints: Op[] = [
  { op: "add_joint", id: "top_l", type: "domino", host: "top", guest: "side_l" },
  { op: "add_joint", id: "top_r", type: "domino", host: "top", guest: "side_r" },
  { op: "add_joint", id: "bottom_l", type: "domino", host: "side_l", guest: "bottom", thickness: "5", count: 4 },
  { op: "add_joint", id: "bottom_r", type: "domino", host: "side_r", guest: "bottom", thickness: "5", count: 4 },
];
/** The carcass with the bottom's joint on the left given these fields. */
const bottomWith = (fields: Record<string, unknown>) => build([...carcass, { op: "add_joint", id: "bottom_l", type: "domino", host: "side_l", guest: "bottom", ...fields } as Op]);

/** A face frame's stile and the rail that meets its edge, in stock of this thickness. */
const frame = (t: number, joint: Record<string, unknown> = {}): Design =>
  build([
    ply("stock", t),
    { op: "add_panel", id: "stile", name: "Stile", material: "stock", thickness_axis: "z", grain_axis: "y", x: { start: { at: "0" }, size: "45" }, y: { start: { at: "0" }, size: "600" }, z: { start: { at: "0" } } },
    { op: "add_panel", id: "rail", name: "Rail", material: "stock", thickness_axis: "z", grain_axis: "x", x: { start: { face: "stile.right" }, size: "300" }, y: { start: { at: "300" }, size: "60" }, z: { start: { at: "0" } } },
    { op: "add_joint", id: "rail_l", type: "domino", host: "stile", guest: "rail", ...joint } as Op,
  ]);

describe("a Domino's sizes", () => {
  it("are Festool's DF 500 range, with the machine's depth stops", () => {
    expect(DOMINO_SIZES.map((s) => [s.thickness_mm, s.width_mm, s.length_mm, s.library_part])).toEqual([
      [4, 16.6, 20, "festool-domino-beech-4x20"],
      [5, 18.8, 30, "festool-domino-beech-5x30"],
      [6, 19.8, 40, "festool-domino-beech-6x40"],
      [8, 21.9, 40, "festool-domino-beech-8x40"],
      [8, 21.9, 50, "festool-domino-beech-8x50"],
      [10, 23.9, 50, "festool-domino-beech-10x50"],
    ]);
    expect([4, 5, 6, 8, 10].map(dominoDepthStops)).toEqual([[10], [12, 15, 20], [12, 15, 20, 25, 28], [12, 15, 20, 25, 28], [12, 15, 20, 25, 28]]);
    // The guest's mortise takes the rest of the tenon, at the next stop.
    expect(dominoGuestDepth({ thickness: 5, length: 30, depth: 12 })).toBe(20);
    expect(dominoGuestDepth({ thickness: 6, length: 40, depth: 20 })).toBe(20);
    expect(dominoGuestDepth({ thickness: 8, length: 50, depth: 12 })).toBeUndefined();
  });
});

describe("Dominos in a carcass", () => {
  const d = build([...carcass, ...carcassJoints]);
  const r = derive(d);

  it("take a size that suits the stock, and depths the DF 500 can cut", () => {
    const top = r.joints.find((j) => j.id === "top_l")!;
    // A third of 18 mm is 6, and a 20 mm mortise would leave 2 mm of the top, so the host gets 12 and the side 28.
    expect(top.params).toEqual({ count: 3, thickness: 6, length: 40, depth: 12, fit: 6 });
    expect(top.defaulted).toEqual(["count", "thickness", "length", "depth", "fit"]);
    expect(r.joints.find((j) => j.id === "bottom_l")!.params).toEqual({ thickness: 5, count: 4, length: 30, depth: 12, fit: 6 });
  });

  it("cut matching mortises in both parts, with play in every one of the host's", () => {
    // The top's three, each 6 mm longer than the tenon is wide, the front one too.
    expect(regions(d, "top", "top_l")).toEqual([
      [
        [6, 500, 37.1],
        [12, 512, 62.9],
      ],
      [
        [6, 500, 137.1],
        [12, 512, 162.9],
      ],
      [
        [6, 500, 237.1],
        [12, 512, 262.9],
      ],
    ]);
    // The side's top end takes the rest of each tenon, tight, centred on its 18 mm.
    expect(regions(d, "side_l", "top_l")).toEqual([
      [
        [6, 472, 40.1],
        [12, 500, 59.9],
      ],
      [
        [6, 472, 140.1],
        [12, 500, 159.9],
      ],
      [
        [6, 472, 240.1],
        [12, 500, 259.9],
      ],
    ]);
    const side = r.byId.get("side_l")!.machining.filter((m) => m.joint === "bottom_l");
    expect(side.map((m) => [m.depth_mm, m.width_mm, m.length_mm, m.play_mm ?? 0])).toEqual([
      [12, 5, 24.8, 6],
      [12, 5, 24.8, 6],
      [12, 5, 24.8, 6],
      [12, 5, 24.8, 6],
    ]);
    expect(side.map((m) => [m.region.min[2], m.region.max[2]])).toEqual([
      [25.1, 49.9],
      [100.1, 124.9],
      [175.1, 199.9],
      [250.1, 274.9],
    ]);
    const bottom = r.byId.get("bottom")!.machining.filter((m) => m.joint === "bottom_l");
    expect(bottom.map((m) => [m.region.min, m.region.max])).toEqual([
      [
        [18, 66.5, 28.1],
        [38, 71.5, 46.9],
      ],
      [
        [18, 66.5, 103.1],
        [38, 71.5, 121.9],
      ],
      [
        [18, 66.5, 178.1],
        [38, 71.5, 196.9],
      ],
      [
        [18, 66.5, 253.1],
        [38, 71.5, 271.9],
      ],
    ]);
    // Each pair lines up: the same middle along the joint and across the thickness.
    for (const [h, g] of side.map((m, k) => [m.region, bottom[k]!.region] as const)) {
      expect((h.min[2] + h.max[2]) / 2).toBeCloseTo((g.min[2] + g.max[2]) / 2, 9);
      expect([h.min[1], h.max[1]]).toEqual([g.min[1], g.max[1]]);
    }
  });

  it("change no part's size, and leave no problem", () => {
    expect(r.parts.map((p) => [p.id, p.cut.length, p.cut.width])).toEqual([
      ["top", 450, 300],
      ["side_l", 500, 300],
      ["side_r", 500, 300],
      ["bottom", 414, 300],
    ]);
    expect(problems(d)).toEqual([]);
  });

  it("put a tenon in each pair, the length of the Domino", () => {
    const tenons = r.joints.find((j) => j.id === "bottom_l")!.features.filter((f) => f.kind === "tongue");
    expect(tenons).toHaveLength(4);
    expect(tenons[0]).toEqual({ kind: "tongue", part: "bottom", box: { min: [8, 66.5, 28.1], max: [38, 71.5, 46.9] } });
  });

  it("place every mortise on the cut list", () => {
    const rows = cutList(d, r).rows;
    expect(rows.find((x) => x.parts.includes("bottom"))!.machining).toEqual([
      "Domino mortise 5 wide × 18.8 long × 20 deep, tight, in the left end for side_l centred at (0,9,112.5)",
      "Domino mortise 5 wide × 18.8 long × 20 deep, tight, in the left end for side_l centred at (0,9,187.5)",
      "Domino mortise 5 wide × 18.8 long × 20 deep, tight, in the left end for side_l centred at (0,9,262.5)",
      "Domino mortise 5 wide × 18.8 long × 20 deep, tight, in the left end for side_l centred at (0,9,37.5)",
      "Domino mortise 5 wide × 18.8 long × 20 deep, tight, in the right end for side_r centred at (414,9,112.5)",
      "Domino mortise 5 wide × 18.8 long × 20 deep, tight, in the right end for side_r centred at (414,9,187.5)",
      "Domino mortise 5 wide × 18.8 long × 20 deep, tight, in the right end for side_r centred at (414,9,262.5)",
      "Domino mortise 5 wide × 18.8 long × 20 deep, tight, in the right end for side_r centred at (414,9,37.5)",
    ]);
    expect(rows.find((x) => x.parts.includes("top"))!.machining).toContain("Domino mortise 6 wide × 25.8 long × 12 deep, 6 mm play, in the bottom face for side_l centred at (9,0,50)");
    expect(rows.find((x) => x.parts.includes("top"))!.machining).toContain("Domino mortise 6 wide × 25.8 long × 12 deep, 6 mm play, in the bottom face for side_l centred at (9,0,250)");
  });

  it("list the tenons to buy, as library parts counted from the joints", () => {
    expect(cutList(d, r).hardware).toEqual([
      {
        name: "Festool DOMINO tenon, beech, 6 × 40 mm",
        kind: "fixing",
        qty: 6,
        spec: "thickness_mm 6, width_mm 19.8, length_mm 40",
        ids: ["top_l", "top_r"],
        library_part: "festool-domino-beech-6x40",
      },
      {
        name: "Festool DOMINO tenon, beech, 5 × 30 mm",
        kind: "fixing",
        qty: 8,
        spec: "thickness_mm 5, width_mm 18.8, length_mm 30",
        ids: ["bottom_l", "bottom_r"],
        library_part: "festool-domino-beech-5x30",
      },
    ]);
  });

  it("count the tenons on every copy of an array", () => {
    const shelves = applyOps(d, [
      { op: "add_panel", id: "shelf", name: "Shelf", material: "ply18", thickness_axis: "y", grain_axis: "x", x: { start: { face: "side_l.right" }, end: { face: "side_r.left" } }, y: { start: { at: "200" } }, z: { start: { at: "0" }, size: "300" } },
      { op: "set_array", id: "shelves", parts: ["shelf"], axis: "y", count: "2", pitch: "150" },
      { op: "add_joint", id: "shelf_l", type: "domino", host: "side_l", guest: "shelf" },
      { op: "add_joint", id: "shelf_r", type: "domino", host: "side_r", guest: "shelf" },
    ]);
    const hw = cutList(shelves, derive(shelves)).hardware;
    expect(hw.map((h) => [h.name, h.qty, h.ids])).toEqual([
      ["Festool DOMINO tenon, beech, 6 × 40 mm", 18, ["top_l", "top_r", "shelf_l", "shelf_l#2", "shelf_r", "shelf_r#2"]],
      ["Festool DOMINO tenon, beech, 5 × 30 mm", 8, ["bottom_l", "bottom_r"]],
    ]);
    expect(problems(shelves)).toEqual([]);
  });
});

describe("a Domino in a face frame", () => {
  it("goes half its length into the stile's edge and half into the rail's end", () => {
    const d = frame(20);
    const j = derive(d).joints[0]!;
    // One Domino gets play in the host too, so the stile's mortise is 6 mm longer than the rail's.
    expect(j.params).toEqual({ count: 1, thickness: 6, length: 40, depth: 20, fit: 6 });
    expect(regions(d, "stile", "rail_l")).toEqual([
      [
        [25, 317.1, 7],
        [45, 342.9, 13],
      ],
    ]);
    expect(regions(d, "rail", "rail_l")).toEqual([
      [
        [45, 320.1, 7],
        [65, 339.9, 13],
      ],
    ]);
    expect(j.features.find((f) => f.kind === "tongue")!.box).toEqual({ min: [25, 320.1, 7], max: [65, 339.9, 13] });
    expect(problems(d)).toEqual([]);
  });

  it("warns of a Domino more than half the stock's thickness", () => {
    const d = frame(18, { thickness: "10" });
    expect(derive(d).joints[0]!.params).toMatchObject({ thickness: 10, length: 50, depth: 25 });
    expect(problems(d)).toEqual([
      "rail_l (domino (loose tenon) joining rail to stile): A 10 mm Domino is more than half of 18 mm stock. About a third of the thickness is usual, so use 6 mm",
    ]);
  });

  it("refuses more Dominos than the joint has room for", () => {
    expect(problems(frame(20, { count: 4 }))).toEqual([
      "Joint rail_l: 4 Dominos don't fit along the joint, since their mortises in stile run into each other. Use fewer",
      "Joint rail_l: a Domino mortise breaks out of rail's bottom edge. Use fewer Dominos or a smaller size",
      "Joint rail_l: 4 Dominos don't fit along the joint, since their mortises in rail run into each other. Use fewer",
    ]);
    // Two fit, though the play in the stile's mortises leaves thin wood between them, and tight ones leave enough.
    expect(problems(frame(20, { count: 2 }))).toEqual([
      "Joint rail_l: 4.2 mm of stile is left between two Domino mortises, and wood that thin breaks out. Leave at least 5 mm, with fewer Dominos",
    ]);
    expect(problems(frame(20, { count: 2, fit: "0" }))).toEqual([]);
  });

  it("warns of a mortise near an edge, and of thin wood between two", () => {
    expect(problems(frame(20, { count: 2, thickness: "8" }))).toEqual([
      "Joint rail_l: 2.1 mm of stile is left between two Domino mortises, and wood that thin breaks out. Leave at least 5 mm, with fewer Dominos",
      "Joint rail_l: a Domino mortise is 4.05 mm from rail's bottom edge, and wood that thin breaks out. Leave at least 5 mm, with fewer Dominos or a smaller size",
    ]);
    expect(problems(frame(20, { count: 3, thickness: "4" }))).toContainEqual(
      "Joint rail_l: 3.4 mm of rail is left between two Domino mortises, and wood that thin breaks out. Leave at least 5 mm, with fewer Dominos",
    );
  });

  it("refuses a cut that breaks into a mortise", () => {
    const d = applyOp(frame(20), { op: "set_cutout", id: "rail", cut: "hole", shape: "circle", centre: { x: { at: "60" }, y: { at: "330" } }, diameter: "8" });
    expect(problems(d)).toEqual(["Joint rail_l: cut hole on rail breaks into a Domino mortise for stile. A mortise needs wood all round, so move the cut clear of it"]);
    const clear = applyOp(frame(20), { op: "set_cutout", id: "rail", cut: "hole", shape: "circle", centre: { x: { at: "200" } , y: { at: "330" } }, diameter: "8" });
    expect(problems(clear)).toEqual([]);
  });
});

describe("a Domino's checks", () => {
  const joint = (fields: Record<string, unknown>) => problems(bottomWith(fields));

  it("warn of a mortise that leaves under 5 mm behind it, and refuse one that comes out the far side", () => {
    expect(joint({ thickness: "5", depth: "15" })).toEqual([
      "bottom_l (domino (loose tenon) joining bottom to side_l): The mortise in the host is 15 mm deep in 18 mm, which leaves 3 mm behind it. Leave at least 5 mm, with a shallower mortise or a smaller Domino",
    ]);
    expect(joint({ thickness: "5", depth: "20" })).toEqual([
      "bottom_l (domino (loose tenon) joining bottom to side_l): The mortise in the host is 20 mm deep and the host is 18 mm deep there, so it comes out the far side. Use a shallower mortise or a shorter Domino",
    ]);
  });

  it("warn of thin walls beside the mortise in thin stock", () => {
    const d = build([
      ...carcass.slice(0, 4),
      ply("ply12", 12),
      { op: "add_panel", id: "bottom", name: "Bottom", material: "ply12", thickness_axis: "y", grain_axis: "x", x: { start: { face: "side_l.right" }, end: { face: "side_r.left" } }, y: { start: { at: "60" } }, z: { start: { at: "0" }, size: "300" } },
      { op: "add_joint", id: "bottom_l", type: "domino", host: "side_l", guest: "bottom" },
    ]);
    // A third of 12 mm is 4, the thinnest Domino, which goes 10 mm into each part.
    expect(derive(d).joints[0]!.params).toEqual({ count: 3, thickness: 4, length: 20, depth: 10, fit: 6 });
    expect(problems(d)).toEqual([
      "bottom_l (domino (loose tenon) joining bottom to side_l): A 4 mm Domino leaves 4 mm of the guest beside its mortise. Leave at least 5 mm, with thicker stock, or dowels",
    ]);
  });

  it("warn of a depth the DF 500 has no stop for, and refuse a guest it can't reach", () => {
    expect(problems(frame(20, { depth: "13" }))).toEqual([
      "rail_l (domino (loose tenon) joining rail to stile): The DF 500 stops at 12, 15, 20, 25 and 28 mm deep with the 6 mm cutter, so it can't cut a 13 mm mortise in the host. Use one of those depths",
    ]);
    expect(derive(frame(20, { depth: "13" })).byId.get("rail")!.machining[0]!.depth_mm).toBe(28);
    expect(problems(frame(30, { thickness: "8", length: "50", depth: "12" }))).toEqual([
      "rail_l (domino (loose tenon) joining rail to stile): With 12 mm of the 50 mm Domino in the host, the guest needs a mortise 38 mm deep, and the DF 500 goes 28 mm at most with the 8 mm cutter. Go deeper in the host, or use a shorter Domino",
    ]);
  });

  it("refuse a size or a fit worked out from parameters that the DF 500 can't cut", () => {
    const withParams = (t: string, fit: string) =>
      problems(
        applyOps(frame(20), [
          { op: "set_param", name: "dom_t", expr: t, unit: "mm" },
          { op: "set_param", name: "dom_fit", expr: fit, unit: "mm" },
          { op: "delete_joint", id: "rail_l" },
          { op: "add_joint", id: "rail_l", type: "domino", host: "stile", guest: "rail", thickness: "dom_t", fit: "dom_fit" },
        ]),
      );
    expect(withParams("7", "0")).toEqual([
      "rail_l (domino (loose tenon) joining rail to stile): There's no Domino 7 mm thick for the DF 500. Its beech tenons are 4 × 20, 5 × 30, 6 × 40, 8 × 40, 8 × 50 and 10 × 50 mm, thickness by length",
    ]);
    expect(withParams("6", "3")).toEqual([
      "rail_l (domino (loose tenon) joining rail to stile): The DF 500 cuts a mortise as wide as the tenon, or 6 or 10 mm wider for play, so the fit is 0, 6 or 10, not 3",
    ]);
  });

  it("refuse a mortise that runs into another joint's machining", () => {
    const d = build([
      ...carcass,
      { op: "add_panel", id: "shelf", name: "Shelf", material: "ply18", thickness_axis: "y", grain_axis: "x", x: { start: { face: "side_l.right" }, end: { face: "side_r.left" } }, y: { start: { at: "250" } }, z: { start: { at: "0" }, size: "300" } },
      { op: "add_joint", id: "shelf_dado", type: "dado", host: "side_l", guest: "shelf" },
      { op: "add_joint", id: "shelf_dom", type: "domino", host: "side_l", guest: "shelf" },
    ]);
    expect(problems(d)).toEqual([
      "Joint shelf_dom: a Domino mortise in side_l runs into the dado for shelf, from joint shelf_dado. Move the Dominos clear of it, or use fewer",
    ]);
  });

  it("refuse a size Festool doesn't make, and a fit that isn't a joiner setting, as the edit", () => {
    const add = (fields: Record<string, unknown>) => () => bottomWith(fields);
    expect(add({ thickness: "5", length: "40" })).toThrow(
      "There's no Domino 5 mm thick and 40 mm long for the DF 500. Its beech tenons are 4 × 20, 5 × 30, 6 × 40, 8 × 40, 8 × 50 and 10 × 50 mm, thickness by length",
    );
    expect(add({ length: "35" })).toThrow("There's no Domino 35 mm long for the DF 500");
    expect(add({ fit: "3" })).toThrow("A Domino's fit is the joiner's width setting for the loose piece's mortises: 6 or 10 for play along the joint, or 0 for tight in both pieces, not 3");
    expect(add({ shoulder: "5" })).toThrow("shoulder only applies to tongue, dado_rabbet and mortise_tenon joints");
    expect(() => applyOp(build(carcass), { op: "add_joint", id: "j", type: "screws", host: "side_l", guest: "bottom", thickness: "5" })).toThrow(
      "thickness only applies to tongue, dado_rabbet, mortise_tenon and domino joints",
    );
  });
});

describe("a Domino's loose piece", () => {
  /** The face frame's mortises, in the stile and then the rail, as [length, play]. */
  const cuts = (d: Design) => {
    const r = derive(d);
    return ["stile", "rail"].map((p) => r.byId.get(p)!.machining.map((m) => [m.length_mm, m.play_mm ?? 0]));
  };
  const lines = (d: Design) => cutList(d, derive(d)).rows.map((x) => x.machining);

  it("is the host when the joint leaves it out, so one Domino's host mortise is 6 mm longer and its guest's tight", () => {
    const d = frame(20);
    expect(d.joints[0]!.loose).toBeUndefined();
    expect(derive(d).joints[0]!.loose).toBe("host");
    expect(cuts(d)).toEqual([[[25.8, 6]], [[19.8, 0]]]);
    expect(lines(d)).toEqual([
      ["Domino mortise 6 wide × 25.8 long × 20 deep, 6 mm play, in the right edge for rail centred at (45,330,10)"],
      ["Domino mortise 6 wide × 19.8 long × 20 deep, tight, in the left end for stile centred at (0,30,10)"],
    ]);
  });

  it("goes in the guest when the joint says so, with the host's mortise tight and the tenons to buy the same", () => {
    const d = frame(20, { loose: "guest" });
    const r = derive(d);
    expect(d.joints[0]!.loose).toBe("guest");
    expect(r.joints[0]!.loose).toBe("guest");
    expect(cuts(d)).toEqual([[[19.8, 0]], [[25.8, 6]]]);
    expect(regions(d, "rail", "rail_l")).toEqual([
      [
        [45, 317.1, 7],
        [65, 342.9, 13],
      ],
    ]);
    // The tenon is as it was, centred in both mortises.
    expect(r.joints[0]!.features.find((f) => f.kind === "tongue")!.box).toEqual({ min: [25, 320.1, 7], max: [65, 339.9, 13] });
    expect(lines(d)).toEqual([
      ["Domino mortise 6 wide × 19.8 long × 20 deep, tight, in the right edge for rail centred at (45,330,10)"],
      ["Domino mortise 6 wide × 25.8 long × 20 deep, 6 mm play, in the left end for stile centred at (0,30,10)"],
    ]);
    expect(cutList(d, r).hardware).toEqual(cutList(frame(20), derive(frame(20))).hardware);
    expect(problems(d)).toEqual([]);
  });

  it("puts the play in every mortise of a carcass bottom that's the guest", () => {
    const d = bottomWith({ thickness: "5", count: 4, loose: "guest" });
    const r = derive(d);
    const mortises = (part: string) => r.byId.get(part)!.machining.map((m) => [m.length_mm, m.play_mm ?? 0]);
    expect(mortises("side_l")).toEqual(Array(4).fill([18.8, 0]));
    expect(mortises("bottom")).toEqual(Array(4).fill([24.8, 6]));
    expect(cutList(d, r).rows.find((x) => x.parts.includes("bottom"))!.machining[0]).toBe(
      "Domino mortise 5 wide × 24.8 long × 20 deep, 6 mm play, in the left end for side_l centred at (0,9,112.5)",
    );
    expect(problems(d)).toEqual([]);
  });

  it("is tight in both pieces with a fit of 0, and on the widest setting with 10", () => {
    expect(cuts(frame(20, { fit: "0" }))).toEqual([[[19.8, 0]], [[19.8, 0]]]);
    expect(cuts(frame(20, { fit: "0", loose: "guest" }))).toEqual([[[19.8, 0]], [[19.8, 0]]]);
    expect(cuts(frame(20, { fit: "10" }))).toEqual([[[29.8, 10]], [[19.8, 0]]]);
    expect(cuts(frame(20, { fit: "10", loose: "guest" }))).toEqual([[[19.8, 0]], [[29.8, 10]]]);
    expect(lines(frame(20, { fit: "10" }))[0]).toEqual(["Domino mortise 6 wide × 29.8 long × 20 deep, 10 mm play, in the right edge for rail centred at (45,330,10)"]);
  });

  it("is checked as it's cut, so play in the guest brings its mortises nearer its edge and each other", () => {
    expect(problems(frame(20, { count: 2, thickness: "8", loose: "guest" }))).toEqual([
      "Joint rail_l: a Domino mortise is 1.05 mm from rail's bottom edge, and wood that thin breaks out. Leave at least 5 mm, with fewer Dominos or a smaller size",
      "Joint rail_l: 2.1 mm of rail is left between two Domino mortises, and wood that thin breaks out. Leave at least 5 mm, with fewer Dominos",
    ]);
  });

  it("is refused on another joint and as anything but host or guest, and changes by adding the joint again", () => {
    expect(() => applyOp(build(carcass), { op: "add_joint", id: "j", type: "dowels", host: "side_l", guest: "bottom", loose: "guest" })).toThrow(
      "loose only applies to domino joints, not dowels",
    );
    expect(() => bottomWith({ loose: "side_l" })).toThrow('loose names the piece whose Domino mortises get the play, "host" or "guest", not "side_l"');
    const again = (loose: string): Op => ({ op: "add_joint", id: "rail_l", type: "domino", host: "stile", guest: "rail", loose } as Op);
    expect(() => applyOp(frame(20), again("guest"))).toThrow(/^Joint "rail_l" already exists, and this one differs in loose\. .* To change it, delete_joint it and add it again/);
    // The host is the default, so naming it is the same joint as leaving it out.
    const plain = frame(20);
    expect(applyOp(plain, again("host"))).toBe(plain);
    const flipped = applyOps(frame(20), [{ op: "delete_joint", id: "rail_l" }, again("guest")]);
    expect(cuts(flipped)).toEqual([[[19.8, 0]], [[25.8, 6]]]);
    // The same joint sent again changes nothing.
    expect(applyOp(flipped, again("guest"))).toBe(flipped);
  });
});

describe("the Domino's worked example", () => {
  const d = jointExample("domino");
  const r = derive(d);

  it("joins a side to the top with three Dominos and no problem", () => {
    expect(r.joints[0]!.params).toEqual({ count: 3, thickness: 6, length: 40, depth: 12, fit: 6 });
    expect(runChecks(d, r).issues).toEqual([]);
    expect(cutList(d, r).hardware.map((h) => [h.name, h.qty, h.library_part])).toEqual([["Festool DOMINO tenon, beech, 6 × 40 mm", 3, "festool-domino-beech-6x40"]]);
  });

  it("dimensions each mortise on the workshop drawings", () => {
    const sheets = workshopDrawings(d, r, { date: "5 October 2026" });
    const sheet = (title: string) => sheets.find((s) => s.title === title)!;
    const texts = (title: string) => sheet(title).marks.flatMap((m) => (m.kind === "text" ? [m.text] : []));
    // Issue #92: a Domino mortise is set out by its centre, the way the joiner lines up with a pencil mark.
    expect(sheet("Part 2: Side").dims).toContainEqual({ view: "face", along: "width", kind: "chain", values_mm: [50, 100, 100, 50] });
    // A mortise in an end has no place along the side to mark, and its depth is in the note.
    expect(sheet("Part 2: Side").dims.some((x) => x.along === "length" && x.kind === "chain")).toBe(false);
    // How far in its centre sits is the fence height.
    expect(texts("Part 2: Side")).toContain("Domino mortise 6 wide × 19.8 long × 28 deep, tight, in the top end for top. Centre at 50 from the face edge, 9 from the face side, its length running across.");
    // The top is turned over for its mortises, so its front is at the bottom of its face view, and the sheet says so.
    expect(texts("Part 1: Top")).toEqual(expect.arrayContaining(["Bottom face", "Front edge, face edge", "Right end", "Face side: the top face. Face edge: the front edge."]));
    expect(texts("Part 1: Top").join(" ")).toContain("Along is from the left end. Across is from the face edge and through is from the face side.");
    // The top's mortises are loose and the side's tight, but they share their centres.
    expect(sheet("Part 1: Top").dims).toContainEqual({ view: "face", along: "width", kind: "chain", values_mm: [50, 100, 100, 50] });
    expect(sheet("Part 1: Top").dims).toContainEqual({ view: "face", along: "length", kind: "chain", values_mm: [9, 391] });
    expect(texts("Part 1: Top")).toContain("Domino mortise 6 wide × 25.8 long × 12 deep, 6 mm play, in the bottom face for side. Centre at 9 along, 150 from the face edge, its length running across.");
    expect(sheets.find((s) => s.kind === "hardware")!.marks.some((m) => m.kind === "text" && m.text === "Festool DOMINO tenon, beech, 6 × 40 mm")).toBe(true);
  });
});
