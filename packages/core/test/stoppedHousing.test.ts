// Issue #44: a dado, groove or rabbet that stops short of an edge, so its
// end doesn't show there. The housing runs only to the stop, the guest
// keeps its place and size, and its corner is notched to match. The fixture
// is an invented wall shelf: two 18 mm pine sides, 600 tall and 240 deep,
// with one shelf housed in both at 300 mm. Every size is made up.

import { describe, expect, it } from "vitest";
import {
  applyOp,
  applyOps,
  cutList,
  cutOutline,
  derive,
  emptyDesign,
  exampleStopEdge,
  explainPart,
  JOINT_TYPES,
  jointExample,
  canStop,
  renderView,
  runChecks,
  toPlain,
  workshopDrawings,
  type Design,
  type Joint,
  type Op,
} from "../src/index.js";

const pine: Op = { op: "define_material", id: "pine18", name: "18 mm pine", kind: "solid", thickness_mm: 18, grained: true };
const side = (id: string, x: Record<string, unknown>): Op =>
  ({ op: "add_panel", id, name: id === "side_l" ? "Left side" : "Right side", material: "pine18", thickness_axis: "x", grain_axis: "y", x, y: { start: { at: "0" }, size: "600" }, z: { start: { at: "0" }, size: "240" } }) as Op;
const shelf = (z: Record<string, unknown> = { start: { at: "0" }, size: "240" }): Op =>
  ({ op: "add_panel", id: "shelf", name: "Shelf", material: "pine18", thickness_axis: "y", grain_axis: "x", x: { start: { face: "side_l.right" }, end: { face: "side_r.left" } }, y: { start: { at: "300" } }, z }) as Op;
const dado = (id: string, host: string, stop?: unknown): Op => ({ op: "add_joint", id, type: "dado", host, guest: "shelf", ...(stop === undefined ? {} : { stop }) }) as Op;

/** The wall shelf with both dados stopped the same way. */
const wallShelf = (stop?: unknown, z?: Record<string, unknown>): Design =>
  applyOps(emptyDesign("Wall shelf"), [pine, side("side_l", { start: { at: "0" } }), side("side_r", { end: { at: "600" } }), shelf(z), dado("shelf_l", "side_l", stop), dado("shelf_r", "side_r", stop)]);

