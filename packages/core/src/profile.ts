// A part's shape on its broad face, worked out from its cuts.
//
// The box stays the blank you cut from. Positions, joints, stock checks and
// the cutting layout all keep using it, and `part.top` is still the blank's
// top. The profile is worked out once every box is known, and nothing reads
// it back, so a cut can follow any face, its own part's included, with no
// risk of a loop.
//
// Edge cuts go first. Each one clips the blank along a line, so what's left
// stays convex. Cutouts come off after, as holes inside the outline or as
// notches where they reach it. An array copy shares its original's profile,
// the same way it shares the original's joints.

import { fmt } from "./expr.js";
import type { Box, DeriveIssue, DerivedPart, Extension, Step } from "./derive.js";
import {
  CURVE_TOLERANCE_MM,
  circleLoop,
  clipHalfPlane,
  insideConvex,
  perimeter,
  piecesOf,
  rectLoop,
  roundedRectLoop,
  signedArea,
  traceRegion,
  uncutStretches,
  pointInRegion,
  type Loop,
  type Pt,
} from "./shape.js";
import { AXIS_FACES, FACE_AXIS, FACE_IS_MAX, FACES, type Axis, type AxisSpec, type Bound, type Cutout, type EdgeCut, type Face, type Panel } from "./types.js";

export interface ProfileHole {
  /** The cutout that made it, or several joined with "+" where they overlap. */
  id: string;
  /** Clockwise, from the corner at nominal.min. */
  points_mm: Pt[];
  /** A round hole's true centre and size, from its expressions. */
  circle?: { centre_mm: Pt; diameter_mm: number };
}

export interface ProfileCut {
  id: string;
  kind: "slope" | "chamfer" | "hole" | "notch";
  /** An edge cut: the wood left across the part at the start and the end of its run, from the blank's opposite edge. */
  start_mm?: number;
  end_mm?: number;
  /** An edge cut: how far its new edge runs along the part. */
  run_mm?: number;
  /** An edge cut: the new edge's angle to the blank's edge. Reported only, never an input. */
  angle_deg?: number;
  /** The cut in workshop words, for the cut list. */
  text: string;
  /** How its positions were worked out. */
  trace: string;
}

/** A housing joint's extension, as far as the part's cuts leave it. */
export interface ProfileExtension {
  joint: string;
  /** The end of the part that goes into the host. */
  face: Face;
  depth_mm: number;
  /** The stretches of that end no cut has touched, along its other face axis, from nominal.min. Only these go into the host. */
  along_mm: [number, number][];
}

export interface PartProfile {
  /** The part's face axes. u × v is its thickness axis, so the outline runs counter-clockwise seen from that axis's positive end. */
  u: Axis;
  v: Axis;
  /** The shape you see, from the corner at nominal.min, counter-clockwise. */
  outline_mm: Pt[];
  /** The face each outline edge counts as, from point i to point i + 1. A sloped top still counts as the top. */
  edge_faces: Face[];
  holes: ProfileHole[];
  extensions: ProfileExtension[];
  /** The cuts that took wood, in the design's order. */
  cuts: ProfileCut[];
}

/** What a profile needs from derive: a cut's positions and sizes, each with its working. */
export interface CutValues {
  bound(axis: Axis, b: Bound): Step;
  span(axis: Axis, spec: AxisSpec, who: string): { start: Step; end: Step };
  number(src: string): Step;
}

/** One original part's face, solved once and shared with its copies. */
export interface SolvedFace {
  u: Axis;
  v: Axis;
  /** The blank's size on u and v. */
  size: Pt;
  outline: Loop;
  edge_faces: Face[];
  holes: ProfileHole[];
  cuts: ProfileCut[];
}

/** Below this a cut, a size or a web of wood counts as nothing, as in the checks. */
const EPS = 0.01;
/** A point this close to a line or an edge lies on it. */
const ON = 1e-5;

const IDX: Record<Axis, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };
const faceOf = (a: Axis, max: boolean): Face => AXIS_FACES[a][max ? 1 : 0];
/** The cut list's precision, 0.1 mm. */
const r1 = (n: number) => Math.round(n * 10) / 10;
const mm = (n: number) => fmt(r1(n));
const deg = (n: number) => `${Math.round(n * 10) / 10}°`;

