// Flat geometry for the face of a part: the outline you'd mark on the
// board and the holes inside it. Everything here is pure arithmetic on
// points in mm, with no design in sight, so each piece tests on its own.
//
// A part starts as its blank, a rectangle. A straight cut clips it along a
// line, and a cutout takes a rectangle, a rounded rectangle or a circle out
// of it. A curve becomes a polygon with its corners on the true curve, and
// it never strays more than CURVE_TOLERANCE_MM inside it. That leaves a
// shade more wood than the real part has, so a check errs towards finding
// an overlap, never towards missing one. Straight edges are exact.

import { AXES, type Axis } from "./types.js";

/** A point on a part's face, in mm. */
export type Pt = [number, number];
/** A closed polygon. The last point joins back to the first. */
export type Loop = Pt[];

/** The furthest a curve's polygon strays inside the true curve, under the checks' 0.01 mm. */
export const CURVE_TOLERANCE_MM = 0.005;

/** Points closer than this are the same point. */
const SNAP = 1e-6;
/** How far either side of an edge to look, to tell the region from the rest. */
const SIDE = 1e-5;
/** The grid that finds a point's twin quickly. Any size over SNAP works. */
const CELL = 1e-5;

const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const cross = (a: Pt, b: Pt) => a[0] * b[1] - a[1] * b[0];
const dot = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];
const len = (a: Pt) => Math.hypot(a[0], a[1]);
const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const near = (a: Pt, b: Pt) => len(sub(a, b)) <= SNAP;
const edgesOf = (loop: Loop): [Pt, Pt][] => loop.map((p, i) => [p, loop[(i + 1) % loop.length]!]);

// ---------------------------------------------------------------------------
// Measuring

/** The signed area: positive when the loop runs counter-clockwise. */
export function signedArea(loop: Loop): number {
  let s = 0;
  for (const [a, b] of edgesOf(loop)) s += a[0] * b[1] - b[0] * a[1];
  return s / 2;
}

/** The area of a region traced by traceRegion: its outlines run counter-clockwise and count, its holes run clockwise and come off. */
export function regionArea(loops: Loop[]): number {
  return loops.reduce((s, l) => s + signedArea(l), 0);
}

export function perimeter(loop: Loop): number {
  return edgesOf(loop).reduce((s, [a, b]) => s + len(sub(b, a)), 0);
}

/** True when p is inside the loop, by counting the edges a ray from it crosses. A point on an edge can go either way. */
export function pointInLoop(p: Pt, loop: Loop): boolean {
  let inside = false;
  for (const [a, b] of edgesOf(loop)) {
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Inside a region of outlines and holes: inside an odd number of its loops. */
export function pointInRegion(p: Pt, loops: Loop[]): boolean {
  return loops.reduce((n, l) => n + (pointInLoop(p, l) ? 1 : 0), 0) % 2 === 1;
}

/**
 * How far p sits inside a convex loop, either way round: the distance to
 * its nearest edge line, negative when p is outside.
 */
export function insideConvex(p: Pt, loop: Loop): number {
  const turn = Math.sign(signedArea(loop)) || 1;
  let least = Infinity;
  for (const [a, b] of edgesOf(loop)) {
    const d = sub(b, a);
    const l = len(d);
    if (l <= SNAP) continue;
    least = Math.min(least, (turn * cross(d, sub(p, a))) / l);
  }
  return least;
}

// ---------------------------------------------------------------------------
// Making shapes

export function rectLoop(min: Pt, max: Pt): Loop {
  return [
    [min[0], min[1]],
    [max[0], min[1]],
    [max[0], max[1]],
    [min[0], max[1]],
  ];
}

/** Drops repeated points, so every edge has length. */
function tidy(loop: Loop): Loop {
  const out: Loop = [];
  for (const p of loop) if (!out.length || !near(out[out.length - 1]!, p)) out.push(p);
  while (out.length > 1 && near(out[0]!, out[out.length - 1]!)) out.pop();
  return out;
}

/**
 * Keeps the part of a polygon where n·p ≤ c, the left of the line when n
 * points right. The answer is exact for a convex polygon.
 */
export function clipHalfPlane(loop: Loop, n: Pt, c: number): Loop {
  const out: Loop = [];
  for (const [a, b] of edgesOf(loop)) {
    const da = dot(n, a) - c;
    const db = dot(n, b) - c;
    if (da <= 0) out.push(a);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) out.push(lerp(a, b, da / (da - db)));
  }
  return tidy(out);
}

/**
 * The part of a loop inside a rectangle. A convex loop comes out exact, and
 * any other keeps its area, which is all the checks read from it.
 */
export function clipRect(loop: Loop, min: Pt, max: Pt): Loop {
  let out = loop;
  for (const [n, c] of [
    [[-1, 0], -min[0]],
    [[1, 0], max[0]],
    [[0, -1], -min[1]],
    [[0, 1], max[1]],
  ] as [Pt, number][]) {
    if (out.length < 3) return [];
    out = clipHalfPlane(out, n, c);
  }
  return out.length < 3 ? [] : out;
}

/** Sides for a polygon whose corners sit on a circle of radius r and whose edges stay within tol of it, as a multiple of 4. */
function sidesFor(r: number, tol: number): number {
  if (r <= tol) return 4;
  const n = Math.ceil(Math.PI / Math.acos(1 - tol / r));
  return Math.min(Math.max(4, Math.ceil(n / 4) * 4), 1 << 15);
}

/** A point on a circle, exact at each quarter turn so a circle touches a straight edge cleanly. */
function onCircle(c: Pt, r: number, quarter: number, frac: number): Pt {
  const exact: Pt[] = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ];
  if (frac === 0) {
    const [x, y] = exact[((quarter % 4) + 4) % 4]!;
    return [c[0] + r * x, c[1] + r * y];
  }
  const a = (quarter + frac) * (Math.PI / 2);
  return [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];
}

