// Joints on parts with cuts. A joint is placed where two blanks meet, and a
// cut can take some of that wood away. These work out how much of a joint's
// contact is still wood, which cuts get in a joint's way, and the walls left
// round a slot, from each part's shape. A part with no cuts is its box, so
// none of this runs for it.

import type { Box, DerivedPart } from "./derive.js";
import { faceAxes, type CutRegion, type SolvedFace } from "./profile.js";
import { clipRect, pointInRegion, rectLoop, regionArea, signedArea, sliceIntervals, traceRegion, uncutStretches, type Loop, type Pt } from "./shape.js";
import type { SlotWall } from "./joints.js";
import { AXES, FACE_AXIS, FACE_IS_MAX, type Axis, type Face } from "./types.js";

const IDX: Record<Axis, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };
/** Below this, a stretch or a size counts as nothing, as in the checks. */
const EPS = 0.01;

/** The two axes across a contact on `axis`, in x, y, z order. A patch on that contact uses them as its two coordinates. */
export const acrossAxes = (axis: Axis): [Axis, Axis] => AXES.filter((a) => a !== axis) as [Axis, Axis];

/** A box's rectangle on two axes. */
const rectOn = (b: Box, [p, q]: [Axis, Axis]): Loop => rectLoop([b.min[IDX[p]], b.min[IDX[q]]], [b.max[IDX[p]], b.max[IDX[q]]]);

/**
 * The wood a part has on one face of its blank, on the two axes across that
 * face, in world mm. On a broad face it's the outline less its holes. On an
 * edge or an end it's the stretches no cut has touched, through the
 * thickness. A part with no shape has its whole face.
 */
export function woodOnFace(p: DerivedPart, face: SolvedFace | null, f: Face): Loop[] {
  const axis = FACE_AXIS[f];
  const plane = acrossAxes(axis);
  if (!face) return [rectOn(p.nominal, plane)];
  const [u, v] = faceAxes(p.thickness_axis);
  const o: Pt = [p.nominal.min[IDX[u]], p.nominal.min[IDX[v]]];
  // A point on u and v, in the plane's order.
  const put = (a: number, b: number): Pt => (plane[0] === u ? [a, b] : [b, a]);
  if (axis === p.thickness_axis) {
    return [face.outline, ...face.holes.map((h) => h.points_mm)].map((l) => {
      const moved = l.map(([a, b]) => put(a + o[0], b + o[1]));
      // Swapping the coordinates turns a loop round, so turn it back.
      return plane[0] === u ? moved : moved.reverse();
    });
  }
  const i: 0 | 1 = axis === u ? 0 : 1;
  const w: Axis = i === 0 ? v : u;
  const t = p.thickness_axis;
  const stretches = uncutStretches([face.outline], i, FACE_IS_MAX[f] ? face.size[i] : 0, 0, face.size[1 - i]!);
  const lo = p.nominal.min[IDX[t]];
  const hi = p.nominal.max[IDX[t]];
  return stretches.map(([s0, s1]) => {
    const w0 = s0 + p.nominal.min[IDX[w]];
    const w1 = s1 + p.nominal.min[IDX[w]];
    return plane[0] === w ? rectLoop([w0, lo], [w1, hi]) : rectLoop([lo, w0], [hi, w1]);
  });
}

/**
 * Where two parts meet across `axis`, the part of their patch where both
 * still have wood, on the two axes across the contact. Its area is next to
 * the patch's own.
 */
export function contactWood(
  guest: { part: DerivedPart; face: SolvedFace | null; on: Face },
  host: { part: DerivedPart; face: SolvedFace | null; on: Face },
  axis: Axis,
  patch: Box,
): { loops: Loop[]; area: number; full: number } {
  const plane = acrossAxes(axis);
  const rect = rectOn(patch, plane);
  const [min, max] = [rect[0]!, rect[2]!];
  const g = woodOnFace(guest.part, guest.face, guest.on);
  const h = woodOnFace(host.part, host.face, host.on);
  const inRect = (p: Pt) => p[0] > min[0] && p[0] < max[0] && p[1] > min[1] && p[1] < max[1];
  const loops = traceRegion([rect, ...g, ...h], (p) => inRect(p) && pointInRegion(p, g) && pointInRegion(p, h));
  return { loops, area: regionArea(loops), full: (max[0] - min[0]) * (max[1] - min[1]) };
}

/**
 * The stretches along `lAxis` where fasteners can go in a contact's wood:
 * along the line across its middle at `across`, or where the wood reaches
 * when that line misses it. They're joined and in order.
 */
export function fastenerStretches(loops: Loop[], axis: Axis, tAxis: Axis, across: number): [number, number][] {
  const plane = acrossAxes(axis);
  const ti: 0 | 1 = plane[0] === tAxis ? 0 : 1;
  const line = sliceIntervals(loops, ti, across).filter(([a, b]) => b - a > EPS);
  if (line.length) return line;
  const li = (1 - ti) as 0 | 1;
  const spans = loops
    .filter((l) => signedArea(l) > 0)
    .map((l): [number, number] => [Math.min(...l.map((p) => p[li])), Math.max(...l.map((p) => p[li]))])
    .sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [a, b] of spans) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Where fastener k of n goes, spread evenly over the stretches' total length. */