/** A part's face axes, ordered so that u × v is its thickness axis. */
export function faceAxes(thickness: Axis): [Axis, Axis] {
  if (thickness === "x") return ["y", "z"];
  if (thickness === "y") return ["z", "x"];
  return ["x", "y"];
}

/** Names a corner the way a woodworker says it: top or bottom first, then back or front, then left or right. */
function cornerName(faces: Face[]): string {
  const order: Record<Axis, number> = { y: 0, z: 1, x: 2 };
  return [...faces].sort((a, b) => order[FACE_AXIS[a]] - order[FACE_AXIS[b]]).join(" ");
}

class CutProblem extends Error {}

/** The edge cut's line: wood goes where n·p > c. */
interface Line {
  edge: Face;
  n: Pt;
  c: number;
}

/**
 * Works out the shape of one original part from its cuts, on the blank's
 * face from its nominal box. Problems go on `issues`, once per original.
 * It returns null when the cuts take no wood or leave none.
 */
export function solveFace(panel: Panel, nominal: Box, values: CutValues, issues: DeriveIssue[]): SolvedFace | null {
  const cuts = panel.cuts ?? [];
  if (!cuts.length) return null;
  const [u, v] = faceAxes(panel.thickness_axis);
  const origin: Pt = [nominal.min[IDX[u]], nominal.min[IDX[v]]];
  const size: Pt = [nominal.max[IDX[u]] - origin[0], nominal.max[IDX[v]] - origin[1]];
  const at = (a: Axis): 0 | 1 => (a === u ? 0 : 1);
  const local = (a: Axis, world: number) => world - origin[at(a)];
  const lengthAxis = panel.grain_axis;
  const widthAxis = lengthAxis === u ? v : u;
  /** A face of the blank in words: an end where the grain runs into it, otherwise an edge. */
  const side = (f: Face) => `${f} ${FACE_AXIS[f] === lengthAxis ? "end" : "edge"}`;
  const problem = (severity: DeriveIssue["severity"], code: string, id: string, message: string, trace?: string) => {
    issues.push({ severity, code, message: `Cut ${id} on ${panel.id}: ${message}`, parts: [panel.id], ...(trace ? { trace } : {}) });
  };
  const made = new Map<string, ProfileCut>();

  // Edge cuts, each clipping what's left along its line.
  let blank: Loop = rectLoop([0, 0], size);
  const lines: Line[] = [];
  for (const cut of cuts) {
    if (cut.kind !== "edge") continue;
    let line: Line;
    let solved: ProfileCut;
    try {
      [line, solved] = edgeLine(cut);
    } catch (e) {
      problem("error", "cut_error", cut.id, (e as Error).message);
      continue;
    }
    const depths = blank.map((p) => p[0] * line.n[0] + p[1] * line.n[1] - line.c);
    if (Math.max(...depths) <= EPS) {
      problem("warning", "cut_removes_nothing", cut.id, `its line misses the wood, so it takes nothing off. Check where it starts and ends`, solved.trace);
      continue;
    }
    if (Math.min(...depths) >= -EPS) {
      problem("error", "cut_error", cut.id, `it takes off the whole of ${panel.id}. Check where it starts and ends`, solved.trace);
      continue;
    }
    blank = clipHalfPlane(blank, line.n, line.c);
    lines.push(line);
    made.set(cut.id, solved);
  }

  // Cutouts, taken out of what the edge cuts left.
  const taken: { cut: Cutout; loop: Loop; circle?: ProfileHole["circle"]; text: (kind: "hole" | "notch") => string; trace: string }[] = [];
  for (const cut of cuts) {
    if (cut.kind !== "cutout") continue;
    let shape: (typeof taken)[number];
    try {
      shape = cutoutShape(cut);
    } catch (e) {
      problem("error", "cut_error", cut.id, (e as Error).message);
      continue;
    }
    // The part of the cutout that lies on the wood, cut down to a convex piece.
    let overlap = shape.loop;
    for (const [a, b] of blank.map((p, i) => [p, blank[(i + 1) % blank.length]!] as const)) {
      const d: Pt = [b[0] - a[0], b[1] - a[1]];
      const l = Math.hypot(d[0], d[1]);
      if (l <= ON) continue;
      const n: Pt = [d[1] / l, -d[0] / l];
      overlap = clipHalfPlane(overlap, n, n[0] * a[0] + n[1] * a[1]);
      if (overlap.length < 3) break;
    }
    // Its thickness, from area and perimeter: a sliver under EPS takes nothing.
    const thick = overlap.length >= 3 ? (2 * Math.abs(signedArea(overlap))) / perimeter(overlap) : 0;
    const within = taken.find((t) => overlap.every((p) => insideConvex(p, t.loop) >= -ON));
    if (thick <= EPS || within) {
      const why = within ? `it sits inside cutout ${within.cut.id}` : "it misses the wood";
      problem("warning", "cut_removes_nothing", cut.id, `${why}, so it takes nothing off. Check where it sits`, shape.trace);
      continue;
    }
    taken.push(shape);
  }

  if (!made.size && !taken.length) return null;

  const loops = taken.length
    ? traceRegion([blank, ...taken.map((t) => t.loop)], (p) => insideConvex(p, blank) > 0 && taken.every((t) => insideConvex(p, t.loop) < 0))
    : [blank];
  const pieces = piecesOf(loops);
  if (!pieces.length) {
    issues.push({ severity: "error", code: "cut_error", message: `The cuts on ${panel.id} leave nothing of it. Check their positions`, parts: [panel.id] });
    return null;
  }
  if (pieces.length > 1) {
    issues.push({
      severity: "error",
      code: "cut_severs",
      message: `The cuts on ${panel.id} split it into ${pieces.length} pieces. A part has to stay in one piece, so move the cutouts or make each piece a part of its own`,
      parts: [panel.id],
    });
  }
  const piece = pieces[0]!;
  const outline = startAtCorner(piece.outline);
  const onCutout = (loop: Loop, t: (typeof taken)[number]) => loop.some((p) => Math.abs(insideConvex(p, t.loop)) <= ON);
  for (const t of taken) {
    const kind = onCutout(outline, t) ? "notch" : piece.holes.some((h) => onCutout(h, t)) ? "hole" : "notch";
    made.set(t.cut.id, { id: t.cut.id, kind, text: t.text(kind), trace: t.trace });
  }
  const holes: ProfileHole[] = piece.holes.map((h) => {
    const from = taken.filter((t) => onCutout(h, t));
    const hole: ProfileHole = { id: from.map((t) => t.cut.id).join("+"), points_mm: startAtCorner(h) };
    if (from.length === 1 && from[0]!.circle) hole.circle = from[0]!.circle;
    return hole;
  });

  // Each edge counts as the face it was cut from, or the face it looks out of.
  const edge_faces = outline.map((a, i) => {
    const b = outline[(i + 1) % outline.length]!;
    const cut = lines.find((l) => [a, b].every((p) => Math.abs(p[0] * l.n[0] + p[1] * l.n[1] - l.c) <= ON));
    return cut ? cut.edge : facing(a, b, u, v);
  });

  return { u, v, size, outline, edge_faces, holes, cuts: cuts.flatMap((c) => made.get(c.id) ?? []) };

  /** The line an edge cut clips along, and how it reads on the cut list. */
  function edgeLine(cut: EdgeCut): [Line, ProfileCut] {
    const eAxis = FACE_AXIS[cut.edge];
    const rAxis = eAxis === u ? v : u;
    if (eAxis === panel.thickness_axis) throw new CutProblem(`the ${cut.edge} face is a broad face, and an edge cut needs an edge`);
    const ie = at(eAxis);
    const ir = at(rAxis);
    const ownEnd = (max: boolean): Step => {
      const value = max ? nominal.max[IDX[rAxis]] : nominal.min[IDX[rAxis]];
      return { value, text: `${panel.id}.${faceOf(rAxis, max)} (${fmt(value)})` };
    };
    const s = values.bound(eAxis, cut.start);
    const e = values.bound(eAxis, cut.end);
    const sa = cut.start_along ? values.bound(rAxis, cut.start_along) : ownEnd(false);
    const ea = cut.end_along ? values.bound(rAxis, cut.end_along) : ownEnd(true);
    const trace = `${cut.edge} edge from ${s.text} at ${sa.text} to ${e.text} at ${ea.text}`;
    const p0: Pt = [0, 0];
    const p1: Pt = [0, 0];
    p0[ir] = local(rAxis, sa.value);
    p0[ie] = local(eAxis, s.value);
    p1[ir] = local(rAxis, ea.value);
    p1[ie] = local(eAxis, e.value);
    const run = p1[ir] - p0[ir];
    if (Math.abs(run) <= EPS) {
      throw new CutProblem(`its two points sit at the same place along ${rAxis} (${fmt(sa.value)}), so they don't make a line. Move start_along or end_along apart`);
    }
    // The normal points into the wood the cut takes, towards the edge.
    const d: Pt = [p1[0] - p0[0], p1[1] - p0[1]];
    const l = Math.hypot(d[0], d[1]);
    let n: Pt = [-d[1] / l, d[0] / l];
    if (n[ie] * (FACE_IS_MAX[cut.edge] ? 1 : -1) < 0) n = [-n[0], -n[1]];
    const line: Line = { edge: cut.edge, n, c: n[0] * p0[0] + n[1] * p0[1] };

    // The wood left across the part at each end of the run, from the blank's opposite edge.
    const width = size[ie];
    const slope = (p1[ie] - p0[ie]) / run;
    const edgeAt = (r: number) => p0[ie] + slope * (r - p0[ir]);
    const left = (r: number) => (FACE_IS_MAX[cut.edge] ? edgeAt(r) : width - edgeAt(r));
    const length = size[ir];
    const w0 = left(0);
    const w1 = left(length);
    const angle = (Math.atan(Math.abs(slope)) * 180) / Math.PI;
    const clamp = (w: number) => Math.min(width, Math.max(0, w));
    const startEnd = side(faceOf(rAxis, false));
    const endEnd = side(faceOf(rAxis, true));
    const edgeName = side(cut.edge);
    const solved: ProfileCut = { id: cut.id, kind: "slope", start_mm: clamp(w0), end_mm: clamp(w1), run_mm: length, angle_deg: angle, text: "", trace };
    // A cut that runs the whole length is a slope, even from the very corner.
    const reachesStart = w0 <= width + EPS;
    const reachesEnd = w1 <= width + EPS;
    if (reachesStart && reachesEnd) {
      solved.text =
        Math.abs(w1 - w0) < 0.05
          ? `${edgeName} cut straight, leaving ${mm(clamp(w0))}`
          : `${edgeName} sloped from ${mm(clamp(w0))} at the ${startEnd} to ${mm(clamp(w1))} at the ${endEnd}, ${deg(angle)}`;
    } else {
      // It cuts a corner off: the line leaves the edge before it reaches the far end.
      const atEnd = reachesEnd;
      const leaves = p0[ir] + (FACE_IS_MAX[cut.edge] ? width - p0[ie] : p0[ie]) / (FACE_IS_MAX[cut.edge] ? slope : -slope);
      const along = atEnd ? length - leaves : leaves;
      const depth = width - clamp(atEnd ? w1 : w0);
      const end = faceOf(rAxis, atEnd);
      solved.kind = "chamfer";
      solved.run_mm = Math.min(length, Math.max(0, along));
      solved.text = `${cornerName([cut.edge, end])} corner cut off ${mm(solved.run_mm)} along the ${edgeName} and ${mm(depth)} along the ${side(end)}, ${deg(angle)}`;
    }
    return [line, solved];
  }

  /** A cutout's polygon, with its words for the cut list. */
  function cutoutShape(cut: Cutout): (typeof taken)[number] {
    const where = (x: number, y: number) => {
      const p: Pt = [x, y];
      return `${mm(p[at(lengthAxis)])} from the ${faceOf(lengthAxis, false)} and ${mm(p[at(widthAxis)])} from the ${faceOf(widthAxis, false)}`;
    };
    const sizes = (lo: Pt, hi: Pt) => `${mm(hi[at(lengthAxis)] - lo[at(lengthAxis)])} × ${mm(hi[at(widthAxis)] - lo[at(widthAxis)])}`;
    /** The blank's edges a shape between lo and hi reaches. */
    const reached = (lo: Pt, hi: Pt): Face[] =>
      [u, v].flatMap((a) => [...(lo[at(a)] <= EPS ? [faceOf(a, false)] : []), ...(hi[at(a)] >= size[at(a)] - EPS ? [faceOf(a, true)] : [])]);
    const notchWords = (what: string, lo: Pt, hi: Pt, pos: string): string => {
      const faces = reached(lo, hi);
      const opposite = [u, v].find((a) => faces.includes(faceOf(a, false)) && faces.includes(faceOf(a, true)));
      if (faces.length === 1) return `${what} in the ${side(faces[0]!)}, ${pos}`;
      if (faces.length === 2 && !opposite) return `${what} out of the ${cornerName(faces)} corner`;
      if (faces.length === 3) {
        const end = faces.find((f) => !faces.includes(faceOf(FACE_AXIS[f], !FACE_IS_MAX[f])))!;
        return `${what} off the ${side(end)}`;
      }
      if (opposite) return `${what} right across the ${opposite === lengthAxis ? "length" : "width"}, ${pos}`;
      return `${what}, ${pos}`;
    };

    if (cut.shape === "circle") {
      const c: Pt = [0, 0];
      const parts: string[] = [];
      for (const a of [u, v]) {
        const b = cut.centre?.[a];
        if (!b) throw new CutProblem(`a circle needs its centre on ${u} and ${v}`);
        const s = values.bound(a, b);
        c[at(a)] = local(a, s.value);
        parts.push(`${a} ${s.text}`);
      }
      const dia = values.number(cut.diameter ?? "");
      if (dia.value <= EPS) throw new CutProblem(`its diameter works out to ${fmt(dia.value)} mm. It needs to be more than nothing`);
      const r = dia.value / 2;
      const lo: Pt = [c[0] - r, c[1] - r];
      const hi: Pt = [c[0] + r, c[1] + r];
      const pos = `centre ${where(c[0], c[1])}`;
      return {
        cut,
        loop: circleLoop(c, dia.value, CURVE_TOLERANCE_MM),
        circle: { centre_mm: c, diameter_mm: dia.value },
        text: (kind) => (kind === "hole" ? `${mm(dia.value)} mm hole, ${pos}` : notchWords(`${mm(dia.value)} mm round notch`, lo, hi, pos)),
        trace: `centre ${parts.join(", ")}; diameter ${dia.text}`,
      };
    }

    const lo: Pt = [0, 0];
    const hi: Pt = [0, 0];
    const parts: string[] = [];
    for (const a of [u, v]) {
      const spec = cut[a];
      if (!spec) throw new CutProblem(`a rect needs a span on ${u} and on ${v}`);
      const s = values.span(a, spec, `cut ${cut.id}`);
      lo[at(a)] = local(a, s.start.value);
      hi[at(a)] = local(a, s.end.value);
      if (hi[at(a)] - lo[at(a)] <= EPS) throw new CutProblem(`its size along ${a} works out to ${fmt(hi[at(a)] - lo[at(a)])} mm. It needs to be more than nothing`);
      parts.push(`${a} from ${s.start.text} to ${s.end.text}`);
    }
    let radius = 0;
    if (cut.radius !== undefined && cut.radius.trim() !== "") {
      const rs = values.number(cut.radius);
      radius = rs.value;
      parts.push(`corner radius ${rs.text}`);
      const half = Math.min(hi[0] - lo[0], hi[1] - lo[1]) / 2;
      if (radius < 0) throw new CutProblem(`its corner radius works out to ${fmt(radius)} mm, below nothing`);
      if (radius > half + ON) throw new CutProblem(`its corner radius of ${fmt(radius)} mm is more than half its narrower side (${fmt(half)} mm)`);
    }
    const corners = radius > EPS ? ` with ${mm(radius)} mm round corners` : "";
    // A notch is measured on the blank, so a cutout run on past the edge for a clean cut reads as the wood it takes.
    const clo: Pt = [Math.max(lo[0], 0), Math.max(lo[1], 0)];
    const chi: Pt = [Math.min(hi[0], size[0]), Math.min(hi[1], size[1])];
    const pos = where(lo[0], lo[1]);
    return {
      cut,
      loop: roundedRectLoop(lo, hi, radius, CURVE_TOLERANCE_MM),
      text: (kind) =>
        kind === "hole" ? `${sizes(lo, hi)} cutout${corners}, ${pos}` : notchWords(`${sizes(clo, chi)} notch${corners}`, clo, chi, where(clo[0], clo[1])),
      trace: parts.join("; "),
    };
  }
}

