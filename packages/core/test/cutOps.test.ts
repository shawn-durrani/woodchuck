// The operations that add, change and remove cuts, and what they refuse.

import { describe, expect, it } from "vitest";
import { applyOp, applyOps, diffDesigns, emptyDesign, type Design, type Op } from "../src/index.js";

const base = (): Design =>
  applyOps(emptyDesign("Cuts"), [
    { op: "define_material", id: "ply12", name: "12 mm birch ply", kind: "sheet", thickness_mm: 12, grained: true },
    { op: "set_param", name: "pull_size", expr: "25", unit: "mm" },
    {
      op: "add_panel",
      id: "side",
      name: "Side",
      material: "ply12",
      thickness_axis: "x",
      grain_axis: "z",
      x: { start: { at: "0" } },
      y: { start: { at: "0" }, size: "150" },
      z: { start: { at: "0" }, size: "400" },
    },
    {
      op: "add_panel",
      id: "front",
      name: "Front",
      material: "ply12",
      thickness_axis: "z",
      grain_axis: "x",
      x: { start: { face: "side.right" }, size: "300" },
      y: { start: { at: "0" }, size: "80" },
      z: { end: { face: "side.front" } },
    },
    { op: "add_unverified_box", id: "lamp", name: "Lamp", min_mm: [0, 200, 0], max_mm: [100, 300, 100], reason: "No tool for lamps yet" },
  ]);