/** A circle as a counter-clockwise polygon inscribed in it, within tol of the true curve. */
export function circleLoop(centre: Pt, diameter: number, tol = CURVE_TOLERANCE_MM): Loop {
  const r = diameter / 2;
  const perQuarter = sidesFor(r, tol) / 4;
  const out: Loop = [];
  for (let q = 0; q < 4; q++) for (let k = 0; k < perQuarter; k++) out.push(onCircle(centre, r, q, k / perQuarter));
  return out;
}

/**
 * A rectangle with rounded corners, counter-clockwise. The radius is held
 * to half the shorter side, which makes a slot with round ends.
 */
export function roundedRectLoop(min: Pt, max: Pt, radius = 0, tol = CURVE_TOLERANCE_MM): Loop {
  const r = Math.min(Math.max(radius, 0), (max[0] - min[0]) / 2, (max[1] - min[1]) / 2);
  if (r <= SNAP) return rectLoop(min, max);
  const perQuarter = sidesFor(r, tol) / 4;
  // Each corner's centre, and the quarter turn its arc starts on.
  const corners: [Pt, number][] = [
    [[max[0] - r, min[1] + r], -1],
    [[max[0] - r, max[1] - r], 0],
    [[min[0] + r, max[1] - r], 1],
    [[min[0] + r, min[1] + r], 2],
  ];
  const out: Loop = [];
  for (const [c, q] of corners) {
    for (let k = 0; k < perQuarter; k++) out.push(onCircle(c, r, q, k / perQuarter));
    out.push(onCircle(c, r, q + 1, 0));
  }
  return tidy(out);
}

// ---------------------------------------------------------------------------
// Tracing a region

/** Gives each distinct point a number, treating points within SNAP as one. */
class PointPool {
  readonly pts: Pt[] = [];
  private grid = new Map<string, number[]>();

  id(p: Pt): number {
    const gx = Math.floor(p[0] / CELL);
    const gy = Math.floor(p[1] / CELL);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const k of this.grid.get(`${gx + dx},${gy + dy}`) ?? []) if (near(this.pts[k]!, p)) return k;
      }
    }
    const k = this.pts.push(p) - 1;
    const key = `${gx},${gy}`;
    this.grid.set(key, [...(this.grid.get(key) ?? []), k]);
    return k;
  }
}

/** Where p sits along a→b, from 0 to 1, when it lies on the segment. */
function paramOn(p: Pt, a: Pt, b: Pt): number | null {
  const d = sub(b, a);
  const l2 = dot(d, d);
  if (l2 <= SNAP * SNAP) return null;
  const t = Math.min(1, Math.max(0, dot(sub(p, a), d) / l2));
  return near(lerp(a, b, t), p) ? t : null;
}

/** Notes where two segments meet, as a place along each to split it. */
function meet(s: [Pt, Pt], r: [Pt, Pt], ts: number[], tr: number[]) {
  // An end lying on the other segment: a T, a shared corner or an overlap.
  for (const p of r) {
    const t = paramOn(p, s[0], s[1]);
    if (t !== null) ts.push(t);
  }
  for (const p of s) {
    const t = paramOn(p, r[0], r[1]);
    if (t !== null) tr.push(t);
  }
  // A clean crossing.
  const d1 = sub(s[1], s[0]);
  const d2 = sub(r[1], r[0]);
  const den = cross(d1, d2);
  if (Math.abs(den) <= 1e-12 * len(d1) * len(d2)) return;
  const w = sub(r[0], s[0]);
  const t = cross(w, d2) / den;
  const u = cross(w, d1) / den;
  if (t > 0 && t < 1 && u > 0 && u < 1) {
    ts.push(t);
    tr.push(u);
  }
}