const refused = (d: Design, op: unknown) => {
  try {
    applyOp(d, op as Op);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("not refused");
};
const issues = (d: Design) => runChecks(d, derive(d)).issues.filter((i) => i.code !== "floating").map((i): [string, string, string] => [i.code, i.severity, i.message]);
const feature = (d: Design, joint: string, kind: "tongue" | "removed") => derive(d).joints.find((j) => j.id === joint)!.features.find((f) => f.kind === kind)!.box;
const rows = (d: Design) => Object.fromEntries(cutList(d, derive(d)).rows.map((r) => [r.name, r.machining]));

describe("a stop, as an edit", () => {
  const plain = wallShelf();
  const joint = (d: Design) => d.joints.find((j) => j.id === "shelf_l")!;

  it("keeps each edge with its expression, in the order of the faces", () => {
    const d = applyOps(plain, [
      { op: "set_param", name: "stop_back", expr: "15", unit: "mm" },
      { op: "delete_joint", id: "shelf_l" },
      dado("shelf_l", "side_l", { front: 10, back: "stop_back" }),
    ]);
    expect(joint(d).stop).toEqual({ back: "stop_back", front: "10" });
    expect(Object.keys(joint(d).stop!)).toEqual(["back", "front"]);
    // A parameter a stop reads can't go while the stop does.
    expect(refused(d, { op: "delete_param", name: "stop_back" })).toBe("Parameter stop_back is still used by joint shelf_l");
  });

  it("drops an empty stop, which stops nothing", () => {
    const d = applyOps(plain, [{ op: "delete_joint", id: "shelf_l" }, dado("shelf_l", "side_l", { front: "" })]);
    expect(joint(d).stop).toBeUndefined();
  });

  it("refuses a stop that isn't a housing's, with the reason", () => {
    const base = applyOps(plain, [{ op: "delete_joint", id: "shelf_l" }]);
    expect(refused(base, dado("shelf_l", "side_l", "10"))).toBe('stop must be an object of the edges the housing stops short of, each with how far in mm. Example: "stop": {"front": "10"}');
    expect(refused(base, dado("shelf_l", "side_l", { forward: "10" }))).toBe(
      'stop takes the edges a housing stops short of, from left, right, bottom, top, back, front, not "forward". Example: "stop": {"front": "10"}',
    );
    expect(refused(base, dado("shelf_l", "side_l", { front: "10", top: "5" }))).toBe(
      "A housing runs between two edges, so it stops short of the back and the front, the bottom and the top, or the left and the right, not the top and the front",
    );
    expect(refused(base, { op: "add_joint", id: "shelf_l", type: "screws", host: "side_l", guest: "shelf", stop: { front: "10" } })).toBe(
      "stop only applies to dado, groove, rabbet and dado_rabbet joints, not screws",
    );
    expect(refused(base, dado("shelf_l", "side_l", { front: "10 +" }))).toMatch(/^Couldn't read "10 \+" for the front stop of joint shelf_l: /);
    expect(refused(base, dado("shelf_l", "side_l", { front: "inset" }))).toMatch(/^There's no size called "inset" in the front stop of joint shelf_l\./);
  });
});

describe("a stopped dado", () => {
  it("runs to the stop, and notches the shelf's front corners to match", () => {
    const d = wallShelf({ front: "10" });
    const r = derive(d);
    // The shelf keeps its place and its cut size.
    expect(r.byId.get("shelf")!.nominal).toEqual(derive(wallShelf()).byId.get("shelf")!.nominal);
    expect(r.byId.get("shelf")!.cut).toEqual({ length: 576, width: 240, thickness: 18 });
    expect(feature(d, "shelf_l", "removed")).toEqual({ min: [12, 300, 0], max: [18, 318, 230] });
    expect(feature(d, "shelf_l", "tongue")).toEqual({ min: [12, 300, 0], max: [18, 318, 230] });
    expect(feature(d, "shelf_r", "removed")).toEqual({ min: [582, 300, 0], max: [588, 318, 230] });
    expect(r.byId.get("side_l")!.machining).toEqual([
      expect.objectContaining({ label: "dado", length_mm: 230, depth_mm: 6, width_mm: 18, stop_mm: { front: 10 } }),
    ]);
    expect(r.byId.get("shelf")!.machining).toEqual([
      expect.objectContaining({ label: "notch", face: "left", corner: "front", length_mm: 6, width_mm: 10, depth_mm: 18, region: { min: [12, 300, 230], max: [18, 318, 240] } }),
      expect.objectContaining({ label: "notch", face: "right", corner: "front", length_mm: 6, width_mm: 10, depth_mm: 18, region: { min: [582, 300, 230], max: [588, 318, 240] } }),
    ]);
    expect(r.joints.map((j) => j.stop_mm)).toEqual([{ front: 10 }, { front: 10 }]);
    expect(r.byId.get("shelf")!.extensions.map((e) => e.notch_mm)).toEqual([
      [0, 10],
      [0, 10],
    ]);
    expect(issues(d)).toEqual([]);
  });

  it("says so on the cut list, with each notch", () => {
    expect(rows(wallShelf({ front: "10" }))).toEqual({
      "Left side": ["dado 18 wide × 6 deep × 230 long in the right face for shelf at (12,300,0), stopped 10 mm from the front"],
      "Right side": ["dado 18 wide × 6 deep × 230 long in the left face for shelf at (0,300,0), stopped 10 mm from the front"],
      Shelf: [
        "notch 6 × 10 out of the front left corner, to fit the stopped dado in side_l at (0,0,230)",
        "notch 6 × 10 out of the front right corner, to fit the stopped dado in side_r at (570,0,230)",
      ],
    });
  });

  it("stops at the back the same way", () => {
    const d = wallShelf({ back: "10" });
    expect(feature(d, "shelf_l", "removed")).toEqual({ min: [12, 300, 10], max: [18, 318, 240] });
    expect(rows(d)["Left side"]).toEqual(["dado 18 wide × 6 deep × 230 long in the right face for shelf at (12,300,10), stopped 10 mm from the back"]);
    expect(rows(d).Shelf).toEqual([
      "notch 6 × 10 out of the back left corner, to fit the stopped dado in side_l at (0,0,0)",
      "notch 6 × 10 out of the back right corner, to fit the stopped dado in side_r at (570,0,0)",
    ]);
    expect(derive(d).byId.get("shelf")!.extensions.map((e) => e.notch_mm)).toEqual([
      [10, 0],
      [10, 0],
    ]);
  });

  it("stops at both ends, with a notch at each corner", () => {
    const d = wallShelf({ back: "15", front: "10" });
    expect(feature(d, "shelf_l", "removed")).toEqual({ min: [12, 300, 15], max: [18, 318, 230] });
    expect(rows(d)["Left side"]).toEqual(["dado 18 wide × 6 deep × 215 long in the right face for shelf at (12,300,15), stopped 15 mm from the back and 10 mm from the front"]);
    expect(rows(d).Shelf).toEqual([
      "notch 6 × 10 out of the front left corner, to fit the stopped dado in side_l at (0,0,230)",
      "notch 6 × 10 out of the front right corner, to fit the stopped dado in side_r at (570,0,230)",
      "notch 6 × 15 out of the back left corner, to fit the stopped dado in side_l at (0,0,0)",
      "notch 6 × 15 out of the back right corner, to fit the stopped dado in side_r at (570,0,0)",
    ]);
    expect(issues(d)).toEqual([]);
  });

  it("needs no notch on a shelf set back past the stop, and says where the dado ends", () => {
    const d = wallShelf({ front: "10" }, { start: { at: "0" }, size: "220" });
    expect(feature(d, "shelf_l", "removed")).toEqual({ min: [12, 300, 0], max: [18, 318, 220] });
    expect(rows(d)["Left side"]).toEqual(["dado 18 wide × 6 deep × 220 long in the right face for shelf at (12,300,0), stopped 20 mm from the front"]);
    expect(rows(d).Shelf).toEqual([]);
    expect(derive(d).byId.get("shelf")!.extensions.every((e) => e.notch_mm === undefined)).toBe(true);
  });

  it("repeats on every copy of an arrayed shelf", () => {
    const d = applyOp(wallShelf({ front: "10" }), { op: "set_array", id: "shelves", parts: ["shelf"], axis: "y", count: "2", pitch: "150" });
    const r = derive(d);
    expect(r.joints.map((j) => [j.id, j.stop_mm])).toEqual([
      ["shelf_l", { front: 10 }],
      ["shelf_l#2", { front: 10 }],
      ["shelf_r", { front: 10 }],
      ["shelf_r#2", { front: 10 }],
    ]);
    expect(feature(d, "shelf_l#2", "removed")).toEqual({ min: [12, 450, 0], max: [18, 468, 230] });
    expect(cutList(d, r).rows.find((row) => row.name === "Shelf")!.qty).toBe(2);
  });

  it("treats a stop of 0 as no stop, so the design derives as if it had none", () => {
    expect(JSON.stringify(toPlain(derive(wallShelf({ front: "0" }))))).toBe(JSON.stringify(toPlain(derive(wallShelf()))));
  });

  it("names the stop when it explains a part", () => {
    const d = derive(wallShelf({ front: "10" }));
    expect(explainPart(d, "side_l")).toContain("Joint shelf_l: Dado (housing), shelf into side_l. depth 6 (library default), fit 0 (library default), stopped 10 mm from the front");
    expect(explainPart(d, "shelf")).toContain("notch 6 × 10 out of the front left corner, to fit the stopped dado in side_l");
  });
});

describe("a stopped housing's checks", () => {
  it("refuse a stop that leaves no housing, and run the dado whole", () => {
    const d = wallShelf({ front: "240" });
    expect(issues(d).filter(([, , m]) => m.startsWith("Joint shelf_l:"))).toEqual([
      ["stop_too_long", "error", "Joint shelf_l: stopped 240 mm from the front, the dado for shelf in side_l has none of its 240 mm left, so nothing would hold shelf. Make the stop shorter"],
    ]);
    expect(feature(d, "shelf_l", "removed")).toEqual({ min: [12, 300, 0], max: [18, 318, 240] });
    const both = wallShelf({ back: "120", front: "130" });
    expect(issues(both)[0]).toEqual([
      "stop_too_long",
      "error",
      "Joint shelf_l: stopped 120 mm from the back and 130 mm from the front, the dado for shelf in side_l has none of its 240 mm left, so nothing would hold shelf. Make the stops shorter",
    ]);
  });

  it("warn when the stop leaves less than half the housing", () => {
    expect(issues(wallShelf({ front: "130" }))[0]).toEqual([
      "stop_short_housing",
      "warning",
      "Joint shelf_l: the stop leaves 110 mm of the 240 mm dado for shelf in side_l, less than half, so shelf has little holding it. Keep at least 120 mm",
    ]);
    expect(issues(wallShelf({ front: "120" }))).toEqual([]);
  });

  it("warn when the stop leaves too little wood before the edge", () => {
    expect(issues(wallShelf({ front: "3" }))[0]).toEqual([
      "stop_thin",
      "warning",
      "Joint shelf_l: the dado for shelf in side_l stops only 3 mm from the front, and wood that thin can break out when you square the end. Leave at least 6 mm",
    ]);
    expect(issues(wallShelf({ front: "6" }))).toEqual([]);
  });

  it("refuse a stop on an edge the housing doesn't run to, or below 0, and run the dado whole", () => {
    const top = wallShelf({ top: "10" });
    expect(issues(top)[0]).toEqual(["stop_error", "error", "Joint shelf_l: the dado for shelf in side_l runs back to front, so it can stop short of the back or the front, not the top"]);
    expect(derive(top).byId.get("side_l")!.machining[0]!.stop_mm).toBeUndefined();
    expect(issues(wallShelf({ front: "-5" }))[0]).toEqual([
      "stop_error",
      "error",
      "Joint shelf_l: its front stop works out to -5 mm. A stop is how far short of the edge the dado ends, so it can't be below 0",
    ]);
  });

  it("leave out a stop written by hand on a joint that isn't a housing", () => {
    const d = wallShelf();
    const screwed: Design = { ...d, joints: d.joints.map((j): Joint => (j.id === "shelf_l" ? { ...j, type: "screws", stop: { front: "10" } } : j)) };
    expect(issues(screwed)[0]).toEqual(["stop_error", "error", "Joint shelf_l: only a dado, groove, rabbet or dado and rabbet can stop short of an edge, so the stop on this screwed joint is left out"]);
  });
});

describe("a stopped housing into a shaped shelf", () => {
  const holed = (stop?: unknown) =>
    applyOp(wallShelf(stop), { op: "set_cutout", id: "shelf", cut: "cable", shape: "circle", centre: { x: { at: "300" }, z: { at: "40" } }, diameter: "30" });

  it("leaves the notch out of the shelf's tongue, as the shape you cut", () => {
    const r = derive(holed({ front: "10" }));
    const p = r.byId.get("shelf")!;
    expect(p.profile!.extensions.map((e) => [e.face, e.along_mm, e.notch_mm])).toEqual([
      ["left", [[0, 230]], [0, 10]],
      ["right", [[0, 230]], [0, 10]],
    ]);
    // Seen from y, the shelf's face runs z then x: the tongues stop 10 mm short of its front at 240.
    expect(cutOutline(p)!.outline).toEqual([
      [0, -6],
      [230, -6],
      [230, 0],
      [240, 0],
      [240, 564],
      [230, 564],
      [230, 570],
      [0, 570],
    ]);
    // The notches are machining, so nothing says a cut took that wood.
    expect(explainPart(r, "shelf").filter((l) => l.includes("where no cut has touched it"))).toEqual([]);
    expect(issues(holed({ front: "10" }))).toEqual([]);
  });
});

describe("pictures of a stopped housing", () => {
  /** The extent of every polygon of one colour, on the drawing's x and y. */
  const extent = (svg: string, colour: string) => {
    const pts = [...svg.matchAll(/<polygon points="([^"]+)" fill="([^"]+)"/g)].filter((m) => m[2] === colour).flatMap((m) => m[1]!.split(" ").map((q) => q.split(",").map(Number)));
    return { x: [Math.min(...pts.map((q) => q[0]!)), Math.max(...pts.map((q) => q[0]!))], y: [Math.min(...pts.map((q) => q[1]!)), Math.max(...pts.map((q) => q[1]!))] };
  };

  it("draws the housing short of the front in the see-through plan, so the front edge shows no slot", () => {
    const top = (d: Design) => renderView("top", derive(d), { xray: true }).svg;
    const whole = extent(top(wallShelf()), "#e03131");
    const stopped = extent(top(wallShelf({ front: "10" })), "#e03131");
    // The plan runs z down the drawing, and both draw the same parts at the same scale.
    const scale = (whole.y[1]! - whole.y[0]!) / 240;
    expect(stopped.y[0]).toBeCloseTo(whole.y[0]!, 0);
    expect(stopped.y[1]! - stopped.y[0]!).toBeCloseTo(230 * scale, 0);
    expect(whole.y[1]! - stopped.y[1]!).toBeCloseTo(10 * scale, 0);
  });

  it("leaves the plain views as they were, since a housing is out of sight", () => {
    for (const view of ["front", "top", "left", "iso"] as const) {
      expect(renderView(view, derive(wallShelf({ front: "10" }))).svg).toBe(renderView(view, derive(wallShelf())).svg);
    }
  });

  it("sizes the stop on the side's sheet and the notch on the shelf's", () => {
    const d = wallShelf({ front: "10" });
    const sheets = workshopDrawings(d, derive(d), { date: "5 October 2026" });
    const sheet = (title: string) => sheets.find((s) => s.title.endsWith(title))!;
    const texts = (title: string) => sheet(title).marks.flatMap((m) => (m.kind === "text" ? [m.text] : []));
    expect(sheet("Left side").dims).toContainEqual({ view: "face", along: "width", kind: "chain", values_mm: [230, 10] });
    expect(texts("Left side").join(" ")).toContain("stopped 10 mm from the front");
    expect(sheet("Shelf").dims).toContainEqual({ view: "face", along: "width", kind: "chain", values_mm: [230, 10] });
    expect(sheet("Shelf").dims).toContainEqual({ view: "face", along: "length", kind: "chain", values_mm: [6, 564, 6] });
    expect(texts("Shelf").join(" ")).toContain("notch 6 × 10 out of the front left corner, to fit the stopped dado in side_l. At 0 to 6 along, 0 to 10 from the face edge.");
  });
});

describe("the stopped worked examples", () => {
  it.each(JOINT_TYPES.filter(canStop).map((t) => [t]))("build a clean stopped %s, 10 mm short of an edge with the guest notched", (type) => {
    const d = jointExample(type, { stopped: true });
    const r = derive(d);
    const edge = exampleStopEdge(type);
    expect(d.name).toMatch(/^Stopped .*, worked example$/);
    expect(r.joints.map((j) => [j.type, j.stop_mm])).toEqual([[type, { [edge]: 10 }]]);
    expect(r.parts.every((p) => !p.broken)).toBe(true);
    expect(runChecks(d, r).issues.filter((i) => i.severity === "error").map((i) => i.message)).toEqual([]);
    const lines = cutList(d, r).rows.flatMap((row) => row.machining);
    expect(lines.filter((l) => l.endsWith(`stopped 10 mm from the ${edge}`))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("notch "))).toHaveLength(1);
  });

  it("are only for housings and the dado of a dado and rabbet", () => {
    expect(JOINT_TYPES.filter(canStop)).toEqual(["dado", "groove", "rabbet", "dado_rabbet"]);
    expect(() => jointExample("mortise_tenon", { stopped: true })).toThrow("A mortise_tenon can't stop short of an edge. Only a dado, groove, rabbet or dado_rabbet can");
  });

  it("stop a dado and rabbet's dado short of the drawer side's top, and notch only the front's tongue", () => {
    const d = jointExample("dado_rabbet", { stopped: true });
    const r = derive(d);
    const plain = derive(jointExample("dado_rabbet"));
    const tongue = (x: typeof r) => x.joints[0]!.features.find((f) => f.kind === "tongue")!.box!;
    const removed = (x: typeof r) => x.joints[0]!.features.find((f) => f.kind === "removed")!.box!;
    // The dado runs up the side, from y 0, and now stops 10 mm under its top at 120.
    expect(removed(r)).toEqual({ ...removed(plain), max: [removed(plain).max[0], 110, removed(plain).max[2]] });
    expect(tongue(r)).toEqual({ ...tongue(plain), max: [tongue(plain).max[0], 110, tongue(plain).max[2]] });
    const notch = r.byId.get("front")!.machining.find((m) => m.label === "notch")!;
    // Only the tongue is notched, so the notch is the tongue's thickness, not the front's.
    expect(notch.corner).toBe("top");
    expect(notch.region.min[2]).toBe(tongue(r).min[2]);
    expect(notch.region.max[2]).toBe(tongue(r).max[2]);
    expect(notch.region.min[1]).toBe(110);
    const lines = cutList(d, r).rows.flatMap((row) => row.machining);
    expect(lines.filter((l) => l.startsWith("dado for tongue "))[0]).toMatch(/, stopped 10 mm from the top$/);
    expect(lines.filter((l) => l.startsWith("notch "))[0]).toMatch(/^notch \S+ × 10 out of the top left corner, to fit the stopped dado in side at /);
    expect(lines.filter((l) => l.startsWith("tongue "))[0]).toMatch(/ × 110 wide × /);
  });
});