const slope: Op = { op: "set_edge_cut", id: "side", cut: "slope", edge: "top", start: { face: "side.top" }, end: { face: "front.top" } };
const pull: Op = { op: "set_cutout", id: "front", cut: "pull", shape: "circle", centre: { x: { at: "160" }, y: { face: "front.top", offset: "-30" } }, diameter: "pull_size" };
const part = (d: Design, id: string) => d.parts.find((p) => p.id === id)!;
const refused = (d: Design, op: Op) => {
  try {
    applyOp(d, op);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("not refused");
};

describe("set_edge_cut", () => {
  it("adds a cut that may use its own part's faces, and replaces it by id", () => {
    let d = applyOp(base(), slope);
    expect(part(d, "side").cuts).toEqual([{ id: "slope", kind: "edge", edge: "top", start: { face: "side.top" }, end: { face: "front.top" } }]);
    d = applyOp(d, { ...slope, end: { face: "front.top", offset: "10" }, start_along: { at: "50" }, note: "show the contents" } as Op);
    expect(part(d, "side").cuts).toEqual([
      { id: "slope", kind: "edge", edge: "top", start: { face: "side.top" }, end: { face: "front.top", offset: "10" }, start_along: { at: "50" }, note: "show the contents" },
    ]);
  });

  it("refuses a broad face, a face on the wrong axis, and names nobody knows", () => {
    expect(refused(base(), { ...slope, edge: "left" } as Op)).toBe("side cut slope can't take wood from the left face, which is a broad face of side. Pick one of its edges: bottom, top, back, front");
    expect(refused(base(), { ...slope, end: { face: "front.back" } } as Op)).toBe("side cut slope end is on the y axis, so its face must be bottom or top, not back");
    expect(refused(base(), { ...slope, end: { at: "drawer_height" } } as Op)).toContain('There\'s no size called "drawer_height" in side cut slope end');
    expect(refused(base(), { ...slope, end: { face: "plinth.top" } } as Op)).toContain('There\'s no part called "plinth"');
    expect(refused(base(), { ...slope, start_along: { face: "front.top" } } as Op)).toBe("side cut slope start_along is on the z axis, so its face must be back or front, not top");
    expect(refused(base(), { op: "set_edge_cut", id: "side", cut: "slope", edge: "top", start: { at: "100" } } as Op)).toBe(
      "side cut slope needs start and end: where its new edge sits on y at each end of its run",
    );
    expect(refused(base(), { ...slope, diameter: "10" } as Op)).toBe("diameter isn't a field of an edge cut. Its fields: edge, start, end, start_along, end_along, note");
    expect(refused(base(), { ...slope, cut: "Slope" } as Op)).toBe('Cut id "Slope" must start with a lowercase letter and use only a-z, 0-9 and _');
  });

  it("refuses a part that isn't a panel, and an array copy", () => {
    expect(refused(base(), { ...slope, id: "lamp" } as Op)).toBe("lamp is a stand-in box, which can't be cut. Replace it with a panel first");
    expect(refused(base(), { ...slope, id: "side#2" } as Op)).toBe('There\'s no panel "side#2". Name the original part: its copies repeat its cuts');
    expect(refused(base(), { ...slope, id: "shelf" } as Op)).toBe('There\'s no panel "shelf"');
  });
});

describe("set_cutout", () => {
  it("adds a circle and a rounded rectangle", () => {
    const d = applyOps(base(), [
      pull,
      { op: "set_cutout", id: "side", cut: "kick", shape: "rect", y: { start: { at: "-5" }, end: { at: "40" } }, z: { start: { face: "side.front", offset: "-50" }, size: "60" }, radius: "5" },
    ]);
    expect(part(d, "front").cuts).toEqual([
      { id: "pull", kind: "cutout", shape: "circle", centre: { x: { at: "160" }, y: { face: "front.top", offset: "-30" } }, diameter: "pull_size" },
    ]);
    expect(part(d, "side").cuts).toEqual([
      { id: "kick", kind: "cutout", shape: "rect", y: { start: { at: "-5" }, end: { at: "40" } }, z: { start: { face: "side.front", offset: "-50" }, size: "60" }, radius: "5" },
    ]);
  });

  it("refuses the thickness axis, a span short of two values, and a centre off the face", () => {
    const rect: Op = { op: "set_cutout", id: "side", cut: "hole", shape: "rect", y: { start: { at: "10" }, size: "20" }, z: { start: { at: "10" }, size: "20" } };
    expect(refused(base(), { ...rect, x: { start: { at: "0" }, size: "12" } } as Op)).toBe("side cut hole goes right through side, and x is its thickness axis. Give it only y and z");
    expect(refused(base(), { ...rect, z: { start: { at: "10" } } } as Op)).toBe("side cut hole.z needs two of start, end and size, but it has 1. Fill in one more.");
    expect(refused(base(), { ...rect, radius: "corner" } as Op)).toContain('There\'s no size called "corner"');
    expect(refused(base(), { ...pull, centre: { x: { at: "160" } } } as Op)).toBe("front cut pull centre needs y");
    expect(refused(base(), { ...pull, centre: { x: { at: "1" }, y: { at: "1" }, z: { at: "1" } } } as Op)).toBe(
      "front cut pull goes right through front, and z is its thickness axis. Give it only x and y",
    );
    expect(refused(base(), { ...pull, diameter: undefined } as Op)).toBe("front cut pull needs a diameter");
    expect(refused(base(), { ...pull, shape: "star" } as unknown as Op)).toBe('front cut pull shape "star" isn\'t allowed. Use one of: rect, circle');
    expect(refused(base(), { ...pull, radius: "3" } as Op)).toBe("radius isn't a field of a circle cutout. Its fields: shape, centre, diameter, note");
  });

  it("won't swap a cut's kind under the same id", () => {
    const d = applyOp(base(), slope);
    expect(refused(d, { op: "set_cutout", id: "side", cut: "slope", shape: "circle", centre: { y: { at: "50" }, z: { at: "50" } }, diameter: "10" })).toBe(
      "side already has an edge cut called slope. Change it with set_edge_cut, or delete_cut it first",
    );
  });
});

describe("delete_cut", () => {
  it("removes a cut, and the list with its last one", () => {
    const start = base();
    const d = applyOps(start, [slope, pull, { op: "delete_cut", id: "side", cut: "slope" }]);
    expect(part(d, "side")).toEqual(part(start, "side"));
    expect("cuts" in part(d, "side")).toBe(false);
    expect(part(d, "front").cuts).toHaveLength(1);
  });

  it("names the cuts there are when it can't find one", () => {
    const d = applyOp(base(), slope);
    expect(refused(d, { op: "delete_cut", id: "side", cut: "notch" })).toBe('side has no cut "notch". Its cuts: slope');
    expect(refused(d, { op: "delete_cut", id: "front", cut: "notch" })).toBe('front has no cut "notch". It has no cuts');
  });
});

describe("a panel keeps its cuts", () => {
  it("through a change to anything else", () => {
    const d = applyOps(base(), [slope, { op: "update_panel", id: "side", name: "Left side", tags: ["drawer"], y: { start: { at: "0" }, size: "160" } }]);
    expect(part(d, "side").cuts).toEqual(part(applyOp(base(), slope), "side").cuts);
  });

  it("and checks cuts given whole, with add_panel or update_panel", () => {
    const cuts = part(applyOp(base(), slope), "side").cuts!;
    const added = applyOps(base(), [
      { op: "delete_part", id: "front" },
      { op: "add_panel", id: "copy", name: "Copy", material: "ply12", thickness_axis: "x", grain_axis: "z", x: { start: { at: "100" } }, y: { start: { at: "0" }, size: "150" }, z: { start: { at: "0" }, size: "400" }, cuts: [{ ...cuts[0]!, end: { face: "copy.top", offset: "-40" } } as never] },
    ]);
    expect(part(added, "copy").cuts).toHaveLength(1);
    expect(refused(base(), { op: "update_panel", id: "side", cuts: [cuts[0]!, cuts[0]!] })).toBe("side has two cuts called slope. Give each its own id");
    expect(refused(base(), { op: "update_panel", id: "side", cuts: [{ ...cuts[0]!, kind: "groove" } as never] })).toBe(
      'side cut slope kind must be "edge" or "cutout"',
    );
    expect(part(applyOps(base(), [slope, { op: "update_panel", id: "side", cuts: [] }]), "side").cuts).toBeUndefined();
  });

  it("but won't turn it so a cut is stranded on a broad face", () => {
    const d = applyOp(base(), slope);
    expect(refused(d, { op: "update_panel", id: "side", thickness_axis: "y", y: { start: { at: "0" } }, x: { start: { at: "0" }, size: "150" } })).toBe(
      "Turning side so its thickness runs along y would strand cut slope, which takes wood from its top face. Delete the cut first, or set it again once the part is turned",
    );
    const kick = applyOp(base(), { op: "set_cutout", id: "side", cut: "kick", shape: "rect", y: { start: { at: "-5" }, end: { at: "40" } }, z: { start: { at: "350" }, end: { at: "410" } } });
    expect(refused(kick, { op: "update_panel", id: "side", thickness_axis: "y", y: { start: { at: "0" } }, x: { start: { at: "0" }, size: "150" } })).toBe(
      "Turning side so its thickness runs along y would strand cut kick, which is drawn on y and z. Delete the cut first, or set it again once the part is turned",
    );
  });

  it("and keeps a cut that still sits on an edge once it's turned", () => {
    const front = applyOp(base(), { op: "set_edge_cut", id: "side", cut: "nose", edge: "front", start: { at: "380" }, end: { at: "400" } });
    const turned = applyOp(front, { op: "update_panel", id: "side", thickness_axis: "y", y: { start: { at: "0" } }, x: { start: { at: "0" }, size: "150" } });
    expect(part(turned, "side").cuts).toEqual(part(front, "side").cuts);
  });
});

describe("what a cut depends on", () => {
  it("stops a part or a size it uses from being deleted", () => {
    const d = applyOps(base(), [slope, pull]);
    expect(refused(d, { op: "delete_param", name: "pull_size" })).toBe("Parameter pull_size is still used by cut pull on front");
    expect(refused(d, { op: "delete_part", id: "front" })).toBe("front is still used by cut slope on side. Change those first");
  });

  it("lets a part go with cuts on its own faces", () => {
    const d = applyOps(base(), [pull, { op: "delete_part", id: "front" }]);
    expect(d.parts.map((p) => p.id)).toEqual(["side"]);
  });

  it("still keeps a part's own position off its own faces", () => {
    expect(refused(base(), { op: "update_panel", id: "side", y: { start: { at: "0" }, end: { face: "side.top" } } })).toBe("side.y.end can't refer to the part's own face");
  });
});

describe("what changed", () => {
  it("names each cut added, changed and removed", () => {
    const before = applyOps(base(), [slope]);
    const after = applyOps(before, [{ ...slope, end: { face: "front.top", offset: "5" } } as Op, pull, { op: "update_panel", id: "side", name: "Left side" }]);
    expect(diffDesigns(before, after)).toEqual(["Changed part side: name", "Changed cut slope on side: end", "Added cut pull (cutout) on front"]);
    expect(diffDesigns(after, applyOp(after, { op: "delete_cut", id: "front", cut: "pull" }))).toEqual(["Removed cut pull (cutout) on front"]);
    expect(diffDesigns(before, after, { names: true })).toEqual(["Changed Left side: its shape", "Changed Front: its shape"]);
  });
});
