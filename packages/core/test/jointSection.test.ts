// Issue #66: a joint pulled apart on its own comes with two cuts through
// it, hatched and sized, and with its settings and the cuts each part needs
// in the cut list's words. The worked examples are the fixtures: two
// invented boards joined each way the library knows.

import { describe, expect, it } from "vitest";
import { cutList, derive, jointExample, jointSection, jointSizes, JOINT_TYPES, sheetSvg, type JointSection, type Mark } from "../src/index.js";

const section = (type: (typeof JOINT_TYPES)[number]) => {
  const r = derive(jointExample(type));
  return { r, s: jointSection(r, r.joints[0]!.id)! };
};
/** A view's chain of sizes along a world axis. */
const chain = (s: JointSection, view: string, along: string) => s.dims.find((d) => d.view === view && d.along === along)?.values_mm;
/** Every point a mark puts on the paper. */
const points = (m: Mark): [number, number][] =>
  m.kind === "line" ? [[m.x1_mm, m.y1_mm], [m.x2_mm, m.y2_mm]] : m.kind === "shape" ? m.points_mm : m.kind === "circle" ? [[m.cx_mm, m.cy_mm]] : [[m.x_mm, m.y_mm]];

describe("a joint in section", () => {
  it("draws two sized views of every worked joint, all on the paper", () => {
    for (const type of JOINT_TYPES) {
      const { s } = section(type);
      expect(s, type).not.toBeNull();
      expect(s.scales, type).toHaveLength(2);
      const views = [...new Set(s.dims.map((d) => d.view))];
      expect(views, type).toHaveLength(2);
      for (const m of s.marks) {
        for (const [x, y] of points(m)) {
          expect(Number.isFinite(x) && Number.isFinite(y), type).toBe(true);
          expect(x >= 0 && x <= s.width_mm && y >= 0 && y <= s.height_mm, `${type}: ${m.kind} at ${x},${y}`).toBe(true);
        }
      }
      // It's an SVG like any workshop drawing.
      expect(sheetSvg({ kind: "part", title: s.title, paper: "A4", width_mm: s.width_mm, height_mm: s.height_mm, scale: null, marks: s.marks, dims: s.dims })).toMatch(/^<svg /);
    }
  });

  it("sizes a tenon's thickness, its shoulders and how deep it goes", () => {
    const { r, s } = section("mortise_tenon");
    const j = r.joints[0]!;
    expect(s.title).toBe("Mortise and tenon: rail into leg");
    // Across the rail's thickness: a cheek each side of the tenon, and the tenon itself.
    expect(chain(s, "Through the thickness", "z")).toContain(j.params.thickness);
    // Along the rail, left to right: the wood the mortise leaves in the leg, then the tenon's length into it.
    expect(chain(s, "Through the thickness", "x")).toEqual([15, j.params.depth]);
    // Across the rail's width: a shoulder, the tenon and the other shoulder.
    expect(chain(s, "Through the width", "y")).toEqual([j.params.shoulder, 60, j.params.shoulder]);
    expect(s.scales).toEqual([1, 2]);
  });

  it("sizes a dado's width and depth, and the wood it leaves", () => {
    const { s } = section("dado");
    expect(chain(s, "Through the thickness", "x")).toEqual([12, 6]);
    expect(chain(s, "Through the thickness", "y")).toEqual([18]);
  });

  it("splits a half lap into its two halves, and a box joint into its fingers", () => {
    expect(chain(section("half_lap").s, "Along rail", "y")).toEqual([10, 10]);
    const fingers = chain(section("box_joint").s, "Through the fingers", "y")!;
    expect(fingers.length).toBeGreaterThan(3);
    expect(new Set(fingers).size).toBe(1);
  });

  it("draws a fixing that crosses the cut solid, a dowel along its length and a pocket screw end on", () => {
    const solid = (s: JointSection) => s.marks.filter((m) => (m.kind === "shape" || m.kind === "circle") && m.fill === "#555555");
    expect(solid(section("dowels").s).length).toBeGreaterThan(0);
    expect(solid(section("pocket_screws").s).some((m) => m.kind === "circle")).toBe(true);
  });

  it("is null for a joint that isn't there", () => {
    const r = derive(jointExample("dado"));
    expect(jointSection(r, "nope")).toBeNull();
  });
});

describe("a joint's sizes", () => {
  it("lists its settings, marking the library's usual ones, and each part's cuts as the cut list words them", () => {
    const r = derive(jointExample("mortise_tenon"));
    const design = jointExample("mortise_tenon");
    const sizes = jointSizes(r, r.joints[0]!.id)!;
    expect(sizes.settings.map((x) => x.name)).toEqual(["Depth", "Thickness", "Shoulder"]);
    expect(sizes.settings.find((x) => x.name === "Shoulder")).toEqual({ name: "Shoulder", value: "10 mm", usual: true });
    const rows = cutList(design, r).rows;
    for (const c of sizes.cuts) {
      const row = rows.find((x) => x.parts.includes(c.part))!;
      for (const line of c.lines) expect(row.machining, c.part).toContain(line);
    }
    expect(sizes.cuts.map((c) => c.part)).toEqual(["leg", "rail"]);
    expect(sizes.stopped).toBeUndefined();
  });

  it("says where a stopped housing stops", () => {
    const r = derive(jointExample("dado", { stopped: true }));
    expect(jointSizes(r, r.joints[0]!.id)!.stopped).toBe("10 mm from the front");
  });

  it("is null for a joint that isn't there", () => {
    expect(jointSizes(derive(jointExample("dado")), "nope")).toBeNull();
  });
});
