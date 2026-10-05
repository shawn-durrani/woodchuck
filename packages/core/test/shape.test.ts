// The flat geometry under a part's profile, on small invented shapes.

import { describe, expect, it } from "vitest";
import {
  CURVE_TOLERANCE_MM,
  circleLoop,
  clipHalfPlane,
  insideConvex,
  outlineDistance,
  perimeter,
  piecesOf,
  pointInLoop,
  pointInRegion,
  prismsOverlap,
  rectLoop,
  regionArea,
  regionsOverlap,
  roundedRectLoop,
  signedArea,
  sliceIntervals,
  traceRegion,
  uncutStretches,
  type Loop,
  type Prism,
  type Pt,
} from "../src/index.js";

const square = rectLoop([0, 0], [10, 10]);

/** The 10 mm square with convex shapes taken out of it. */
function minus(...cuts: Loop[]): Loop[] {
  return traceRegion([square, ...cuts], (p) => insideConvex(p, square) > 0 && cuts.every((c) => insideConvex(p, c) < 0));
}

/** How far the middle of each edge sits inside a circle, the most a polygon on it strays. */
function worstSag(loop: Loop, centre: Pt, r: number): number {
  return Math.max(
    ...loop.map((a, i) => {
      const b = loop[(i + 1) % loop.length]!;
      return r - Math.hypot((a[0] + b[0]) / 2 - centre[0], (a[1] + b[1]) / 2 - centre[1]);
    }),
  );
}

describe("measuring", () => {
  it("gives a counter-clockwise loop a positive area and its perimeter", () => {
    expect(signedArea(square)).toBe(100);
    expect(signedArea([...square].reverse())).toBe(-100);
    expect(perimeter(square)).toBe(40);
  });

  it("tells inside from outside, holes included", () => {
    const hole = [...rectLoop([4, 4], [6, 6])].reverse();
    expect(pointInLoop([5, 5], square)).toBe(true);
    expect(pointInLoop([11, 5], square)).toBe(false);
    expect(pointInRegion([5, 5], [square, hole])).toBe(false);
    expect(pointInRegion([2, 5], [square, hole])).toBe(true);
    expect(insideConvex([5, 2], square)).toBe(2);
    expect(insideConvex([5, -3], square)).toBe(-3);
  });
});

describe("making shapes", () => {
  it("clips a convex shape along a line", () => {
    // Keep below the diagonal from the top left to the bottom right.
    const n: Pt = [Math.SQRT1_2, Math.SQRT1_2];
    const half = clipHalfPlane(square, n, n[0] * 10);
    expect(signedArea(half)).toBeCloseTo(50, 9);
    expect(half).toHaveLength(3);
    expect(clipHalfPlane(square, [0, 1], 20)).toEqual(square);
    expect(clipHalfPlane(square, [0, 1], -5)).toEqual([]);
  });

  it.each([1, 17.5, 100, 600])("keeps a circle of radius %s within the tolerance, on a multiple of four corners", (r) => {
    const c: Pt = [3, -4];
    const loop = circleLoop(c, 2 * r);
    expect(loop.length % 4).toBe(0);
    for (const p of loop) expect(Math.hypot(p[0] - c[0], p[1] - c[1])).toBeCloseTo(r, 9);
    expect(worstSag(loop, c, r)).toBeLessThanOrEqual(CURVE_TOLERANCE_MM);
    expect(signedArea(loop)).toBeLessThan(Math.PI * r * r);
    expect(signedArea(loop)).toBeGreaterThan(Math.PI * r * r - 2 * Math.PI * r * CURVE_TOLERANCE_MM);
    // The extreme points are corners, so a circle meets a straight edge cleanly.
    expect(loop).toContainEqual([c[0] + r, c[1]]);
    expect(loop).toContainEqual([c[0], c[1] - r]);
  });

  it("rounds a rectangle's corners, and makes a slot from half its width", () => {
    expect(roundedRectLoop([0, 0], [40, 20])).toEqual(rectLoop([0, 0], [40, 20]));
    // Corners on the true curve leave the area a little short, by at most the arcs' length times the tolerance.
    const within = (loop: Loop, area: number, arcs: number) => {
      expect(signedArea(loop)).toBeLessThan(area);
      expect(signedArea(loop)).toBeGreaterThan(area - arcs * CURVE_TOLERANCE_MM);
    };
    within(roundedRectLoop([0, 0], [40, 20], 5), 800 - (4 - Math.PI) * 25, 2 * Math.PI * 5);
    const slot = roundedRectLoop([0, 0], [40, 20], 10);
    within(slot, 20 * 20 + Math.PI * 100, 2 * Math.PI * 10);
    for (let i = 0; i < slot.length; i++) {
      const [a, b] = [slot[i]!, slot[(i + 1) % slot.length]!];
      expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeGreaterThan(1e-6);
    }
  });
});

