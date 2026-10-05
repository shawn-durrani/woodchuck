// Editing a panel's cuts by hand, in the Shape section of the part's Edit
// tab. A cut's fields read like a part's own sizes: a number in mm, a sum,
// or a face such as @drawer_box_back.top with an offset. This file holds
// the logic: the cut each Add button starts with, the fields a cut shows
// and the operation they make, a cut's words and problems, what a change
// would do while you type it, and the small drawing of the part's face.
// Every change still goes through the same operations as Claude's. Kept
// free of React so the tests can hold it.

import {
  AXES,
  AXIS_FACES,
  AXIS_INDEX,
  FACE_AXIS,
  FACE_IS_MAX,
  faceAxes,
  fmt,
  partRefParts,
  type Axis,
  type Bound,
  type DeriveIssue,
  type DerivedPart,
  type Face,
  type Op,
  type Panel,
  type PanelCut,
  type ProfileCut,
} from "@woodchuck/core";
import { boundText, parseBound } from "./bounds";
import type { PreviewResult } from "./ghost";

/** What the Add buttons make. */
export type NewCut = "slope" | "round" | "rect" | "slot" | "notch";

/** Each Add button's words, as the change's name in History says them. */
export const NEW_CUT_WORDS: Record<NewCut, string> = {
  slope: "a sloped edge",
  round: "a round hole",
  rect: "a rectangular hole",
  slot: "a slot",
  notch: "a notch",
};

/** The id each new cut starts from. A second one gets _2, and so on. */
const BASE_ID: Record<NewCut, string> = { slope: "slope", round: "hole", rect: "hole", slot: "slot", notch: "notch" };

/** A cut's fields as you see them, each the text in its box. */
export interface EdgeFields {
  kind: "edge";
  edge: Face;
  start: string;
  end: string;
  start_along: string;
  end_along: string;
  note: string;
}
export interface CircleFields {
  kind: "circle";
  centre: Partial<Record<Axis, string>>;
  diameter: string;
  note: string;
}
export interface SpanFields {
  start: string;
  end: string;
  size: string;
}
export interface RectFields {
  kind: "rect";
  spans: Partial<Record<Axis, SpanFields>>;
  radius: string;
  note: string;
}
export type CutFields = EdgeFields | CircleFields | RectFields;

const blank: SpanFields = { start: "", end: "", size: "" };

/** A panel's size on one axis, as its blank. */
const sizeOn = (part: Pick<DerivedPart, "nominal">, a: Axis) => part.nominal.max[AXIS_INDEX[a]] - part.nominal.min[AXIS_INDEX[a]];

/** A whole number of mm, never under 1. */
const whole = (n: number) => Math.max(1, Math.round(n));

/** The axes a panel's face spans: every axis but its thickness. */
export const faceAxesOf = (panel: Pick<Panel, "thickness_axis">): Axis[] => AXES.filter((a) => a !== panel.thickness_axis);

/**
 * How the face drawing lays the part out: across, up, and whether up runs
 * against the axis. A side is drawn from the side with its back on the left,
 * an upright facing forward from the front, and a flat part from above with
 * its back at the top.
 */
export function drawnAxes(thickness: Axis): { across: Axis; up: Axis; upIsMax: boolean } {
  if (thickness === "x") return { across: "z", up: "y", upIsMax: true };
  if (thickness === "y") return { across: "x", up: "z", upIsMax: false };
  return { across: "x", up: "y", upIsMax: true };
}

/** A panel's four edges, never its broad faces: the one drawn at the top first, then the bottom, the left and the right. */
export function edgeChoices(panel: Pick<Panel, "thickness_axis">): Face[] {
  const { across, up, upIsMax } = drawnAxes(panel.thickness_axis);
  const [low, high] = AXIS_FACES[up];
  return [upIsMax ? high : low, upIsMax ? low : high, ...AXIS_FACES[across]];
}

/** The axis an edge cut runs along: the panel's other face axis. */
export const runAxis = (panel: Pick<Panel, "thickness_axis">, edge: Face): Axis => faceAxesOf(panel).find((a) => a !== FACE_AXIS[edge])!;

/** The edge a new slope takes wood from: the top, or the front of a flat part. */
export const slopeEdge = (panel: Pick<Panel, "thickness_axis">): Face => (panel.thickness_axis === "y" ? "front" : "top");