export function spreadOver(stretches: [number, number][], k: number, n: number): number {
  const total = stretches.reduce((s, [a, b]) => s + b - a, 0);
  let d = ((k + 0.5) / n) * total;
  for (const [a, b] of stretches) {
    if (d <= b - a) return a + d;
    d -= b - a;
  }
  return stretches[stretches.length - 1]![1];
}

/** A cut that takes wood from inside a box, with the size of what it takes there on the part's two face axes. */
export interface CutInBox {
  id: string;
  kind: CutRegion["kind"];
  /** The world range it covers inside the box, on each of the part's face axes. */
  span: Partial<Record<Axis, [number, number]>>;
}

/**
 * The cuts on a part that take wood from inside a box. Only the box's
 * footprint on the part's face counts, since a cut goes right through. A
 * box flat on one of the face axes, such as a patch on an end, is read as
 * a thin band just inside the blank there.
 */
export function cutsInBox(p: DerivedPart, face: SolvedFace | null, box: Box, kinds: CutRegion["kind"][] = ["edge", "cutout"]): CutInBox[] {
  if (!face) return [];
  const [u, v] = faceAxes(p.thickness_axis);
  const lo: Pt = [box.min[IDX[u]] - p.nominal.min[IDX[u]], box.min[IDX[v]] - p.nominal.min[IDX[v]]];
  const hi: Pt = [box.max[IDX[u]] - p.nominal.min[IDX[u]], box.max[IDX[v]] - p.nominal.min[IDX[v]]];
  const band = 0.05;
  for (const i of [0, 1] as const) {
    if (hi[i] - lo[i] > 1e-9) continue;
    lo[i] -= band;
    hi[i] += band;
  }
  const out: CutInBox[] = [];
  for (const r of face.regions) {
    if (!kinds.includes(r.kind)) continue;
    const inside = clipRect(r.loop, lo, hi);
    if (inside.length < 3 || Math.abs(signedArea(inside)) <= 1e-6) continue;
    const range = (i: 0 | 1): [number, number] => {
      const off = p.nominal.min[IDX[i === 0 ? u : v]];
      return [Math.min(...inside.map((q) => q[i])) + off, Math.max(...inside.map((q) => q[i])) + off];
    };
    out.push({ id: r.id, kind: r.kind, span: { [u]: range(0), [v]: range(1) } });
  }
  return out;
}

/**
 * The host left on each side of a through slot, measured to its outline:
 * at each place along the slot, from the slot's side to where the wood
 * ends, the least of them. On the host's thickness it's the blank's.
 */
export function slotWallsOnShape(host: DerivedPart, face: SolvedFace, overlap: Box, pass: Axis): SlotWall[] {
  const [u, v] = faceAxes(host.thickness_axis);
  const loops = [face.outline, ...face.holes.map((h) => h.points_mm)];
  const local = (a: Axis, world: number) => world - host.nominal.min[IDX[a]];
  return AXES.filter((a) => a !== pass).map((a) => {
    const i = IDX[a];
    const blank: SlotWall = { lo: overlap.min[i]! - host.nominal.min[i]!, hi: host.nominal.max[i]! - overlap.max[i]!, along_length: a === host.grain_axis };
    if (a === host.thickness_axis) return blank;
    const ia: 0 | 1 = a === u ? 0 : 1;
    const b: Axis = ia === 0 ? v : u;
    const ib = (1 - ia) as 0 | 1;
    // Along the slot: across it when it goes through the broad face, or right through the host when it goes in at an edge.
    const [b0, b1] = b === pass ? [0, face.size[ib]] : [local(b, overlap.min[IDX[b]]!), local(b, overlap.max[IDX[b]]!)];
    const s0 = local(a, overlap.min[i]!);
    const s1 = local(a, overlap.max[i]!);
    const at = [b0 + 1e-6, b1 - 1e-6, ...loops.flatMap((l) => l.map((q) => q[ib])).filter((c) => c > b0 && c < b1)];
    let lo = blank.lo;
    let hi = blank.hi;
    for (const c of at) {
      const wood = sliceIntervals(loops, ib, c);
      const below = wood.find(([w0, w1]) => w0 <= s0 + 1e-9 && w1 >= s0 - 1e-9);
      const above = wood.find(([w0, w1]) => w0 <= s1 + 1e-9 && w1 >= s1 - 1e-9);
      lo = Math.min(lo, below ? s0 - below[0] : 0);
      hi = Math.min(hi, above ? above[1] - s1 : 0);
    }
    return { lo: Math.max(0, lo), hi: Math.max(0, hi), along_length: blank.along_length };
  });
}