/** Every segment split wherever another one meets it. */
function splitAll(segs: [Pt, Pt][], pool: PointPool): [number, number][] {
  const ts = segs.map(() => [0, 1]);
  const box = segs.map(([a, b]) => [
    Math.min(a[0], b[0]) - SNAP,
    Math.max(a[0], b[0]) + SNAP,
    Math.min(a[1], b[1]) - SNAP,
    Math.max(a[1], b[1]) + SNAP,
  ]);
  // Sweep left to right, so only segments that overlap across x are compared.
  const order = segs.map((_, i) => i).sort((i, j) => box[i]![0]! - box[j]![0]!);
  for (let oi = 0; oi < order.length; oi++) {
    const i = order[oi]!;
    for (let oj = oi + 1; oj < order.length; oj++) {
      const j = order[oj]!;
      if (box[j]![0]! > box[i]![1]!) break;
      if (box[j]![2]! > box[i]![3]! || box[j]![3]! < box[i]![2]!) continue;
      meet(segs[i]!, segs[j]!, ts[i]!, ts[j]!);
    }
  }
  const edges = new Map<string, [number, number]>();
  segs.forEach(([a, b], i) => {
    const ids = [...new Set(ts[i])].sort((x, y) => x - y).map((t) => pool.id(t === 0 ? a : t === 1 ? b : lerp(a, b, t)));
    for (let k = 0; k + 1 < ids.length; k++) {
      const [p, q] = [ids[k]!, ids[k + 1]!];
      if (p === q) continue;
      edges.set(p < q ? `${p},${q}` : `${q},${p}`, [p, q]);
    }
  });
  return [...edges.values()];
}

/** Drops corners that sit on a straight line between their neighbours. */
function straighten(loop: Loop): Loop {
  let out = loop;
  for (let changed = true; changed && out.length > 3; ) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i + out.length - 1) % out.length]!;
      const p = out[i]!;
      const b = out[(i + 1) % out.length]!;
      const d = sub(b, a);
      const l = len(d);
      if (l > SNAP && Math.abs(cross(d, sub(p, a))) / l <= SNAP && dot(sub(p, a), sub(b, p)) >= 0) {
        out = [...out.slice(0, i), ...out.slice(i + 1)];
        changed = true;
        break;
      }
    }
  }
  return out;
}

/**
 * The boundary of a region, as loops with the region on their left: each
 * outline runs counter-clockwise and each hole clockwise. Every edge of the
 * region lies along an edge of one of the source loops, and `inside` says
 * which points belong to it. The source edges are split wherever they meet,
 * and a piece is kept when the region lies on one side of it and not the
 * other. Shared and overlapping edges come out once, so a notch flush with
 * the blank's edge needs no special case.
 *
 * Two pieces that touch at a single corner come out as two loops, since
 * wood joined at a point isn't joined.
 */
export function traceRegion(sources: Loop[], inside: (p: Pt) => boolean): Loop[] {
  const segs: [Pt, Pt][] = [];
  for (const loop of sources) for (const [a, b] of edgesOf(loop)) if (!near(a, b)) segs.push([a, b]);
  const pool = new PointPool();
  const directed: [number, number][] = [];
  for (const [i, j] of splitAll(segs, pool)) {
    const a = pool.pts[i]!;
    const b = pool.pts[j]!;
    const d = sub(b, a);
    const l = len(d);
    const m = lerp(a, b, 0.5);
    const n: Pt = [(-d[1] / l) * SIDE, (d[0] / l) * SIDE];
    const left = inside([m[0] + n[0], m[1] + n[1]]);
    const right = inside([m[0] - n[0], m[1] - n[1]]);
    if (left === right) continue;
    directed.push(left ? [i, j] : [j, i]);
  }

  const leaving = new Map<number, number[]>();
  directed.forEach(([from], k) => leaving.set(from, [...(leaving.get(from) ?? []), k]));
  const dir = (k: number) => sub(pool.pts[directed[k]![1]]!, pool.pts[directed[k]![0]]!);
  const used = directed.map(() => false);
  const loops: Loop[] = [];
  for (let first = 0; first < directed.length; first++) {
    if (used[first]) continue;
    used[first] = true;
    const ids = [directed[first]![0]];
    let cur = first;
    for (let guard = 0; guard <= directed.length; guard++) {
      const at = directed[cur]![1];
      const din = dir(cur);
      // At a corner where pieces touch, turn hardest left to stay on this piece.
      let best = -1;
      let bestTurn = -Infinity;
      for (const k of leaving.get(at) ?? []) {
        if (used[k] && k !== first) continue;
        const dout = dir(k);
        const turn = Math.atan2(cross(din, dout), dot(din, dout));
        if (turn > bestTurn) {
          bestTurn = turn;
          best = k;
        }
      }
      if (best < 0) break;
      if (best === first) {
        const loop = straighten(ids.map((id) => pool.pts[id]!));
        if (loop.length >= 3 && Math.abs(signedArea(loop)) > 1e-6) loops.push(loop);
        break;
      }
      used[best] = true;
      ids.push(at);
      cur = best;
    }
  }
  return loops;
}