/** The face an edge looks out of, from its outward normal: the region lies on its left. */
function facing(a: Pt, b: Pt, u: Axis, v: Axis): Face {
  const out: Pt = [b[1] - a[1], a[0] - b[0]];
  return Math.abs(out[0]) >= Math.abs(out[1]) ? faceOf(u, out[0] > 0) : faceOf(v, out[1] > 0);
}

/**
 * Starts a loop at its lowest corner on u, then on v, so equal shapes list
 * the same. Each point is rounded to a millionth of a mm, which clears the
 * last bit of float noise from a clipped corner.
 */
function startAtCorner(loop: Loop): Loop {
  const pts = loop.map(([x, y]): Pt => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6]);
  let best = 0;
  pts.forEach(([x, y], i) => {
    const [bx, by] = pts[best]!;
    if (x < bx || (x === bx && y < by)) best = i;
  });
  return [...pts.slice(best), ...pts.slice(0, best)];
}

/** A derived part's profile: its original's face, with this part's own housing extensions over the uncut stretches of each end. */
export function profileFor(face: SolvedFace, extensions: Extension[]): PartProfile {
  const ext: ProfileExtension[] = [];
  for (const e of extensions) {
    if (e.axis !== face.u && e.axis !== face.v) continue;
    const i: 0 | 1 = e.axis === face.u ? 0 : 1;
    const along = uncutStretches([face.outline], i, e.side === "end" ? face.size[i] : 0, 0, face.size[1 - i]!);
    ext.push({ joint: e.joint, face: faceOf(e.axis, e.side === "end"), depth_mm: e.depth_mm, along_mm: along });
  }
  return { u: face.u, v: face.v, outline_mm: face.outline, edge_faces: face.edge_faces, holes: face.holes, extensions: ext, cuts: face.cuts };
}