describe("tracing what's left", () => {
  it("leaves a hole as a clockwise loop of its own", () => {
    const loops = minus(rectLoop([4, 4], [6, 6]));
    expect(loops).toHaveLength(2);
    expect(regionArea(loops)).toBeCloseTo(96, 9);
    const [piece] = piecesOf(loops);
    expect(signedArea(piece!.outline)).toBe(100);
    expect(piece!.holes.map(signedArea)).toEqual([-4]);
  });

  it("makes a notch flush with the edge part of the outline", () => {
    const loops = minus(rectLoop([3, 0], [7, 2]));
    expect(loops).toHaveLength(1);
    expect(signedArea(loops[0]!)).toBeCloseTo(92, 9);
    expect(loops[0]).toHaveLength(8);
  });

  it("does the same for a notch run on past the edge", () => {
    const loops = minus(rectLoop([3, -5], [7, 2]));
    expect(loops).toHaveLength(1);
    expect(signedArea(loops[0]!)).toBeCloseTo(92, 9);
  });

  it("takes a corner off", () => {
    const loops = minus(rectLoop([8, 8], [12, 12]));
    expect(loops).toHaveLength(1);
    expect(loops[0]).toHaveLength(6);
    expect(signedArea(loops[0]!)).toBeCloseTo(96, 9);
  });

  it("splits the part in two with a slot right across", () => {
    const pieces = piecesOf(minus(rectLoop([4, -1], [6, 11])));
    expect(pieces).toHaveLength(2);
    expect(pieces.map((p) => signedArea(p.outline))).toEqual([40, 40]);
  });

  it("keeps two pieces that touch at a corner apart", () => {
    const loops = minus(rectLoop([5, -1], [11, 5]), rectLoop([-1, 5], [5, 11]));
    expect(piecesOf(loops)).toHaveLength(2);
  });

  it("ignores a cutout with no area, and repeated corners", () => {
    expect(minus([[2, 2], [5, 5], [2, 2]])).toEqual([square]);
    expect(traceRegion([[[0, 0], [10, 0], [10, 0], [10, 10], [0, 10]]], (p) => insideConvex(p, square) > 0)).toEqual([square]);
  });

  it("leaves nothing when a cutout covers the whole part", () => {
    expect(minus(rectLoop([-1, -1], [11, 11]))).toEqual([]);
  });

  it("joins overlapping cutouts into one hole", () => {
    const loops = minus(rectLoop([2, 2], [5, 5]), rectLoop([4, 4], [7, 7]));
    expect(loops).toHaveLength(2);
    expect(regionArea(loops)).toBeCloseTo(100 - 9 - 9 + 1, 9);
  });

  it("keeps the wood around a circle that touches an edge, in one piece", () => {
    const circle = circleLoop([5, 1], 2);
    const pieces = piecesOf(minus(circle));
    expect(pieces).toHaveLength(1);
    expect(regionArea([pieces[0]!.outline, ...pieces[0]!.holes])).toBeCloseTo(100 - signedArea(circle), 9);
  });

  it("notches the edge with a circle that crosses it", () => {
    const loops = minus(circleLoop([5, 0.5], 2));
    expect(loops).toHaveLength(1);
    expect(signedArea(loops[0]!)).toBeGreaterThan(100 - Math.PI);
    expect(signedArea(loops[0]!)).toBeLessThan(100 - Math.PI / 2);
  });
});