/** Traced loops grouped into pieces, each an outline with the holes inside it, the biggest first. */
export function piecesOf(loops: Loop[]): { outline: Loop; holes: Loop[] }[] {
  const outlines = loops.filter((l) => signedArea(l) > 0).sort((a, b) => signedArea(b) - signedArea(a));
  const pieces = outlines.map((outline) => ({ outline, holes: [] as Loop[] }));
  for (const hole of loops.filter((l) => signedArea(l) < 0)) {
    // A point just inside the hole, off the middle of its first edge.
    const [a, b] = [hole[0]!, hole[1]!];
    const d = sub(b, a);
    const l = len(d);
    const m = lerp(a, b, 0.5);
    const probe: Pt = [m[0] + (d[1] / l) * SIDE, m[1] - (d[0] / l) * SIDE];
    const home = [...pieces].reverse().find((p) => pointInLoop(probe, p.outline));
    home?.holes.push(hole);
  }
  return pieces;
}

// ---------------------------------------------------------------------------
// Distances and stretches

function pointToSegment(p: Pt, a: Pt, b: Pt): number {
  const d = sub(b, a);
  const l2 = dot(d, d);
  const t = l2 === 0 ? 0 : Math.min(1, Math.max(0, dot(sub(p, a), d) / l2));
  return len(sub(p, lerp(a, b, t)));
}

/** The shortest distance between two segments, 0 when they cross. */
export function segmentDistance(a0: Pt, a1: Pt, b0: Pt, b1: Pt): number {
  const o1 = cross(sub(a1, a0), sub(b0, a0));
  const o2 = cross(sub(a1, a0), sub(b1, a0));
  const o3 = cross(sub(b1, b0), sub(a0, b0));
  const o4 = cross(sub(b1, b0), sub(a1, b0));
  if (o1 * o2 < 0 && o3 * o4 < 0) return 0;
  return Math.min(pointToSegment(a0, b0, b1), pointToSegment(a1, b0, b1), pointToSegment(b0, a0, a1), pointToSegment(b1, a0, a1));
}

/**
 * The smallest distance between two outlines, such as the web of wood left
 * between a hole and the edge. It's 0 when they touch or cross.
 */
export function outlineDistance(a: Loop, b: Loop): number {
  let least = Infinity;
  for (const [a0, a1] of edgesOf(a)) for (const [b0, b1] of edgesOf(b)) least = Math.min(least, segmentDistance(a0, a1, b0, b1));
  return least;
}

/** Joins overlapping or touching spans, in order. */
function mergeSpans(spans: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [lo, hi] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1];
    if (last && lo <= last[1] + SNAP) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}

/**
 * Where a region's edge still runs along the line where coordinate `axis`
 * equals `at`, between lo and hi on the other axis. On a blank's face line,
 * these are the stretches of that face no cut has touched.
 */
export function uncutStretches(loops: Loop[], axis: 0 | 1, at: number, lo: number, hi: number): [number, number][] {
  const o = (1 - axis) as 0 | 1;
  const spans: [number, number][] = [];
  for (const loop of loops) {
    for (const [a, b] of edgesOf(loop)) {
      if (Math.abs(a[axis] - at) > SNAP || Math.abs(b[axis] - at) > SNAP) continue;
      const s0 = Math.max(lo, Math.min(a[o], b[o]));
      const s1 = Math.min(hi, Math.max(a[o], b[o]));
      if (s1 - s0 > SNAP) spans.push([s0, s1]);
    }
  }
  return mergeSpans(spans);
}

/** The stretches of the line where coordinate `axis` equals `at` that lie inside the region. */
export function sliceIntervals(loops: Loop[], axis: 0 | 1, at: number): [number, number][] {
  const o = (1 - axis) as 0 | 1;
  const xs: number[] = [];
  for (const loop of loops) {
    for (const [a, b] of edgesOf(loop)) {
      if (a[axis] > at !== b[axis] > at) xs.push(a[o] + ((b[o] - a[o]) * (at - a[axis])) / (b[axis] - a[axis]));
    }
  }
  xs.sort((p, q) => p - q);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < xs.length; i += 2) out.push([xs[i]!, xs[i + 1]!]);
  return out;
}