/** The tongues a profile's extensions add, as rectangles from nominal.min. */
function extensionRects(p: PartProfile, size: Pt): Loop[] {
  return p.extensions.flatMap((e) => {
    const i: 0 | 1 = FACE_AXIS[e.face] === p.u ? 0 : 1;
    const [a, b] = FACE_IS_MAX[e.face] ? [size[i], size[i] + e.depth_mm] : [-e.depth_mm, 0];
    return e.along_mm.map(([s0, s1]) => (i === 0 ? rectLoop([a, s0], [b, s1]) : rectLoop([s0, a], [s1, b])));
  });
}

type Profiled = Pick<DerivedPart, "profile" | "nominal" | "box" | "grain_axis" | "thickness_axis">;

const sizeOn = (p: Pick<DerivedPart, "nominal">, a: Axis) => p.nominal.max[IDX[a]] - p.nominal.min[IDX[a]];

/**
 * The shape you cut, from nominal.min: the outline you see with each
 * housing's tongue on the stretches no cut touched. Where two tongues meet
 * at a corner of the blank, the corner stays, as it does on an uncut box.
 */
export function cutOutline(p: Profiled): { outline: Loop; holes: Loop[] } | null {
  const pr = p.profile;
  if (!pr) return null;
  const size: Pt = [sizeOn(p, pr.u), sizeOn(p, pr.v)];
  const tabs = extensionRects(pr, size);
  if (!tabs.length) return { outline: pr.outline_mm, holes: pr.holes.map((h) => h.points_mm) };
  // A corner square where tongues on two adjacent ends both reach it.
  for (const a of pr.extensions) {
    for (const b of pr.extensions) {
      if (FACE_AXIS[a.face] !== pr.u || FACE_AXIS[b.face] !== pr.v) continue;
      const cu = FACE_IS_MAX[a.face] ? size[0] : 0;
      const cv = FACE_IS_MAX[b.face] ? size[1] : 0;
      const reaches = (along: [number, number][], at: number) => along.some(([s0, s1]) => Math.abs(s0 - at) <= ON || Math.abs(s1 - at) <= ON);
      if (!reaches(a.along_mm, cv) || !reaches(b.along_mm, cu)) continue;
      const u0 = FACE_IS_MAX[a.face] ? size[0] : -a.depth_mm;
      const v0 = FACE_IS_MAX[b.face] ? size[1] : -b.depth_mm;
      tabs.push(rectLoop([u0, v0], [u0 + a.depth_mm, v0 + b.depth_mm]));
    }
  }
  const shown = [pr.outline_mm, ...pr.holes.map((h) => h.points_mm)];
  const loops = traceRegion([...shown, ...tabs], (q) => pointInRegion(q, shown) || tabs.some((t) => insideConvex(q, t) > 0));
  const piece = piecesOf(loops)[0];
  return piece ? { outline: startAtCorner(piece.outline), holes: piece.holes.map(startAtCorner) } : null;
}