describe("distances and stretches", () => {
  it("finds the uncut stretches of a face", () => {
    const loops = minus(rectLoop([8, 3], [12, 7]));
    expect(uncutStretches(loops, 0, 10, 0, 10)).toEqual([
      [0, 3],
      [7, 10],
    ]);
    expect(uncutStretches(loops, 0, 0, 0, 10)).toEqual([[0, 10]]);
    expect(uncutStretches(minus(rectLoop([8, -1], [12, 11])), 0, 10, 0, 10)).toEqual([]);
  });

  it("measures the web between outlines", () => {
    expect(outlineDistance(square, rectLoop([13, 0], [20, 10]))).toBe(3);
    expect(outlineDistance(square, rectLoop([5, 5], [20, 20]))).toBe(0);
    expect(outlineDistance(square, circleLoop([5, 3], 2))).toBeCloseTo(2, 9);
  });

  it("slices a region along a line", () => {
    const loops = minus(rectLoop([4, 4], [6, 6]));
    expect(sliceIntervals(loops, 0, 5)).toEqual([
      [0, 4],
      [6, 10],
    ]);
    expect(sliceIntervals(loops, 1, 1)).toEqual([[0, 10]]);
  });
});

describe("solids that overlap", () => {
  // A side 20 thick on x, 100 high and 300 deep, sloped from 100 at the back to 40 at the front.
  const sloped: Prism = { u: "y", v: "z", loops: [[[0, 0], [100, 0], [40, 300], [0, 300]]], t_mm: [0, 20] };
  // A shelf lying on y, from 60 to 72 high, running from x 0 to 200 and z from a to b.
  const shelf = (z0: number, z1: number): Prism => ({ u: "z", v: "x", loops: [rectLoop([z0, 0], [z1, 200])], t_mm: [60, 72] });

  it("finds the slope clear of a shelf at the front, where the boxes would overlap", () => {
    // Under the slope the side is 100 - 0.2 z high, so it drops below 60 at z = 200.
    expect(prismsOverlap(sloped, shelf(220, 300))).toBe(false);
    expect(prismsOverlap(sloped, shelf(150, 300))).toBe(true);
  });

  it("ignores an overlap thinner than eps", () => {
    // The side reaches 60 high at z = 200, and 60.004 at z = 199.98.
    expect(prismsOverlap(sloped, shelf(199.98, 300))).toBe(false);
  });

  it("compares two parts lying the same way by their faces", () => {
    const a = { u: "x" as const, v: "y" as const, loops: [rectLoop([0, 0], [10, 10])], t_mm: [0, 18] as [number, number] };
    const tri = { u: "y" as const, v: "x" as const, loops: [[[0, 10], [10, 10], [0, 20]] as Loop], t_mm: [10, 30] as [number, number] };
    expect(prismsOverlap(a, tri)).toBe(false);
    expect(prismsOverlap(a, { ...tri, loops: [[[0, 9], [10, 9], [0, 20]] as Loop] })).toBe(true);
    expect(prismsOverlap(a, { ...tri, loops: [[[0, 9], [10, 9], [0, 20]] as Loop], t_mm: [18, 30] })).toBe(false);
  });

  it("finds a hole's room for a part through it", () => {
    const withHole = minus(rectLoop([3, 3], [7, 7]));
    expect(regionsOverlap(withHole, [rectLoop([4, 4], [6, 6])])).toBe(false);
    expect(regionsOverlap(withHole, [rectLoop([2, 4], [6, 6])])).toBe(true);
  });
});