/**
 * sliceIntervals for many places along one axis. The edges are sorted into
 * buckets along it, so each slice reads only the edges near it, and every
 * slice comes out the same as sliceIntervals gives.
 */
export function slicer(loops: Loop[], axis: 0 | 1): (at: number) => [number, number][] {
  const edges = loops.flatMap(edgesOf);
  if (edges.length < 64) return (at) => sliceIntervals(loops, axis, at);
  const vs = edges.map(([a]) => a[axis]);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const n = Math.ceil(Math.sqrt(edges.length));
  const w = (hi - lo) / n || 1;
  const bucket = (v: number) => Math.min(n - 1, Math.max(0, Math.floor((v - lo) / w)));
  const buckets: [Pt, Pt][][] = Array.from({ length: n }, () => []);
  for (const [a, b] of edges) {
    for (let i = bucket(Math.min(a[axis], b[axis])); i <= bucket(Math.max(a[axis], b[axis])); i++) buckets[i]!.push([a, b]);
  }
  const o = (1 - axis) as 0 | 1;
  return (at) => {
    const xs: number[] = [];
    for (const [a, b] of buckets[bucket(at)]!) {
      if (a[axis] > at !== b[axis] > at) xs.push(a[o] + ((b[o] - a[o]) * (at - a[axis])) / (b[axis] - a[axis]));
    }
    xs.sort((p, q) => p - q);
    const out: [number, number][] = [];
    for (let i = 0; i + 1 < xs.length; i += 2) out.push([xs[i]!, xs[i + 1]!]);
    return out;
  };
}

/** How much two sets of spans share. */
function sharedLength(a: [number, number][], b: [number, number][]): number {
  let total = 0;
  for (const [a0, a1] of a) for (const [b0, b1] of b) total += Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  return total;
}

// ---------------------------------------------------------------------------
// Overlap between solids

/**
 * A part's solid: its face region on axes u and v, in world mm, carried
 * from t_mm[0] to t_mm[1] along the third axis.
 */
export interface Prism {
  u: Axis;
  v: Axis;
  loops: Loop[];
  t_mm: [number, number];
}

const thirdAxis = (p: Prism): Axis => AXES.find((a) => a !== p.u && a !== p.v)!;

/**
 * Slices along one axis at every place where the answer can change, and
 * tests each slice at its middle. The overlap counts once the slices that
 * overlap by more than eps run on for more than eps.
 */
function slicesOverlap(breaks: number[], lo: number, hi: number, eps: number, overlapAt: (c: number) => boolean): boolean {
  const cuts = [...new Set([lo, hi, ...breaks.filter((b) => b > lo && b < hi)])].sort((a, b) => a - b);
  let run = 0;
  for (let i = 0; i + 1 < cuts.length; i++) {
    const w = cuts[i + 1]! - cuts[i]!;
    if (w <= 0) continue;
    if (overlapAt((cuts[i]! + cuts[i + 1]!) / 2)) {
      run += w;
      if (run > eps) return true;
    } else run = 0;
  }
  return false;
}

const span = (loops: Loop[], axis: 0 | 1): [number, number] => {
  const vs = loops.flatMap((l) => l.map((p) => p[axis]));
  return [Math.min(...vs), Math.max(...vs)];
};

/** Whether two flat regions in the same axes overlap by more than eps both ways. */
export function regionsOverlap(a: Loop[], b: Loop[], eps = 0.01): boolean {
  const [a0, a1] = span(a, 0);
  const [b0, b1] = span(b, 0);
  const lo = Math.max(a0, b0);
  const hi = Math.min(a1, b1);
  if (hi - lo <= eps) return false;
  const breaks = [...a, ...b].flatMap((l) => l.map((p) => p[0]));
  // Where an edge of one crosses an edge of the other, the overlap can start or stop.
  for (const la of a) {
    for (const [p, q] of edgesOf(la)) {
      for (const lb of b) {
        for (const [r, s] of edgesOf(lb)) {
          const d1 = sub(q, p);
          const d2 = sub(s, r);
          const den = cross(d1, d2);
          if (den === 0) continue;
          const w = sub(r, p);
          const t = cross(w, d2) / den;
          const u = cross(w, d1) / den;
          if (t >= 0 && t <= 1 && u >= 0 && u <= 1) breaks.push(p[0] + d1[0] * t);
        }
      }
    }
  }
  const sa = slicer(a, 0);
  const sb = slicer(b, 0);
  return slicesOverlap(breaks, lo, hi, eps, (c) => sharedLength(sa(c), sb(c)) > eps);
}