/**
 * A key that two parts share only when you'd cut them the same: the shape
 * you cut, in the part's own length and width from the corner of its blank,
 * to 0.1 mm. A mirror image keys apart. A part with no profile keys as "".
 */
export function shapeKey(p: Profiled): string {
  const pr = p.profile;
  if (!pr) return "";
  const cut = cutOutline(p);
  if (!cut) return "";
  const off: Pt = [p.nominal.min[IDX[pr.u]] - p.box.min[IDX[pr.u]], p.nominal.min[IDX[pr.v]] - p.box.min[IDX[pr.v]]];
  const swap = pr.u !== p.grain_axis;
  const loop = (l: Loop) => {
    const pts = l.map(([a, b]): Pt => {
      const x = r1(a + off[0]);
      const y = r1(b + off[1]);
      return swap ? [y, x] : [x, y];
    });
    return startAtCorner(pts)
      .map(([x, y]) => `${fmt(x)},${fmt(y)}`)
      .join(" ");
  };
  return [loop(cut.outline), ...cut.holes.map(loop).sort()].join(" | ");
}

/**
 * The area of each face you see on a profiled part, in mm². The broad faces
 * are the outline less its holes. An edge counts its length times the
 * part's thickness, on the face it counts as, and a hole's walls count on
 * the faces they look towards.
 */
export function faceAreas(p: Pick<DerivedPart, "profile" | "nominal" | "thickness_axis">): Record<Face, number> {
  const out = Object.fromEntries(FACES.map((f) => [f, 0])) as Record<Face, number>;
  const pr = p.profile;
  if (!pr) return out;
  const t = sizeOn(p, p.thickness_axis);
  const area = Math.abs(signedArea(pr.outline_mm)) - pr.holes.reduce((s, h) => s + Math.abs(signedArea(h.points_mm)), 0);
  out[faceOf(p.thickness_axis, false)] += area;
  out[faceOf(p.thickness_axis, true)] += area;
  const edges = (loop: Loop, face: (i: number) => Face) =>
    loop.forEach((a, i) => {
      const b = loop[(i + 1) % loop.length]!;
      out[face(i)] += Math.hypot(b[0] - a[0], b[1] - a[1]) * t;
    });
  edges(pr.outline_mm, (i) => pr.edge_faces[i]!);
  for (const h of pr.holes) edges(h.points_mm, (i) => facing(h.points_mm[i]!, h.points_mm[(i + 1) % h.points_mm.length]!, pr.u, pr.v));
  return out;
}
