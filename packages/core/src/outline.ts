// A shaped part's solid, for the pictures. The profile in profile.ts is the
// shape on the part's broad face. Here it's carried through the thickness
// in world millimetres, so the 3D view, the plan views and the workshop
// drawings all draw the same solid from the same numbers. Nothing here
// changes the model, and a part with no profile has no solid: the pictures
// draw its box as they always have.

import { AXIS_INDEX, type DerivedPart, type Vec3 } from "./derive.js";
import { cutOutline } from "./profile.js";
import type { Loop, Pt } from "./shape.js";
import { AXES, AXIS_FACES, type Axis, type Face } from "./types.js";

/** One flat side of the solid around the outline or a hole, carried through the thickness. */
export interface SolidWall {
  /** The face it counts as: the edge's own for the outline, the way it looks for a hole's wall. */
  face: Face;
  /** A unit vector pointing out of the wood. */
  normal: Vec3;
  /** Its corners in world mm, counter-clockwise seen from outside the wood. */
  corners: [Vec3, Vec3, Vec3, Vec3];
  /** The loop's edge it stands on, on u and v from nominal.min. */
  edge_mm: [Pt, Pt];
}

/** One of the two broad faces: the outline with its holes. */
export interface SolidCap {
  face: Face;
  normal: Vec3;
  /** The outline, then each hole, in world mm on the face's plane. */
  loops: Vec3[][];
}

export interface Solid {
  /** The face axes, with u × v along t, the thickness axis. */
  u: Axis;
  v: Axis;
  t: Axis;
  /** The outline, then each hole, on u and v from nominal.min. The outline runs counter-clockwise and each hole clockwise. */
  loops: Loop[];
  /** The face each edge of each loop counts as, from point i to point i + 1. */
  faces: Face[][];
  /** Where the broad faces sit on the thickness axis, the lower first. */
  t_mm: [number, number];
  /** The broad faces, the one on the lower side of t first. */
  caps: [SolidCap, SolidCap];
  walls: SolidWall[];
}

type Shaped = Pick<DerivedPart, "nominal" | "profile">;

const unit = (a: Axis, sign: number): Vec3 => {
  const out: Vec3 = [0, 0, 0];
  out[AXIS_INDEX[a]] = sign;
  return out;
};

/** The face an edge of a loop looks out of, with the wood on its left. */
export function wallFace(a: Pt, b: Pt, u: Axis, v: Axis): Face {
  const out: Pt = [b[1] - a[1], a[0] - b[0]];
  return Math.abs(out[0]) >= Math.abs(out[1]) ? AXIS_FACES[u][out[0] > 0 ? 1 : 0] : AXIS_FACES[v][out[1] > 0 ? 1 : 0];
}

/** A shaped part's solid, from its profile, where its box would be. Null for a part with no profile. */
export function solidOf(p: Shaped): Solid | null {
  const pr = p.profile;
  if (!pr) return null;
  const { u, v } = pr;
  const t = AXES.find((a) => a !== u && a !== v)!;
  const [iu, iv, it] = [AXIS_INDEX[u], AXIS_INDEX[v], AXIS_INDEX[t]];
  const loops: Loop[] = [pr.outline_mm, ...pr.holes.map((h) => h.points_mm)];
  const faces: Face[][] = [pr.edge_faces, ...pr.holes.map((h) => h.points_mm.map((a, i) => wallFace(a, h.points_mm[(i + 1) % h.points_mm.length]!, u, v)))];
  const t_mm: [number, number] = [p.nominal.min[it], p.nominal.max[it]];
  const at = (q: Pt, w: number): Vec3 => {
    const out: Vec3 = [0, 0, 0];
    out[iu] = p.nominal.min[iu] + q[0];
    out[iv] = p.nominal.min[iv] + q[1];
    out[it] = w;
    return out;
  };
  const cap = (k: 0 | 1): SolidCap => ({ face: AXIS_FACES[t][k], normal: unit(t, k ? 1 : -1), loops: loops.map((l) => l.map((q) => at(q, t_mm[k]))) });
  const walls: SolidWall[] = [];
  loops.forEach((loop, li) => {
    loop.forEach((a, i) => {
      const b = loop[(i + 1) % loop.length]!;
      const d: Pt = [b[0] - a[0], b[1] - a[1]];
      const l = Math.hypot(d[0], d[1]);
      if (l <= 1e-9) return;
      const normal: Vec3 = [0, 0, 0];
      normal[iu] = d[1] / l;
      normal[iv] = -d[0] / l;
      walls.push({ face: faces[li]![i]!, normal, corners: [at(a, t_mm[0]), at(b, t_mm[0]), at(b, t_mm[1]), at(a, t_mm[1])], edge_mm: [a, b] });
    });
  });
  return { u, v, t, loops, faces, t_mm, caps: [cap(0), cap(1)], walls };
}

/**
 * The shape you cut, on the blank: the outline with its tongues, and its
 * holes, in mm along the part's length and across its width from the
 * corner of its cut box. The cutting layout draws it inside the blank.
 */
export function outlineOnBlank(p: Pick<DerivedPart, "profile" | "nominal" | "box" | "grain_axis" | "thickness_axis">): { outline: Loop; holes: Loop[] } | null {
  const pr = p.profile;
  const cut = cutOutline(p);
  if (!pr || !cut) return null;
  const off: Pt = [p.nominal.min[AXIS_INDEX[pr.u]] - p.box.min[AXIS_INDEX[pr.u]], p.nominal.min[AXIS_INDEX[pr.v]] - p.box.min[AXIS_INDEX[pr.v]]];
  const swap = pr.u !== p.grain_axis;
  const map = (l: Loop): Loop =>
    l.map(([a, b]) => {
      const x = a + off[0];
      const y = b + off[1];
      return swap ? [y, x] : [x, y];
    });
  return { outline: map(cut.outline), holes: cut.holes.map(map) };
}

/** A key that changes whenever a part's shape on its face does, and "" for a part with none. */
export function shapeSig(p: Pick<DerivedPart, "profile">): string {
  const pr = p.profile;
  return pr ? JSON.stringify([pr.u, pr.v, pr.outline_mm, pr.holes.map((h) => h.points_mm)]) : "";
}