/**
 * Whether two solids overlap by more than eps every way, exactly for
 * straight edges. Two parts lying the same way overlap when their
 * thicknesses do and their faces do. Two lying different ways share one
 * axis in both their faces, and they're sliced along it. Each slice of one
 * is a set of spans carried through its thickness, so the slices meet when
 * each one's spans reach into the other's thickness.
 */
export function prismsOverlap(a: Prism, b: Prism, eps = 0.01): boolean {
  const ta = thirdAxis(a);
  const tb = thirdAxis(b);
  if (ta === tb) {
    if (Math.min(a.t_mm[1], b.t_mm[1]) - Math.max(a.t_mm[0], b.t_mm[0]) <= eps) return false;
    const bl = b.u === a.u ? b.loops : b.loops.map((l) => l.map(([x, y]) => [y, x] as Pt));
    return regionsOverlap(a.loops, bl, eps);
  }
  const s = AXES.find((x) => x !== ta && x !== tb)!;
  const ia: 0 | 1 = a.u === s ? 0 : 1;
  const ib: 0 | 1 = b.u === s ? 0 : 1;
  const [as0, as1] = span(a.loops, ia);
  const [bs0, bs1] = span(b.loops, ib);
  const lo = Math.max(as0, bs0);
  const hi = Math.min(as1, bs1);
  if (hi - lo <= eps) return false;
  const breaks = [...a.loops.flatMap((l) => l.map((p) => p[ia])), ...b.loops.flatMap((l) => l.map((p) => p[ib]))];
  // Where an edge crosses the other part's faces, its slice can start or stop reaching into it.
  const crossings = (loops: Loop[], i: 0 | 1, levels: [number, number]) => {
    const o = (1 - i) as 0 | 1;
    for (const loop of loops) {
      for (const [p, q] of edgesOf(loop)) {
        for (const level of levels) {
          if ((p[o] - level) * (q[o] - level) < 0) breaks.push(p[i] + ((q[i] - p[i]) * (level - p[o])) / (q[o] - p[o]));
        }
      }
    }
  };
  crossings(a.loops, ia, b.t_mm);
  crossings(b.loops, ib, a.t_mm);
  const sa = slicer(a.loops, ia);
  const sb = slicer(b.loops, ib);
  return slicesOverlap(
    breaks,
    lo,
    hi,
    eps,
    (c) => sharedLength(sa(c), [b.t_mm]) > eps && sharedLength(sb(c), [a.t_mm]) > eps,
  );
}

// ---------------------------------------------------------------------------
// The gap between solids

type Span = [number, number];

/**
 * The gap between two sets of stretches on one line. For each pair it's the
 * larger start less the smaller end, which is the clear space between them,
 * or minus their overlap where they overlap. The smallest pair counts.
 */
export function spanGap(a: Span[], b: Span[]): number {
  let least = Infinity;
  for (const [a0, a1] of a) for (const [b0, b1] of b) least = Math.min(least, Math.max(a0, b0) - Math.min(a1, b1));
  return least;
}

/** Where the edges of one set of loops cross another's, or a level line, as places along the first coordinate. */
function crossingsOf(a: Loop[], b: Loop[]): number[] {
  const out: number[] = [];
  for (const la of a) {
    for (const [p, q] of edgesOf(la)) {
      for (const lb of b) {
        for (const [r, s] of edgesOf(lb)) {
          const d1 = sub(q, p);
          const d2 = sub(s, r);
          const den = cross(d1, d2);
          if (den === 0) continue;
          const w = sub(r, p);
          const t = cross(w, d2) / den;
          const u = cross(w, d1) / den;
          if (t >= 0 && t <= 1 && u >= 0 && u <= 1) out.push(p[0] + d1[0] * t);
        }
      }
    }
  }
  return out;
}

function levelCrossings(loops: Loop[], levels: number[]): number[] {
  const out: number[] = [];
  for (const loop of loops) {
    for (const [p, q] of edgesOf(loop)) {
      for (const level of levels) {
        if ((p[1] - level) * (q[1] - level) < 0) out.push(p[0] + ((q[0] - p[0]) * (level - p[1])) / (q[1] - p[1]));
      }
    }
  }
  return out;
}

/** A prism's loops with its coordinates in the order asked for. */
const ordered = (p: Prism, first: Axis): Loop[] => (p.u === first ? p.loops : p.loops.map((l) => l.map(([x, y]): Pt => [y, x])));

/** The places between lo and hi where a sweep stops, in order, with every break inside. */
function stops(breaks: number[], lo: number, hi: number): number[] {
  return [...new Set([lo, hi, ...breaks.filter((b) => b > lo && b < hi)])].sort((a, b) => a - b);
}