/** An unused id for a cut on this panel, from a base such as "hole". */
export function newCutId(panel: Pick<Panel, "cuts">, base: string): string {
  const used = new Set((panel.cuts ?? []).map((c) => c.id));
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

const own = (panel: Pick<Panel, "id">, face: Face, offset?: number): Bound => {
  const b: Bound = { face: `${panel.id}.${face}` };
  if (offset !== undefined && Math.abs(offset) > 0) b.offset = fmt(offset);
  return b;
};

/**
 * A slope on an edge, from the blank's full width at the start of its run
 * to two thirds of it at the end. Its ends follow the part's own edge, so
 * it moves with the part.
 */
export function slopeFields(panel: Pick<Panel, "id" | "thickness_axis">, part: Pick<DerivedPart, "nominal">, edge: Face): EdgeFields {
  const third = whole(sizeOn(part, FACE_AXIS[edge]) / 3);
  return {
    kind: "edge",
    edge,
    start: boundText(own(panel, edge)),
    end: boundText(own(panel, edge, FACE_IS_MAX[edge] ? -third : third)),
    start_along: "",
    end_along: "",
    note: "",
  };
}

/** A centred rectangle, long along the grain: its size along the grain and across it. */
function centredRect(panel: Pick<Panel, "id" | "thickness_axis" | "grain_axis">, part: Pick<DerivedPart, "nominal">, along: number, across: number, radius?: (sizes: Record<string, number>) => string): RectFields {
  const spans: Partial<Record<Axis, SpanFields>> = {};
  const sizes: Record<string, number> = {};
  for (const a of faceAxesOf(panel)) {
    const room = sizeOn(part, a);
    const want = a === panel.grain_axis ? along : across;
    const size = whole(Math.min(want, room / 3));
    sizes[a] = size;
    spans[a] = { start: boundText(own(panel, AXIS_FACES[a][0], Math.round((room - size) / 2))), end: "", size: fmt(size) };
  }
  return { kind: "rect", spans, radius: radius ? radius(sizes) : "", note: "" };
}

/** A notch's size on each axis: 100 up, 75 deep, and along a part's length whichever the other isn't. */
const NOTCH_MM: Record<Axis, number> = { y: 100, z: 75, x: 100 };

/**
 * A notch at a corner, as for a toe kick: the bottom front where the part
 * has them, otherwise the bottom or front at its left end.
 */
export function notchFields(panel: Pick<Panel, "id" | "thickness_axis">, part: Pick<DerivedPart, "nominal">): RectFields {
  const axes = faceAxesOf(panel);
  const spans: Partial<Record<Axis, SpanFields>> = {};
  for (const a of axes) {
    const want = a === "x" && axes.includes("y") ? 75 : NOTCH_MM[a];
    const size = fmt(whole(Math.min(want, sizeOn(part, a) / 2)));
    // Bottom and front are the faces a toe kick takes; along x it sits at the left end.
    spans[a] = a === "z" ? { start: "", end: boundText(own(panel, "front")), size } : { start: boundText(own(panel, a === "y" ? "bottom" : "left")), end: "", size };
  }
  return { kind: "rect", spans, radius: "", note: "" };
}

/** The fields a new cut of each kind starts with, worked out from the part so it shows at once. */
export function newCutFields(kind: NewCut, panel: Pick<Panel, "id" | "thickness_axis" | "grain_axis">, part: Pick<DerivedPart, "nominal">): CutFields {
  switch (kind) {
    case "slope":
      return slopeFields(panel, part, slopeEdge(panel));
    case "round": {
      const axes = faceAxesOf(panel);
      const shorter = Math.min(...axes.map((a) => sizeOn(part, a)));
      const centre: Partial<Record<Axis, string>> = {};
      for (const a of axes) centre[a] = boundText(own(panel, AXIS_FACES[a][0], Math.round(sizeOn(part, a) / 2)));
      return { kind: "circle", centre, diameter: fmt(whole(Math.min(35, shorter / 2))), note: "" };
    }
    case "rect":
      return centredRect(panel, part, 120, 60);
    case "slot":
      return centredRect(panel, part, 120, 30, (sizes) => fmt(Math.min(...Object.values(sizes)) / 2));
    case "notch":
      return notchFields(panel, part);
  }
}

/** The operation that adds a new cut of a kind, with its new id. */
export function newCut(kind: NewCut, panel: Panel, part: Pick<DerivedPart, "nominal">): { cut: string; op: Op } {
  const cut = newCutId(panel, BASE_ID[kind]);
  return { cut, op: opOf(panel.id, cut, newCutFields(kind, panel, part)) };
}

/** A cut's fields as their boxes show them, with an empty box for anything it leaves out. */
export function fieldsOf(cut: PanelCut, panel: Pick<Panel, "thickness_axis">): CutFields {
  const note = cut.note ?? "";
  if (cut.kind === "edge") {
    return { kind: "edge", edge: cut.edge, start: boundText(cut.start), end: boundText(cut.end), start_along: boundText(cut.start_along), end_along: boundText(cut.end_along), note };
  }
  const axes = faceAxesOf(panel);
  if (cut.shape === "circle") {
    return { kind: "circle", centre: Object.fromEntries(axes.map((a) => [a, boundText(cut.centre?.[a])])), diameter: cut.diameter ?? "", note };
  }
  const spans: Partial<Record<Axis, SpanFields>> = {};
  for (const a of axes) {
    const s = cut[a];
    spans[a] = s ? { start: boundText(s.start), end: boundText(s.end), size: s.size ?? "" } : { ...blank };
  }
  return { kind: "rect", spans, radius: cut.radius ?? "", note };
}

/** The text in one box, by its key: "start", "centre.x", "y.size", "radius", "note" and so on. */
export function fieldValue(f: CutFields, key: string): string {
  const [head, tail] = key.split(".") as [string, string | undefined];
  if (key === "note") return f.note;
  if (f.kind === "edge") return key in f ? String(f[key as keyof EdgeFields]) : "";
  if (f.kind === "circle") return head === "centre" && tail ? (f.centre[tail as Axis] ?? "") : key === "diameter" ? f.diameter : "";
  if (key === "radius") return f.radius;
  return tail ? (f.spans[head as Axis]?.[tail as keyof SpanFields] ?? "") : "";
}

/** The fields with one box's text changed. */
export function withField(f: CutFields, key: string, text: string): CutFields {
  const [head, tail] = key.split(".") as [string, string | undefined];
  if (key === "note") return { ...f, note: text };
  if (f.kind === "edge") return key === "edge" ? f : { ...f, [key]: text };
  if (f.kind === "circle") {
    if (head === "centre" && tail) return { ...f, centre: { ...f.centre, [tail]: text } };
    return key === "diameter" ? { ...f, diameter: text } : f;
  }
  if (key === "radius") return { ...f, radius: text };
  if (!tail) return f;
  const a = head as Axis;
  return { ...f, spans: { ...f.spans, [a]: { ...(f.spans[a] ?? blank), [tail]: text } } };
}

/** The same cut, box for box. */
export const sameFields = (a: CutFields, b: CutFields) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The operation the fields make: set_edge_cut or set_cutout, with each box
 * read the way a part's own sizes are. An empty box is left out, and the
 * design says what's missing.
 */
export function opOf(panelId: string, cutId: string, f: CutFields): Op {
  const op: Record<string, unknown> = { id: panelId, cut: cutId };
  const bound = (key: string, text: string) => {
    const b = parseBound(text);
    if (b) op[key] = b;
  };
  if (f.kind === "edge") {
    op.op = "set_edge_cut";
    op.edge = f.edge;
    bound("start", f.start);
    bound("end", f.end);
    bound("start_along", f.start_along);
    bound("end_along", f.end_along);
  } else if (f.kind === "circle") {
    op.op = "set_cutout";
    op.shape = "circle";
    const centre: Partial<Record<Axis, Bound>> = {};
    for (const [a, text] of Object.entries(f.centre)) {
      const b = parseBound(text ?? "");
      if (b) centre[a as Axis] = b;
    }
    op.centre = centre;
    if (f.diameter.trim()) op.diameter = f.diameter.trim();
  } else {
    op.op = "set_cutout";
    op.shape = "rect";
    for (const [a, s] of Object.entries(f.spans)) {
      if (!s) continue;
      const span: Record<string, unknown> = {};
      const start = parseBound(s.start);
      const end = parseBound(s.end);
      if (start) span.start = start;
      if (end) span.end = end;
      if (s.size.trim()) span.size = s.size.trim();
      op[a] = span;
    }
    if (f.radius.trim()) op.radius = f.radius.trim();
  }
  if (f.note.trim()) op.note = f.note.trim();
  return op as Op;
}

/** One box in the editor. */
export interface FieldSpec {
  key: string;
  label: string;
  placeholder?: string;
}

/** Boxes that belong together, such as one axis of a rectangle. */
export interface FieldGroup {
  title: string;
  fields: FieldSpec[];
  /** Kept folded until opened, for the boxes most cuts leave empty. */
  more?: true;
}

const AXIS_WORDS: Record<Axis, string> = { x: "x, left to right", y: "y, up from the floor", z: "z, back to front" };

/** The editor's boxes for a cut, grouped and named in the part's own words. */
export function fieldGroups(panel: Pick<Panel, "id" | "thickness_axis">, f: CutFields): FieldGroup[] {
  const note: FieldGroup = { title: "Note", fields: [{ key: "note", label: "note", placeholder: "what it's for, such as a cable hole" }], more: true };
  if (f.kind === "edge") {
    const axis = FACE_AXIS[f.edge];
    const run = runAxis(panel, f.edge);
    const [from, to] = AXIS_FACES[run];
    return [
      {
        title: `Where the new ${f.edge} edge sits on ${axis}`,
        fields: [
          { key: "start", label: `at the ${from} end`, placeholder: `@${panel.id}.${f.edge}` },
          { key: "end", label: `at the ${to} end`, placeholder: `@${panel.id}.${f.edge}` },
        ],
      },
      {
        title: `Measure those somewhere else along ${run}`,
        fields: [
          { key: "start_along", label: `${from} point`, placeholder: `the ${from} end` },
          { key: "end_along", label: `${to} point`, placeholder: `the ${to} end` },
        ],
        more: true,
      },
      note,
    ];
  }
  const axes = faceAxesOf(panel);
  if (f.kind === "circle") {
    return [
      { title: "Centre", fields: axes.map((a) => ({ key: `centre.${a}`, label: AXIS_WORDS[a], placeholder: `@${panel.id}.${AXIS_FACES[a][0]} + 100` })) },
      { title: "Size", fields: [{ key: "diameter", label: "diameter", placeholder: "35" }] },
      note,
    ];
  }
  return [
    ...axes.map((a) => ({
      title: AXIS_WORDS[a],
      fields: (["start", "end", "size"] as const).map((k) => ({ key: `${a}.${k}`, label: k })),
    })),
    { title: "Corners", fields: [{ key: "radius", label: "corner radius", placeholder: "square" }] },
    note,
  ];
}

/** The cut's working out, from the part's shape: its words for the cut list and the numbers behind them. */
export const solvedCut = (part: Pick<DerivedPart, "profile"> | undefined, cutId: string): ProfileCut | undefined => part?.profile?.cuts.find((c) => c.id === cutId);

/** The hole a cutout leaves, as its width and height. */
function holeSize(part: Pick<DerivedPart, "profile"> | undefined, cutId: string): [number, number] | null {
  const hole = part?.profile?.holes.find((h) => h.id.split("+").includes(cutId));
  if (!hole) return null;
  const xs = hole.points_mm.map((p) => p[0]);
  const ys = hole.points_mm.map((p) => p[1]);
  return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
}

/** What a cut is, in a word or two, such as "Sloped edge" or "Round hole". */
export function cutTitle(cut: PanelCut, part: Pick<DerivedPart, "profile"> | undefined): string {
  const solved = solvedCut(part, cut.id);
  if (cut.kind === "edge") return solved?.kind === "chamfer" ? "Corner cut" : solved ? "Sloped edge" : "Edge cut";
  const notch = solved?.kind === "notch";
  if (cut.shape === "circle") return notch ? "Round notch" : "Round hole";
  if (notch) return "Notch";
  const radius = Number(cut.radius ?? "0");
  if (!cut.radius || radius === 0) return solved ? "Rectangular hole" : "Cutout";
  const size = holeSize(part, cut.id);
  if (size && Number.isFinite(radius) && Math.abs(2 * radius - Math.min(...size)) < 0.05) return "Slot";
  return "Rounded hole";
}

/** The problem codes that are about a part's shape. */
const SHAPE_CODES = new Set(["cut_error", "cut_removes_nothing", "cut_severs", "cut_thin", "cut_web", "cut_joint", "joint_on_cut", "rule_reads_cut_face"]);

/** The cuts a problem names, as "cut slope" or "cuts slot and kick". */
export function cutsNamed(message: string): string[] {
  const ids = new Set<string>();
  for (const m of message.matchAll(/\b[Cc]uts ((?:[a-z][a-z0-9_]*, )*[a-z][a-z0-9_]*) and ([a-z][a-z0-9_]*)\b/g)) {
    for (const id of m[1]!.split(", ")) ids.add(id);
    ids.add(m[2]!);
  }
  for (const m of message.matchAll(/\b[Cc]ut ([a-z][a-z0-9_]*)\b/g)) ids.add(m[1]!);
  return [...ids];
}

const onPart = (i: Pick<DeriveIssue, "parts">, partId: string) => i.parts.some((p) => partRefParts(p).source === partId);

/** The problems that name one cut on a part. */
export function problemsFor<T extends Pick<DeriveIssue, "parts" | "message">>(issues: T[], partId: string, cutId: string): T[] {
  return issues.filter((i) => onPart(i, partId) && cutsNamed(i.message).includes(cutId));
}

/** The problems with a part's shape as a whole, which name none of its cuts, such as a part split in two. */
export function shapeProblems<T extends Pick<DeriveIssue, "parts" | "message" | "code">>(issues: T[], panel: Pick<Panel, "id" | "cuts">): T[] {
  const ids = new Set((panel.cuts ?? []).map((c) => c.id));
  return issues.filter((i) => SHAPE_CODES.has(i.code) && onPart(i, panel.id) && !cutsNamed(i.message).some((id) => ids.has(id)));
}

/** What a change to one cut would do, while you type it: the cut's new words and its problems, or why the design refuses it. */
export interface DraftNote {
  error: string | null;
  note: string | null;
  problems: { severity: DeriveIssue["severity"]; message: string }[];
}

export function draftNote(result: PreviewResult | { error: string }, partId: string, cutId: string): DraftNote {
  if ("error" in result) return { error: result.error, note: null, problems: [] };
  const part = result.after.parts.find((p) => p.id === partId);
  return {
    error: null,
    note: solvedCut(part, cutId)?.text ?? null,
    problems: problemsFor(result.report.issues, partId, cutId).map((i) => ({ severity: i.severity, message: i.message })),
  };
}

/** One edge of the drawn blank, with its name beside it. */
export interface DrawnEdge {
  face: Face;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** The edge a slope takes wood from. */
  on: boolean;
  label: { x: number; y: number; anchor: "start" | "middle" | "end" };
}

/** A small drawing of a part's broad face, in its own units with y down, for an SVG. */
export interface FaceDrawing {
  width: number;
  height: number;
  /** The blank, as a path. */
  blank: string;
  /** The wood the cuts leave: the outline, then each hole, for an even-odd fill. */
  wood: string;
  edges: DrawnEdge[];
  /** The hole being edited, as a path. */
  hole: string | null;
  /** A slope's two ends, each with the wood it leaves there. */
  ends: { x: number; y: number; text: string; anchor: "start" | "end" }[];
}

/** The drawing's longest side, in its own units, which are about a pixel each. */
const DRAWN = 200;
/** Its shortest side, so a long thin part still shows its slope. */
const LEAST = 40;
const PAD_X = 46;
const PAD_Y = 18;

/**
 * A part's broad face drawn small, with the shape its cuts leave. The edge
 * being cut lights up, and a slope's two ends carry the wood left at each.
 * A long thin part is drawn deeper than it is, so the drawing shows where
 * things are rather than their true proportions.
 */
export function faceDrawing(part: Pick<DerivedPart, "nominal" | "thickness_axis" | "profile">, focus: { edge?: Face; cut?: string } = {}): FaceDrawing {
  const { across, up, upIsMax } = drawnAxes(part.thickness_axis);
  const W = sizeOn(part, across);
  const H = sizeOn(part, up);
  const k = DRAWN / Math.max(W, H, 1e-6);
  const sx = W * k < LEAST ? LEAST / Math.max(W, 1e-6) : k;
  const sy = H * k < LEAST ? LEAST / Math.max(H, 1e-6) : k;
  const w = W * sx;
  const h = H * sy;
  /** A point from its place on the part, measured from the blank's low corner. */
  const at = (along: number, upward: number): [number, number] => [PAD_X + along * sx, PAD_Y + (upIsMax ? H - upward : upward) * sy];
  const path = (pts: [number, number][]) => `M${pts.map(([x, y]) => `${r2(x)} ${r2(y)}`).join("L")}Z`;
  const corners: [number, number][] = [at(0, 0), at(W, 0), at(W, H), at(0, H)];
  const blankPath = path(corners);

  const pr = part.profile;
  const fromProfile = (loop: [number, number][]) => {
    if (!pr) return [];
    return loop.map(([pu, pv]) => {
      const local: Partial<Record<Axis, number>> = { [pr.u]: pu, [pr.v]: pv };
      return at(local[across] ?? 0, local[up] ?? 0);
    });
  };
  const wood = pr ? [pr.outline_mm, ...pr.holes.map((x) => x.points_mm)].map((l) => path(fromProfile(l))).join("") : blankPath;
  const holeLoop = focus.cut ? pr?.holes.find((x) => x.id.split("+").includes(focus.cut!)) : undefined;

  // The four edges, each named on its outer side.
  const [left, right] = AXIS_FACES[across];
  const [low, high] = AXIS_FACES[up];
  const topFace = upIsMax ? high : low;
  const bottomFace = upIsMax ? low : high;
  const [x0, y0] = [PAD_X, PAD_Y];
  const [x1, y1] = [PAD_X + w, PAD_Y + h];
  const sides: DrawnEdge[] = [
    { face: topFace, x1: x0, y1: y0, x2: x1, y2: y0, on: false, label: { x: (x0 + x1) / 2, y: y0 - 5, anchor: "middle" } },
    { face: bottomFace, x1: x0, y1: y1, x2: x1, y2: y1, on: false, label: { x: (x0 + x1) / 2, y: y1 + 13, anchor: "middle" } },
    { face: left, x1: x0, y1: y0, x2: x0, y2: y1, on: false, label: { x: x0 - 5, y: (y0 + y1) / 2 + 4, anchor: "end" } },
    { face: right, x1: x1, y1: y0, x2: x1, y2: y1, on: false, label: { x: x1 + 5, y: (y0 + y1) / 2 + 4, anchor: "start" } },
  ];
  const edges = sides.map((e) => ({ ...e, on: e.face === focus.edge }));

  // A slope's ends, at the blank's own ends, with the wood left across the part there.
  const ends: FaceDrawing["ends"] = [];
  const solved = focus.cut ? solvedCut(part, focus.cut) : undefined;
  if (focus.edge && solved?.start_mm !== undefined && solved.end_mm !== undefined) {
    const axis = FACE_AXIS[focus.edge];
    const run = AXES.find((a) => a !== axis && a !== part.thickness_axis)!;
    const width = sizeOn(part, axis);
    const length = sizeOn(part, run);
    const edgeAt = (kept: number) => (FACE_IS_MAX[focus.edge!] ? kept : width - kept);
    for (const [r, kept] of [
      [0, solved.start_mm],
      [length, solved.end_mm],
    ] as const) {
      const local: Partial<Record<Axis, number>> = { [axis]: edgeAt(kept), [run]: r };
      const [x, y] = at(local[across] ?? 0, local[up] ?? 0);
      ends.push({ x: r2(x), y: r2(y), text: fmt(Math.round(kept * 10) / 10), anchor: x > PAD_X + w / 2 ? "end" : "start" });
    }
  }

  return {
    width: r2(w + 2 * PAD_X),
    height: r2(h + 2 * PAD_Y),
    blank: blankPath,
    wood,
    edges,
    hole: holeLoop ? path(fromProfile(holeLoop.points_mm)) : null,
    ends,
  };
}

const r2 = (n: number) => Math.round(n * 100) / 100;