/** Each stretch at a strip's two ends, read off a straight line through two samples inside it. */
function stretchesAtEnds(at: (c: number) => Span[], c0: number, c1: number): [Span[], Span[]] | null {
  const s1 = c0 + (c1 - c0) / 3;
  const s2 = c0 + ((c1 - c0) * 2) / 3;
  const a = at(s1);
  const b = at(s2);
  if (a.length !== b.length) return null;
  const end = (c: number): Span[] => a.map(([x0, x1], i) => [x0 + ((b[i]![0] - x0) * (c - s1)) / (s2 - s1), x1 + ((b[i]![1] - x1) * (c - s1)) / (s2 - s1)]);
  return [end(c0), end(c1)];
}

/**
 * One solid seen along a sweep: at each place c on the sweep axis, the
 * stretches it fills along the measuring axis, and the stretches it fills
 * across, on the third axis.
 */
interface Sweep {
  lo: number;
  hi: number;
  breaks: number[];
  /** The loops in sweep and measuring coordinates, when it has an edge towards the measuring axis. */
  side?: Loop[];
  /** The loops in sweep and across coordinates, when it lies flat across the measuring axis. */
  flat?: Loop[];
  t_mm: Span;
  along(c: number): Span[];
  across(c: number): Span[];
}

function sweepOf(p: Prism, axis: Axis, s: Axis): Sweep {
  const loops = ordered(p, s);
  const [lo, hi] = span(loops, 0);
  const breaks = loops.flatMap((l) => l.map((q) => q[0]));
  if (thirdAxis(p) === axis) {
    const across = slicer(loops, 0);
    return { lo, hi, breaks, flat: loops, t_mm: p.t_mm, across, along: (c) => (across(c).length ? [p.t_mm] : []) };
  }
  const along = slicer(loops, 0);
  return { lo, hi, breaks, side: loops, t_mm: p.t_mm, along, across: (c) => (along(c).length ? [p.t_mm] : []) };
}

/**
 * The gap along one axis between two solids, exactly for straight edges. It
 * looks along the axis wherever the two solids line up across it, and takes
 * the smallest gap over all of those places. Positive is clear space, and
 * negative is the deepest the two overlap along the axis. Two boxes give
 * the larger of their starts less the smaller of their ends.
 *
 * It's null when the two don't line up across the axis by more than eps
 * both ways, so there's nowhere to measure.
 */
export function prismGap(a: Prism, b: Prism, axis: Axis, eps = 0.01): number | null {
  const ta = thirdAxis(a);
  const tb = thirdAxis(b);
  // Both flat across the axis: their thicknesses, wherever their faces overlap.
  if (ta === axis && tb === axis) {
    return regionsOverlap(a.loops, ordered(b, a.u), eps) ? tidyGap(spanGap([a.t_mm], [b.t_mm])) : null;
  }
  // Each one stands on edge towards the axis, at right angles to the other.
  if (ta !== axis && tb !== axis && ta !== tb) return crossedGap(a, b, axis, eps);
  // Otherwise one sweep across the axis reads both: along the face axis of
  // whichever stands on edge, since a flat one lies across both.
  const s = AXES.find((x) => x !== axis && x !== (ta === axis ? tb : ta))!;
  const sa = sweepOf(a, axis, s);
  const sb = sweepOf(b, axis, s);
  const lo = Math.max(sa.lo, sb.lo);
  const hi = Math.min(sa.hi, sb.hi);
  if (hi - lo <= eps) return null;
  const breaks = [...sa.breaks, ...sb.breaks];
  // Where the answer can bend: an edge crossing the other's edge or faces.
  for (const [x, y] of [
    [sa, sb],
    [sb, sa],
  ] as const) {
    if (x.flat && y.side) breaks.push(...levelCrossings(x.flat, y.t_mm), ...levelCrossings(y.side, x.t_mm));
  }
  if (sa.side && sb.side) breaks.push(...crossingsOf(sa.side, sb.side));
  const cuts = stops(breaks, lo, hi);
  let shared = 0;
  let least = Infinity;
  for (let i = 0; i + 1 < cuts.length; i++) {
    const [c0, c1] = [cuts[i]!, cuts[i + 1]!];
    if (c1 - c0 <= 1e-9) continue;
    const m = (c0 + c1) / 2;
    if (!sa.along(m).length || !sb.along(m).length || sharedLength(sa.across(m), sb.across(m)) <= eps) continue;
    shared += c1 - c0;
    least = Math.min(least, spanGap(sa.along(m), sb.along(m)));
    const ea = stretchesAtEnds(sa.along, c0, c1);
    const eb = stretchesAtEnds(sb.along, c0, c1);
    if (ea && eb) least = Math.min(least, spanGap(ea[0], eb[0]), spanGap(ea[1], eb[1]));
  }
  return shared > eps ? tidyGap(least) : null;
}

/** Clears the float noise a straight line read off two samples leaves, at a millionth of a mm. */
const tidyGap = (g: number) => Math.round(g * 1e6) / 1e6 + 0;

/** A straight line over a strip: its value at the strip's start, and its slope. */
type Line = { at: number; k: number };

/** Each stretch over a strip as two straight lines, from samples inside it. */
function linesOver(at: (c: number) => Span[], c0: number, c1: number): [Line, Line][] | null {
  const ends = stretchesAtEnds(at, c0, c1);
  if (!ends) return null;
  const w = c1 - c0;
  return ends[0].map(([x0, x1], i) => {
    const [y0, y1] = ends[1][i]!;
    return [
      { at: x0, k: (y0 - x0) / w },
      { at: x1, k: (y1 - x1) / w },
    ];
  });
}

/**
 * The gap between two solids on edge towards the axis, at right angles to
 * each other, such as a drawer side and a drawer back. One's stretches
 * change across p and the other's across q, so each cell of the two sweeps
 * is searched where the answer can bend: its corners, and where the
 * stretches' starts or ends meet.
 */
function crossedGap(a: Prism, b: Prism, axis: Axis, eps: number): number | null {
  // a's face lies on axis and p, so its thickness runs across q, and b the other way round.
  const p = AXES.find((x) => x !== axis && x !== thirdAxis(a))!;
  const q = thirdAxis(a);
  const la = ordered(a, p);
  const lb = ordered(b, q);
  const strips = (loops: Loop[], t: Span) => {
    const [lo0, hi0] = span(loops, 0);
    const lo = Math.max(lo0, t[0]);
    const hi = Math.min(hi0, t[1]);
    const cuts = stops([...loops.flatMap((l) => l.map((pt) => pt[0])), ...t], lo, hi);
    const at = slicer(loops, 0);
    const out: { c0: number; c1: number; lines: [Line, Line][] | null; mid: Span[] }[] = [];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const [c0, c1] = [cuts[i]!, cuts[i + 1]!];
      if (c1 - c0 <= 1e-9) continue;
      const mid = at((c0 + c1) / 2);
      if (mid.length) out.push({ c0, c1, mid, lines: linesOver(at, c0, c1) });
    }
    return out;
  };
  const sp = strips(la, b.t_mm);
  const sq = strips(lb, a.t_mm);
  const width = (s: { c0: number; c1: number }[]) => s.reduce((n, x) => n + x.c1 - x.c0, 0);
  if (width(sp) <= eps || width(sq) <= eps) return null;
  let least = Infinity;
  for (const cp of sp) {
    for (const cq of sq) {
      least = Math.min(least, spanGap(cp.mid, cq.mid));
      if (!cp.lines || !cq.lines) continue;
      for (const [a0, a1] of cp.lines) {
        for (const [b0, b1] of cq.lines) {
          const val = (x: Line, c: number, c0: number) => x.at + x.k * (c - c0);
          const g = (pp: number, qq: number) => Math.max(val(a0, pp, cp.c0), val(b0, qq, cq.c0)) - Math.min(val(a1, pp, cp.c0), val(b1, qq, cq.c0));
          const ps = [cp.c0, cp.c1];
          const qs = [cq.c0, cq.c1];
          const pts: Pt[] = ps.flatMap((pp) => qs.map((qq): Pt => [pp, qq]));
          // Where a's start or end meets b's along an edge of the cell.
          for (const [x, y] of [
            [a0, b0],
            [a1, b1],
          ] as const) {
            for (const pp of ps) if (y.k !== 0) pts.push([pp, cq.c0 + (val(x, pp, cp.c0) - y.at) / y.k]);
            for (const qq of qs) if (x.k !== 0) pts.push([cp.c0 + (val(y, qq, cq.c0) - x.at) / x.k, qq]);
          }
          // Where both meet at once, inside the cell.
          const det = b0.k * a1.k - a0.k * b1.k;
          if (Math.abs(det) > 1e-12) {
            const r0 = b0.at - a0.at;
            const r1 = b1.at - a1.at;
            const dp = (b0.k * r1 - b1.k * r0) / det;
            const dq = (a0.k * r1 - a1.k * r0) / det;
            pts.push([cp.c0 + dp, cq.c0 + dq]);
          }
          for (const [pp, qq] of pts) {
            if (pp < cp.c0 - 1e-9 || pp > cp.c1 + 1e-9 || qq < cq.c0 - 1e-9 || qq > cq.c1 + 1e-9) continue;
            least = Math.min(least, g(pp, qq));
          }
        }
      }
    }
  }
  return tidyGap(least);
}
