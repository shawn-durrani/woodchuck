// Workshop drawings: a set of sheets to print at true scale and take to the
// bench. Everything comes from the derived design, never the 3D mesh, and
// every number on a sheet is a model number rounded as the cut list rounds
// it, to 0.1 mm, so the sheets and the cut list always agree.
//
// A sheet is a list of marks in millimetres on landscape paper, with the
// origin at the top left and y running down the page. The same sheet becomes
// SVG here and a vector PDF on the server, and tests read its numbers
// without a browser.
//
// The set is a general arrangement (front, plan and left side at one
// standard scale, with overall sizes and chains across the openings), one
// drawing per cut-list row with its machining, then the cut list, a drilling
// list and a hardware list. The arrangement's views are drawn solid, so
// hidden edges don't show there yet. A part its cuts shape is drawn as its
// true outline, with its holes left open, and its sheet sizes the slopes,
// the ends and the cutouts.

import { runChecks } from "./checks.js";
import { AXIS_INDEX, type Box, type DeriveResult, type DerivedPart, type Machining, type Vec3 } from "./derive.js";
import { cutList, machiningText, machiningWith, roundCut, type CutList, type CutRow } from "./cutlist.js";
import { fmt } from "./expr.js";
import { cutOutline } from "./profile.js";
import { signedArea, sliceIntervals, type Loop, type Pt } from "./shape.js";
import { AXES, FACE_AXIS, FACE_IS_MAX, type Axis, type Design, type Face } from "./types.js";
import { HARDWARE_MATERIAL, hardwareParts, paintOrder, partFaces, projectPoint, type ViewName } from "./views.js";

export type Paper = "A4" | "A3";
/** Paper sizes, landscape. */
export const PAPER_MM: Record<Paper, { width_mm: number; height_mm: number }> = {
  A4: { width_mm: 297, height_mm: 210 },
  A3: { width_mm: 420, height_mm: 297 },
};
/** Standard scales as the n in 1:n, largest first. 1:50 is only for a piece too big for 1:20. */
export const DRAWING_SCALES = [1, 2, 5, 10, 20, 50] as const;

export type Mark =
  | { kind: "line"; x1_mm: number; y1_mm: number; x2_mm: number; y2_mm: number; stroke_mm: number; dashed?: boolean }
  /** A closed outline, with any holes in it left open by the even-odd rule. A stroke of 0 draws only the fill. */
  | { kind: "shape"; points_mm: [number, number][]; holes_mm?: [number, number][][]; stroke_mm: number; fill?: string; dashed?: boolean }
  | { kind: "circle"; cx_mm: number; cy_mm: number; r_mm: number; stroke_mm: number; fill?: string; dashed?: boolean }
  /** Helvetica. The point is on the baseline. Vertical text reads from the bottom up. */
  | {
      kind: "text";
      x_mm: number;
      y_mm: number;
      size_mm: number;
      text: string;
      anchor?: "start" | "middle" | "end";
      bold?: boolean;
      vertical?: boolean;
      colour?: string;
    };

/** A dimension written on a sheet, kept for tests and for anything that reads the drawings. */
export interface SheetDim {
  /** front, top or left on the arrangement, and face, edge or end on a part. */
  view: string;
  /**
   * A world axis on the arrangement, and length, width or thickness on a
   * part. A part's shape adds its right end, and for a slope the edge or
   * end it's on, such as top edge.
   */
  along: string;
  /** An angle is a slope's, with its run along the part and its rise across it in values_mm. */
  kind: "overall" | "chain" | "angle";
  values_mm: number[];
  /** The gaps between panels in a chain, in order. */
  openings_mm?: number[];
  /** A slope's angle to the edge or end it was cut from. */
  angle_deg?: number;
}

export interface Sheet {
  kind: "arrangement" | "part" | "cut list" | "drilling" | "hardware";
  title: string;
  paper: Paper;
  width_mm: number;
  height_mm: number;
  /** The n in 1:n. Tables have no scale, and their check bar is full size. */
  scale: number | null;
  marks: Mark[];
  dims: SheetDim[];
  /** The cut-list row a part sheet draws. */
  row?: number;
}

export interface DrawingOptions {
  /** For the title blocks, such as "3 October 2026". Today when left out. */
  date?: string;
  /** The paper for every sheet. A4 when left out, since most home printers take it. */
  paper?: Paper;
}

/** One kind of hole in one cut-list row's part. */
export interface DrillRow {
  row: number;
  part: string;
  /** How many of the part to make. */
  qty: number;
  holes: string;
  /** The other part in the joint. */
  with: string;
  /** Holes in each part. */
  count: number;
  diameter_mm: number;
  depth_mm: number;
  /** True when the hole runs right through the part. */
  through: boolean;
  /** In the part drawing's words, such as "near face" or "left end". */
  face: string;
  /** Each hole's centre on the part drawing, such as "409 along, 132 up". */
  centres: string[];
}

const EPS = 0.01;
const BORDER = 10;
const PAD = 5;
const TB_W = 150;
const TB_H = 26;
const OUTLINE = 0.35;
const THIN = 0.25;
const FINE = 0.18;
const TEXT = 2.5;
const GREY = "#666666";
const CUT_AWAY = "#d4d4d4";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const num = (n: number) => fmt(roundCut(n));

// Helvetica's advance widths in thousandths of the font size, for the
// printable ASCII characters 32 to 126, then the few others the sheets use.
// Every PDF reader has Helvetica, so the server embeds no font.
// Source: Adobe's Core 14 font metrics, Helvetica.afm and Helvetica-Bold.afm.
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278,
  584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944,
  667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500,
  278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333,
  584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944,
  667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556,
  333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];
const HELVETICA_MORE: Record<string, [number, number]> = {
  "×": [584, 584],
  "·": [278, 278],
  "°": [400, 400],
  "±": [584, 584],
  "…": [1000, 1000],
  "–": [556, 556],
  "’": [222, 278],
  Ø: [778, 778],
  ø: [611, 611],
};

/** How wide a line of Helvetica is on paper. */
export function textWidth_mm(text: string, size_mm: number, bold = false): number {
  const table = bold ? HELVETICA_BOLD : HELVETICA;
  let w = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    w += c >= 32 && c <= 126 ? table[c - 32]! : (HELVETICA_MORE[ch]?.[bold ? 1 : 0] ?? 556);
  }
  return (w / 1000) * size_mm;
}

/** Shortens text with an ellipsis until it fits. */
function clip(text: string, width_mm: number, size_mm: number, bold = false): string {
  if (textWidth_mm(text, size_mm, bold) <= width_mm) return text;
  let s = text;
  while (s.length > 1 && textWidth_mm(s + "…", size_mm, bold) > width_mm) s = s.slice(0, -1);
  return s.trimEnd() + "…";
}

/** Breaks text into lines that fit, at spaces where it can. */
function wrap(text: string, width_mm: number, size_mm: number, bold = false): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (textWidth_mm(next, size_mm, bold) <= width_mm) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    line = word;
    while (textWidth_mm(line, size_mm, bold) > width_mm && line.length > 1) {
      let cut = line.length - 1;
      while (cut > 1 && textWidth_mm(line.slice(0, cut), size_mm, bold) > width_mm) cut--;
      lines.push(line.slice(0, cut));
      line = line.slice(cut);
    }
  }
  if (line || !lines.length) lines.push(line);
  return lines;
}

class Pen {
  marks: Mark[] = [];
  line(x1_mm: number, y1_mm: number, x2_mm: number, y2_mm: number, stroke_mm = THIN, dashed = false) {
    this.marks.push({ kind: "line", x1_mm, y1_mm, x2_mm, y2_mm, stroke_mm, ...(dashed ? { dashed } : {}) });
  }
  shape(points_mm: [number, number][], o: { stroke_mm?: number; fill?: string; dashed?: boolean; holes?: [number, number][][] } = {}) {
    this.marks.push({
      kind: "shape",
      points_mm,
      ...(o.holes?.length ? { holes_mm: o.holes } : {}),
      stroke_mm: o.stroke_mm ?? THIN,
      ...(o.fill ? { fill: o.fill } : {}),
      ...(o.dashed ? { dashed: true } : {}),
    });
  }
  rect(x: number, y: number, w: number, h: number, o: { stroke_mm?: number; fill?: string; dashed?: boolean } = {}) {
    this.shape(
      [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ],
      o,
    );
  }
  circle(cx_mm: number, cy_mm: number, r_mm: number, o: { stroke_mm?: number; fill?: string; dashed?: boolean } = {}) {
    this.marks.push({ kind: "circle", cx_mm, cy_mm, r_mm, stroke_mm: o.stroke_mm ?? THIN, ...(o.fill ? { fill: o.fill } : {}), ...(o.dashed ? { dashed: true } : {}) });
  }
  text(
    x_mm: number,
    y_mm: number,
    text: string,
    o: { size_mm?: number; anchor?: "start" | "middle" | "end"; bold?: boolean; vertical?: boolean; colour?: string } = {},
  ) {
    this.marks.push({
      kind: "text",
      x_mm,
      y_mm,
      size_mm: o.size_mm ?? TEXT,
      text,
      ...(o.anchor && o.anchor !== "start" ? { anchor: o.anchor } : {}),
      ...(o.bold ? { bold: true } : {}),
      ...(o.vertical ? { vertical: true } : {}),
      ...(o.colour ? { colour: o.colour } : {}),
    });
  }
}

function blankSheet(kind: Sheet["kind"], title: string, paper: Paper, scale: number | null): Sheet {
  return { kind, title, paper, ...PAPER_MM[paper], scale, marks: [], dims: [] };
}

/** Where drawings can go: inside the border, above the title block's strip. */
function drawingArea(paper: Paper) {
  const { width_mm, height_mm } = PAPER_MM[paper];
  const x = BORDER + PAD;
  const y = BORDER + PAD;
  return { x, y, w: width_mm - 2 * x, h: height_mm - BORDER - TB_H - PAD - y };
}

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

type Side = "below" | "above" | "left" | "right";
/** The first row of dimensions sits this far off a view, and each next row this much further. */
const DIM_FIRST = 7;
const DIM_STEP = 8;

/** Room a view needs on one side for this many rows of dimensions. */
function dimMargin(rows: number): number {
  return rows ? DIM_FIRST + (rows - 1) * DIM_STEP + 4 : 2;
}

/**
 * One row of dimensions: a line along the run, an oblique tick at each
 * point, extension lines back to the view, and each value written above
 * the line, or to its left reading upwards. A value too wide for its gap is
 * lifted clear of its neighbours.
 */
function dimRow(pen: Pen, side: Side, edge_mm: number, line_mm: number, at_mm: number[], values_mm: number[]) {
  const across = side === "below" || side === "above";
  const away = side === "below" || side === "right" ? 1 : -1;
  const first = at_mm[0]!;
  const last = at_mm[at_mm.length - 1]!;
  if (across) pen.line(first, line_mm, last, line_mm);
  else pen.line(line_mm, first, line_mm, last);
  for (const p of at_mm) {
    const from = edge_mm + away * 1.5;
    const to = line_mm + away * 1.5;
    if (across) {
      pen.line(p, from, p, to, FINE);
      pen.line(p - 1, line_mm + 1, p + 1, line_mm - 1, OUTLINE);
    } else {
      pen.line(from, p, to, p, FINE);
      pen.line(line_mm - 1, p + 1, line_mm + 1, p - 1, OUTLINE);
    }
  }
  let lifted = false;
  values_mm.forEach((v, i) => {
    const text = num(v);
    const a = at_mm[i]!;
    const b = at_mm[i + 1]!;
    const narrow = textWidth_mm(text, TEXT) > Math.abs(b - a) - 1;
    const lift = narrow && !lifted ? 3 : 0;
    lifted = lift > 0;
    const mid = (a + b) / 2;
    if (across) pen.text(mid, line_mm - 1 - lift, text, { anchor: "middle" });
    else pen.text(line_mm - 1 - lift, mid, text, { anchor: "middle", vertical: true });
  });
}

/** Rounded points along a run, each once. */
function uniqueSorted(values: number[]): number[] {
  const out: number[] = [];
  for (const v of [...values].sort((a, b) => a - b)) if (!out.length || v - out[out.length - 1]! > 0.05) out.push(v);
  return out;
}

/**
 * The gaps between rounded points. Points round first, from the start of
 * the run, so the gaps add up to the overall size.
 */
function gapsBetween(at: number[], from = 0): number[] {
  return at.slice(1).map((v, k) => roundCut(roundCut(v - from) - roundCut(at[k]! - from)));
}

// ---------------------------------------------------------------------------
// The general arrangement
// ---------------------------------------------------------------------------

interface ViewPlan {
  view: Extract<ViewName, "front" | "top" | "left">;
  label: string;
  /** The axis the camera looks along, and the side it looks from. */
  toward: { axis: Axis; sign: 1 | -1 };
  runs: { axis: Axis; side: Side; overall: boolean }[];
}

// Third-angle projection: the plan sits above the front and the left side
// to its left. Width and height go on the front and depth on the plan, so
// each overall size is written once.
const ARRANGEMENT: ViewPlan[] = [
  {
    view: "front",
    label: "Front",
    toward: { axis: "z", sign: 1 },
    runs: [
      { axis: "x", side: "below", overall: true },
      { axis: "y", side: "right", overall: true },
    ],
  },
  {
    view: "top",
    label: "Plan",
    toward: { axis: "y", sign: 1 },
    runs: [
      { axis: "x", side: "above", overall: false },
      { axis: "z", side: "right", overall: true },
    ],
  },
  {
    view: "left",
    label: "Left side",
    toward: { axis: "x", sign: -1 },
    runs: [
      { axis: "z", side: "below", overall: false },
      { axis: "y", side: "left", overall: false },
    ],
  },
];

interface Chain {
  /** Model positions along the run, from one end of the piece to the other. */
  at: number[];
  values: number[];
  openings: number[];
}

/**
 * The run across a view's panels: each panel facing along the run that
 * shows in this view, and the gaps between them. Panels hidden behind a
 * single part, such as drawer sides behind their fronts, are left out.
 */
function chainAcross(plan: ViewPlan, axis: Axis, drawn: DerivedPart[], lo: number, hi: number): Chain | null {
  const i = AXIS_INDEX[axis];
  const di = AXIS_INDEX[plan.toward.axis];
  const flat = [0, 1, 2].filter((k) => k !== di);
  const hidden = (p: DerivedPart) =>
    drawn.some(
      (q) =>
        q !== p &&
        (plan.toward.sign > 0 ? q.nominal.min[di]! >= p.nominal.max[di]! - EPS : q.nominal.max[di]! <= p.nominal.min[di]! + EPS) &&
        flat.every((k) => q.nominal.min[k]! <= p.nominal.min[k]! + EPS && q.nominal.max[k]! >= p.nominal.max[k]! - EPS),
    );
  const spans = drawn
    .filter((p) => p.material !== HARDWARE_MATERIAL && p.thickness_axis === axis && !hidden(p))
    .map((p) => [p.nominal.min[i]!, p.nominal.max[i]!] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [a, b] of spans) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + EPS) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  const at = [lo];
  const gap: boolean[] = [];
  for (const [a, b] of merged) {
    if (a > at[at.length - 1]! + EPS) {
      at.push(a);
      gap.push(true);
    }
    if (b > at[at.length - 1]! + EPS) {
      at.push(Math.min(b, hi));
      gap.push(false);
    }
  }
  if (hi > at[at.length - 1]! + EPS) {
    at.push(hi);
    gap.push(true);
  }
  if (at.length < 3) return null;
  const values = gapsBetween(at, lo);
  // An opening has a panel on each side. A gap at either end is an overhang.
  const openings = values.filter((_, k) => gap[k] && k > 0 && k < values.length - 1);
  return { at, values, openings };
}

interface PlacedView {
  plan: ViewPlan;
  /** Model extents across and down the paper, in projected coordinates. */
  min: [number, number];
  size: [number, number];
  margin: { top: number; bottom: number; left: number; right: number };
  chains: Map<Axis, Chain | null>;
}

const LABEL = 8;

function arrangement(design: Design, d: DeriveResult, paper: Paper): Sheet {
  const drawn = [...d.parts.filter((p) => !p.broken), ...hardwareParts(d)];
  if (!drawn.length) {
    const sheet = blankSheet("arrangement", "General arrangement", paper, 1);
    const a = drawingArea(sheet.paper);
    const pen = new Pen();
    pen.text(a.x + a.w / 2, a.y + a.h / 2, "Nothing to draw yet", { size_mm: 5, anchor: "middle", colour: GREY });
    sheet.marks = pen.marks;
    return sheet;
  }
  const lo: Vec3 = [0, 1, 2].map((i) => Math.min(...drawn.map((p) => p.nominal.min[i]!))) as Vec3;
  const hi: Vec3 = [0, 1, 2].map((i) => Math.max(...drawn.map((p) => p.nominal.max[i]!))) as Vec3;

  const views: PlacedView[] = ARRANGEMENT.map((plan) => {
    const pts = drawn.flatMap((p) => corners(p.nominal).map((c) => projectPoint(plan.view, c[0], c[1], c[2])));
    const min: [number, number] = [Math.min(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1]))];
    const size: [number, number] = [Math.max(...pts.map((q) => q[0])) - min[0], Math.max(...pts.map((q) => q[1])) - min[1]];
    const chains = new Map<Axis, Chain | null>();
    const margin = { top: 2, bottom: 2, left: 2, right: 2 };
    for (const run of plan.runs) {
      const i = AXIS_INDEX[run.axis];
      const c = chainAcross(plan, run.axis, drawn, lo[i], hi[i]);
      chains.set(run.axis, c);
      const rows = (c ? 1 : 0) + (run.overall ? 1 : 0);
      const key = run.side === "below" ? "bottom" : run.side === "above" ? "top" : run.side;
      margin[key] = Math.max(margin[key], dimMargin(rows));
    }
    margin.bottom += LABEL;
    return { plan, min, size, margin, chains };
  });
  const [front, top, left] = views as [PlacedView, PlacedView, PlacedView];
  const GAP = 10;
  const layout = (scale: number) => {
    const s = (v: number) => v / scale;
    const mainLeft = Math.max(front.margin.left, top.margin.left);
    const leftCol = left.margin.left + s(left.size[0]) + left.margin.right;
    const mainCol = mainLeft + s(front.size[0]) + Math.max(front.margin.right, top.margin.right);
    const topRow = top.margin.top + s(top.size[1]) + top.margin.bottom;
    const mainTop = Math.max(front.margin.top, left.margin.top);
    const mainRow = mainTop + s(front.size[1]) + Math.max(front.margin.bottom, left.margin.bottom);
    return { w: leftCol + GAP + mainCol, h: topRow + GAP + mainRow, leftCol, mainLeft, topRow, mainTop };
  };
  const area = drawingArea(paper);
  const scale = pickScale((s) => layout(s).w <= area.w && layout(s).h <= area.h);
  const sheet = blankSheet("arrangement", "General arrangement", paper, scale);
  const l = layout(scale);
  const ox = area.x + Math.max(0, (area.w - l.w) / 2);
  const oy = area.y + Math.max(0, (area.h - l.h) / 2);
  const origin = new Map<PlacedView, [number, number]>([
    [top, [ox + l.leftCol + GAP + l.mainLeft, oy + top.margin.top]],
    [front, [ox + l.leftCol + GAP + l.mainLeft, oy + l.topRow + GAP + l.mainTop]],
    [left, [ox + left.margin.left, oy + l.topRow + GAP + l.mainTop]],
  ]);

  const pen = new Pen();
  for (const v of views) {
    const [x0, y0] = origin.get(v)!;
    const paperOf = (q: [number, number]): [number, number] => [x0 + (q[0] - v.min[0]) / scale, y0 + (q[1] - v.min[1]) / scale];
    for (const p of paintOrder(v.plan.view, drawn)) {
      const hardware = p.material === HARDWARE_MATERIAL;
      for (const f of partFaces(v.plan.view, p)) {
        pen.shape(f.pts.map(paperOf), { stroke_mm: hardware ? THIN : OUTLINE, fill: hardware ? "#e9ecef" : "#ffffff", ...(f.holes ? { holes: f.holes.map((h) => h.map(paperOf)) } : {}) });
      }
    }
    const w = v.size[0] / scale;
    const h = v.size[1] / scale;
    for (const run of v.plan.runs) {
      const i = AXIS_INDEX[run.axis];
      // Where a model position along this axis lands on the paper.
      const unit: Vec3 = [0, 0, 0];
      unit[i] = 1;
      const dir = projectPoint(v.plan.view, ...unit);
      const zero = projectPoint(v.plan.view, 0, 0, 0);
      const comp = Math.abs(dir[0] - zero[0]) > 0.5 ? 0 : 1;
      const toPaper = (m: number) => [x0, y0][comp]! + ((zero[comp]! + (dir[comp]! - zero[comp]!) * m - v.min[comp]!) / scale);
      const edge = run.side === "below" ? y0 + h : run.side === "above" ? y0 : run.side === "right" ? x0 + w : x0;
      const away = run.side === "below" || run.side === "right" ? 1 : -1;
      let line = edge + away * DIM_FIRST;
      const chain = v.chains.get(run.axis);
      if (chain) {
        dimRow(pen, run.side, edge, line, chain.at.map(toPaper), chain.values);
        sheet.dims.push({ view: v.plan.view, along: run.axis, kind: "chain", values_mm: chain.values, openings_mm: chain.openings });
        line += away * DIM_STEP;
      }
      if (run.overall) {
        const size = roundCut(hi[i] - lo[i]);
        dimRow(pen, run.side, edge, line, [toPaper(lo[i]), toPaper(hi[i])], [size]);
        sheet.dims.push({ view: v.plan.view, along: run.axis, kind: "overall", values_mm: [size] });
      }
    }
    const below = v.margin.bottom - LABEL;
    pen.text(x0 + w / 2, y0 + h + below + 5, v.plan.label, { size_mm: 3.5, anchor: "middle", bold: true });
  }
  // Drawings of a design that fails its checks are for checking, not cutting.
  const report = runChecks(design, d);
  if (!report.ready_to_cut) {
    const problems = [report.errors && `${report.errors} ${report.errors === 1 ? "error" : "errors"}`, report.warnings && `${report.warnings} ${report.warnings === 1 ? "warning" : "warnings"}`]
      .filter(Boolean)
      .join(" and ");
    pen.text(area.x, area.y + 4, `Not ready to cut yet${problems ? `: the checks find ${problems}` : ""}. See the Problems tab.`, { size_mm: 3.5, bold: true });
  }
  sheet.marks = pen.marks;
  return sheet;
}

function corners(b: Box): Vec3[] {
  const out: Vec3[] = [];
  for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) out.push([x, y, z]);
  return out;
}

/** The largest standard scale that fits, or the smallest when none does. */
function pickScale(fits: (scale: number) => boolean): number {
  return DRAWING_SCALES.find(fits) ?? DRAWING_SCALES[DRAWING_SCALES.length - 1]!;
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

/**
 * A part laid flat on the bench. X runs along its length from the left end,
 * Y up its width from the bottom edge, and Z up through its thickness from
 * the face underneath. The face you look down on is the one with the most
 * machining, so a part is turned over end to end when its work is
 * underneath.
 */
interface Frame {
  part: DerivedPart;
  L: Axis;
  W: Axis;
  T: Axis;
  size: { L: number; W: number; T: number };
  flip: boolean;
}

function frameOf(part: DerivedPart): Frame {
  const T = part.thickness_axis;
  let below = 0;
  let above = 0;
  for (const m of part.machining) {
    if (FACE_AXIS[m.face] !== T) continue;
    if (FACE_IS_MAX[m.face]) above++;
    else below++;
  }
  return {
    part,
    L: part.grain_axis,
    W: part.width_axis,
    T,
    size: { L: part.cut.length, W: part.cut.width, T: part.cut.thickness },
    flip: below > above,
  };
}

/** A world point in the part's frame: [along, up, through]. */
function inFrame(f: Frame, p: Vec3): Vec3 {
  const at = (a: Axis) => p[AXIS_INDEX[a]]! - f.part.box.min[AXIS_INDEX[a]]!;
  const v = at(f.W);
  const w = at(f.T);
  return [at(f.L), f.flip ? f.size.W - v : v, f.flip ? f.size.T - w : w];
}

function boxInFrame(f: Frame, b: Box): { min: Vec3; max: Vec3 } {
  const a = inFrame(f, b.min);
  const c = inFrame(f, b.max);
  return { min: [0, 1, 2].map((i) => Math.min(a[i]!, c[i]!)) as Vec3, max: [0, 1, 2].map((i) => Math.max(a[i]!, c[i]!)) as Vec3 };
}

/** Which of the frame's axes a world axis is: 0 along, 1 up, 2 through. */
function frameAxis(f: Frame, a: Axis): 0 | 1 | 2 {
  return a === f.L ? 0 : a === f.W ? 1 : 2;
}

/** A world face in the part drawing's words. */
function faceName(f: Frame, face: Face): string {
  const a = FACE_AXIS[face];
  const max = FACE_IS_MAX[face];
  if (a === f.L) return max ? "right end" : "left end";
  if (a === f.W) return max !== f.flip ? "top edge" : "bottom edge";
  return max !== f.flip ? "near face" : "far face";
}

const FASTENER_LABELS = new Set(["screw holes", "dowel holes", "pocket holes"]);
const LEFT_STANDING = new Set(["tenon", "tongue"]);

/**
 * Hole centres, worked out the way derive spreads fasteners: evenly along
 * the edge where the parts meet, across its middle.
 */
function holeCentres(m: Machining, d: DeriveResult): Vec3[] {
  const r = m.region;
  const span = (a: Axis) => r.max[AXIS_INDEX[a]]! - r.min[AXIS_INDEX[a]]!;
  const dj = d.joints.find((j) => j.id === m.joint);
  const guest = dj ? d.byId.get(dj.guest) : undefined;
  const meet = dj?.axis ?? AXES.find((a) => span(a) < EPS) ?? FACE_AXIS[m.face];
  let along: Axis;
  if (dj?.axis && guest) {
    const t = guest.thickness_axis === meet ? guest.width_axis : guest.thickness_axis;
    along = AXES.find((a) => a !== meet && a !== t)!;
  } else {
    along = AXES.filter((a) => a !== meet).sort((a, b) => Math.abs(span(a) - m.length_mm) - Math.abs(span(b) - m.length_mm))[0]!;
  }
  const across = AXES.find((a) => a !== meet && a !== along)!;
  const n = Math.max(1, m.count ?? 1);
  return Array.from({ length: n }, (_, k) => {
    const v: Vec3 = [0, 0, 0];
    v[AXIS_INDEX[along]] = r.min[AXIS_INDEX[along]]! + ((k + 0.5) / n) * span(along);
    v[AXIS_INDEX[across]] = (r.min[AXIS_INDEX[across]]! + r.max[AXIS_INDEX[across]]!) / 2;
    v[AXIS_INDEX[meet]] = r.min[AXIS_INDEX[meet]]!;
    return v;
  });
}

/** Hole centres on the part drawing, in order along and then up. */
function centresInFrame(f: Frame, m: Machining, d: DeriveResult): Vec3[] {
  return holeCentres(m, d)
    .map((c) => inFrame(f, c))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
}

/** A hole's centre in words, on the face it's drilled into. */
function centreText(f: Frame, drill: 0 | 1 | 2, c: Vec3): string {
  const inFrom = num(f.size.T - c[2]);
  if (drill === 2) return `${num(c[0])} along, ${num(c[1])} up`;
  if (drill === 1) return `${num(c[0])} along, ${inFrom} in`;
  return `${num(c[1])} up, ${inFrom} in`;
}

const POSITIONS = "Along is from the left end, up from the bottom edge and in from the near face, on the face view.";

// ---------------------------------------------------------------------------
// A part's shape, on its sheet
// ---------------------------------------------------------------------------

type P = [number, number];

interface FrameHole {
  /** Clockwise on the face view, with the wood on the left of each edge. */
  pts: P[];
  circle?: { centre: P; diameter_mm: number };
  /** Cutouts that overlap make one hole, which has no plain size. */
  joined: boolean;
}

interface FrameSlope {
  /** Its two ends, the one nearer the left end first. */
  a: P;
  b: P;
  /** The edge or end it was cut from, in the drawing's words, such as "top edge". */
  side: string;
  /** Its angle to that edge or end. */
  angle_deg: number;
  /** Along that edge or end, and across it. */
  run_mm: number;
  rise_mm: number;
  /** A unit vector out of the wood, on the face view. */
  out: P;
}

/** A shaped part on its face view: along and up from the corner of its cut box, as the machining is. */
interface FrameShape {
  /** Counter-clockwise, with the wood on the left: the shape you cut, tongues and all. */
  outline: P[];
  holes: FrameHole[];
  loops: Loop[];
  /** The outline's points worth a size: where straight edges meet, leaving out the steps along a curve. */
  corners: P[];
  slopes: FrameSlope[];
}

/** An edge shorter than this may be one step of a curve, which takes no size of its own. */
const CURVE_STEP_MM = 3;
/** Edges that turn this much where they meet make a corner, even beside a curve. */
const SHARP_DEG = 15;

const extent = (pts: P[], k: 0 | 1): [number, number] => [Math.min(...pts.map((q) => q[k])), Math.max(...pts.map((q) => q[k]))];
const degrees = (n: number) => `${Math.round(n * 10) / 10}°`;

/** The points of a loop that take a size: corners between straight edges, and the ends of a curve where it meets one sharply. */
function cornersOf(loop: P[]): P[] {
  const n = loop.length;
  return loop.filter((q, i) => {
    const a = loop[(i + n - 1) % n]!;
    const b = loop[(i + 1) % n]!;
    const d1: P = [q[0] - a[0], q[1] - a[1]];
    const d2: P = [b[0] - q[0], b[1] - q[1]];
    const before = Math.hypot(...d1) >= CURVE_STEP_MM;
    const after = Math.hypot(...d2) >= CURVE_STEP_MM;
    const turn = (Math.abs(Math.atan2(d1[0] * d2[1] - d1[1] * d2[0], d1[0] * d2[0] + d1[1] * d2[1])) * 180) / Math.PI;
    return (before && after) || ((before || after) && turn >= SHARP_DEG);
  });
}

/** A shaped part's outline, holes and slopes on its face view, or null for a part with no shape. */
function shapeInFrame(f: Frame): FrameShape | null {
  const p = f.part;
  const pr = p.profile;
  const cut = cutOutline(p);
  if (!pr || !cut) return null;
  const flat = (q: Pt): P => {
    const w: Vec3 = [...p.nominal.min];
    w[AXIS_INDEX[pr.u]] += q[0];
    w[AXIS_INDEX[pr.v]] += q[1];
    const c = inFrame(f, w);
    return [c[0], c[1]];
  };
  let outline = cut.outline.map(flat);
  let holes: FrameHole[] = pr.holes.map((h) => ({
    pts: h.points_mm.map(flat),
    joined: h.id.includes("+"),
    ...(h.circle ? { circle: { centre: flat(h.circle.centre_mm), diameter_mm: h.circle.diameter_mm } } : {}),
  }));
  // A part turned over shows its other face, which runs each loop the other way round.
  const turned = signedArea(outline) < 0;
  if (turned) {
    outline = [...outline].reverse();
    holes = holes.map((h) => ({ ...h, pts: [...h.pts].reverse() }));
  }
  // Slopes are the outline's slanting edges. Tongues only go on uncut stretches, so they never touch one.
  const slopes: FrameSlope[] = [];
  pr.outline_mm.forEach((q, i) => {
    const a = flat(q);
    const b = flat(pr.outline_mm[(i + 1) % pr.outline_mm.length]!);
    const dx = Math.abs(b[0] - a[0]);
    const dy = Math.abs(b[1] - a[1]);
    if (dx <= EPS || dy <= EPS || Math.hypot(dx, dy) < CURVE_STEP_MM) return;
    const face = pr.edge_faces[i]!;
    const onEnd = FACE_AXIS[face] === f.L;
    const [run, rise] = onEnd ? [dy, dx] : [dx, dy];
    const l = Math.hypot(dx, dy);
    const [from, to] = turned ? [b, a] : [a, b];
    const out: P = [(to[1] - from[1]) / l, (from[0] - to[0]) / l];
    const [left, right] = a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]) ? [a, b] : [b, a];
    slopes.push({ a: left, b: right, side: faceName(f, face), angle_deg: (Math.atan(rise / run) * 180) / Math.PI, run_mm: run, rise_mm: rise, out });
  });
  return { outline, holes, loops: [outline, ...holes.map((h) => h.pts)], corners: cornersOf(outline), slopes };
}

/** A rectangular hole's corner radius, from the straight run along its longer side. */
function cornerRadius(h: FrameHole): number {
  const [x0, x1] = extent(h.pts, 0);
  const [y0, y1] = extent(h.pts, 1);
  const long: 0 | 1 = x1 - x0 >= y1 - y0 ? 0 : 1;
  const size = long === 0 ? x1 - x0 : y1 - y0;
  const short = long === 0 ? y1 - y0 : x1 - x0;
  const across: 0 | 1 = long === 0 ? 1 : 0;
  // The longest straight edge along the long side: the side less a radius at each end.
  const run = Math.max(
    0,
    ...h.pts.map((q, i) => {
      const b = h.pts[(i + 1) % h.pts.length]!;
      return Math.abs(q[across] - b[across]) <= EPS ? Math.abs(b[long] - q[long]) : 0;
    }),
  );
  return run > EPS ? (size - run) / 2 : short / 2;
}

/** What to cut for the shape, in the drawing's words, each with where its balloon points. */
function shapeNotes(s: FrameShape): { text: string; at: P }[] {
  const out: { text: string; at: P }[] = [];
  for (const { a, b, side: where, angle_deg } of s.slopes) {
    const side = where[0]!.toUpperCase() + where.slice(1);
    // The balloon points a third of the way along, clear of the angle written past the middle.
    out.push({
      text: `${side} cut on a slope from ${num(a[0])} along, ${num(a[1])} up to ${num(b[0])} along, ${num(b[1])} up, ${degrees(angle_deg)}.`,
      at: [a[0] + (b[0] - a[0]) / 3, a[1] + (b[1] - a[1]) / 3],
    });
  }
  for (const h of s.holes) {
    if (h.circle) {
      const [x, y] = h.circle.centre;
      out.push({ text: `Ø${num(h.circle.diameter_mm)} hole right through, centre ${num(x)} along, ${num(y)} up.`, at: [x, y] });
      continue;
    }
    const [x0, x1] = extent(h.pts, 0);
    const [y0, y1] = extent(h.pts, 1);
    const r = h.joined ? 0 : cornerRadius(h);
    const corners = r > 0.05 ? `, corners rounded to ${num(r)}` : "";
    const what = h.joined ? `Cutout right through, ${num(x1 - x0)} × ${num(y1 - y0)} overall` : `${num(x1 - x0)} × ${num(y1 - y0)} cutout right through${corners}`;
    out.push({ text: `${what}, from ${num(x0)} along, ${num(y0)} up.`, at: [(x0 + x1) / 2, (y0 + y1) / 2] });
  }
  return out;
}

/**
 * The edges a side view of a shaped part sees, as places across it: the
 * corners at each end of an edge that faces the view, unless more wood
 * stands in front of it. look is 0 for the edge view, which looks up at the
 * bottom edge, and 1 for the end view, which looks at the right end.
 */
function seenLines(s: FrameShape, look: 0 | 1): number[] {
  const [lo, hi] = extent(s.outline, look);
  const corner = new Set(s.corners);
  const out: number[] = [];
  s.outline.forEach((a, i) => {
    const b = s.outline[(i + 1) % s.outline.length]!;
    const n: P = [b[1] - a[1], a[0] - b[0]];
    const m: P = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (look === 0) {
      if (n[1] >= -EPS) return;
      if (sliceIntervals(s.loops, 0, m[0]).some(([, top]) => top < m[1] - EPS)) return;
    } else {
      if (n[0] <= EPS) return;
      if (sliceIntervals(s.loops, 1, m[1]).some(([start]) => start > m[0] + EPS)) return;
    }
    for (const q of [a, b]) if (corner.has(q) && q[look] > lo + 0.05 && q[look] < hi - 0.05) out.push(q[look]);
  });
  return uniqueSorted(out);
}

/** What to cut, in the cut list's words, and where on this drawing. */
function noteText(f: Frame, m: Machining, d: DeriveResult): string {
  const what = machiningText({ ...m, with: machiningWith(m) });
  if (FASTENER_LABELS.has(m.label)) {
    const drill = frameAxis(f, FACE_AXIS[m.face]);
    const centres = centresInFrame(f, m, d).map((c) => centreText(f, drill, c));
    return `${what}. Centres ${centres.join("; ")}.`;
  }
  const b = boxInFrame(f, m.region);
  const near = b.max[2] >= f.size.T - EPS;
  const far = b.min[2] <= EPS;
  const depth = near ? "" : far ? ", on the far face" : `, ${num(f.size.T - b.max[2])} in`;
  return `${what}. At ${num(b.min[0])} along, ${num(b.min[1])} up${depth}.`;
}

function partSheet(row: CutRow, d: DeriveResult, paper: Paper): Sheet {
  const part = d.byId.get(row.parts[0]!)!;
  const f = frameOf(part);
  const { L, W, T } = f.size;
  const area = drawingArea(paper);
  const sheet = blankSheet("part", `Part ${row.row}: ${row.name}`, paper, 1);
  sheet.row = row.row;
  const pen = new Pen();

  // The header: what it is, how many, and its cut size.
  const hx = area.x;
  let hy = area.y + 5;
  pen.text(hx, hy, clip(`${row.row}. ${row.name}`, area.w - 40, 5, true), { size_mm: 5, bold: true });
  pen.text(area.x + area.w, hy, `Make ${row.qty}`, { size_mm: 5, bold: true, anchor: "end" });
  hy += 6.5;
  // The cut list's own numbers, so the two can't disagree.
  pen.text(hx, hy, `Cut to ${fmt(row.length_mm)} long × ${fmt(row.width_mm)} wide × ${fmt(row.thickness_mm)} thick`, { size_mm: 3.5 });
  hy += 5;
  pen.text(hx, hy, clip(`${row.material_name}${row.grain ? ", grain along the length" : ""}`, area.w, 3), { size_mm: 3 });
  hy += 4.5;
  pen.text(hx, hy, clip(`Parts: ${row.parts.join(", ")}`, area.w, TEXT), { colour: GREY });
  const top = hy + 4;

  // The notes: one numbered line per piece of machining, then one for each
  // slope and hole the part's cuts make, under the views.
  const shape = shapeInFrame(f);
  const shaped = shape ? shapeNotes(shape) : [];
  const notes = [...part.machining.map((m) => noteText(f, m, d)), ...shaped.map((x) => x.text)];
  const noteW = area.w - 8;
  const noteLines = notes.map((n) => wrap(n, noteW, TEXT));
  const standing = part.machining.some((m) => LEFT_STANDING.has(m.label)) ? " An outline at an end is a tenon or tongue." : "";
  const legend = wrap(`Grey is cut away and dashed is out of sight.${standing} ${POSITIONS}`, area.w, TEXT);
  const notesH = (notes.length ? 5 + noteLines.reduce((s, l) => s + l.length * 3.6 + 0.8, 0) : 5) + legend.length * 3.6 + 2;
  const bottom = area.y + area.h - notesH;

  // Chains of machining along the length and up the width, on the face view.
  const regions = part.machining.filter((m) => !FASTENER_LABELS.has(m.label)).map((m) => ({ m, b: boxInFrame(f, m.region) }));
  const holes = part.machining
    .filter((m) => FASTENER_LABELS.has(m.label))
    .map((m) => ({ m, drill: frameAxis(f, FACE_AXIS[m.face]), at: centresInFrame(f, m, d) }));
  // A shape's corners and holes join the chains: every place along goes
  // above, and each place up goes beside the nearer end, so the right end's
  // height has a chain of its own.
  const shapeAt = (k: 0 | 1, keep: (q: P) => boolean = () => true): number[] => {
    if (!shape) return [];
    const holeAt = shape.holes.flatMap((h) => {
      const centre: P = h.circle?.centre ?? [(extent(h.pts, 0)[0] + extent(h.pts, 0)[1]) / 2, (extent(h.pts, 1)[0] + extent(h.pts, 1)[1]) / 2];
      if (!keep(centre)) return [];
      return h.circle ? [centre[k]] : extent(h.pts, k);
    });
    return [...shape.corners.filter(keep).map((q) => q[k]), ...holeAt];
  };
  const chainOf = (k: 0 | 1, full: number, more: number[] = []) => {
    const pts = [0, full, ...more];
    for (const { b } of regions) if (b.max[k] - b.min[k] < full - EPS) pts.push(b.min[k], b.max[k]);
    for (const h of holes) if (h.drill === 2) for (const c of h.at) pts.push(c[k]);
    const at = uniqueSorted(pts.filter((v) => v >= -EPS && v <= full + EPS).map(roundCut));
    return at.length > 2 ? at : null;
  };
  const chainX = chainOf(0, L, shapeAt(0));
  const chainY = chainOf(1, W, shapeAt(1, (q) => q[0] <= L / 2));
  const rightEnd = shape ? uniqueSorted([0, W, ...shapeAt(1, (q) => q[0] > L / 2)].filter((v) => v >= -EPS && v <= W + EPS).map(roundCut)) : [];
  const chainRight = rightEnd.length > 2 ? rightEnd : null;

  const GAP = 10;
  const marginTop = dimMargin((chainX ? 1 : 0) + 1);
  const marginLeft = Math.max(dimMargin((chainY ? 1 : 0) + 1), dimMargin(1));
  // The right end's chain sits between the face view and the end view.
  const gapRight = chainRight ? dimMargin(1) + 3 : GAP;
  const size = (s: number) => ({ w: marginLeft + L / s + gapRight + T / s + 2, h: marginTop + W / s + GAP + T / s + LABEL });
  const s = pickScale((scale) => size(scale).w <= area.w && size(scale).h <= bottom - top);
  sheet.scale = s;
  const z = size(s);
  const fx = area.x + marginLeft + Math.max(0, (area.w - z.w) / 2);
  const fy = top + marginTop + Math.max(0, (bottom - top - z.h) / 2);
  const ex = fx;
  const ey = fy + W / s + GAP;
  const nx = fx + L / s + gapRight;
  const ny = fy;

  // Paper positions for each view. The face view is X across and Y up. The
  // edge view looks at the bottom edge, with the near face at the top. The
  // end view looks at the right end, with the near face on the left.
  const face = (x: number, y: number): [number, number] => [fx + x / s, fy + (W - y) / s];
  const edge = (x: number, zz: number): [number, number] => [ex + x / s, ey + (T - zz) / s];
  const end = (zz: number, y: number): [number, number] => [nx + (T - zz) / s, ny + (W - y) / s];
  const rectOf = (a: [number, number], b: [number, number]) => {
    const x = Math.min(a[0], b[0]);
    const y = Math.min(a[1], b[1]);
    return [x, y, Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])] as const;
  };

  if (shape) {
    // The shape you cut on the face view, with its holes open. The edge and
    // end views are the outline seen from below and from the right, with a
    // line where each edge they see meets the next, and the holes dashed.
    const [x0, x1] = extent(shape.outline, 0);
    const [y0, y1] = extent(shape.outline, 1);
    pen.shape(
      shape.outline.map(([x, y]) => face(x, y)),
      { stroke_mm: OUTLINE, fill: "#ffffff", holes: shape.holes.map((h) => h.pts.map(([x, y]) => face(x, y))) },
    );
    pen.rect(...rectOf(edge(x0, 0), edge(x1, T)), { stroke_mm: OUTLINE, fill: "#ffffff" });
    pen.rect(...rectOf(end(0, y0), end(T, y1)), { stroke_mm: OUTLINE, fill: "#ffffff" });
    for (const x of seenLines(shape, 0)) pen.line(...edge(x, 0), ...edge(x, T), OUTLINE);
    for (const y of seenLines(shape, 1)) pen.line(...end(0, y), ...end(T, y), OUTLINE);
    for (const h of shape.holes) {
      for (const x of extent(h.pts, 0)) pen.line(...edge(x, 0), ...edge(x, T), FINE, true);
      for (const y of extent(h.pts, 1)) pen.line(...end(0, y), ...end(T, y), FINE, true);
    }
  } else {
    pen.rect(...rectOf(face(0, 0), face(L, W)), { stroke_mm: OUTLINE, fill: "#ffffff" });
    pen.rect(...rectOf(edge(0, 0), edge(L, T)), { stroke_mm: OUTLINE, fill: "#ffffff" });
    pen.rect(...rectOf(end(0, 0), end(T, W)), { stroke_mm: OUTLINE, fill: "#ffffff" });
  }

  // Machining: hidden first, so what shows is drawn over it.
  const views = [
    { at: (b: { min: Vec3; max: Vec3 }) => rectOf(face(b.min[0], b.min[1]), face(b.max[0], b.max[1])), shows: (b: { min: Vec3; max: Vec3 }) => b.max[2] >= T - EPS },
    { at: (b: { min: Vec3; max: Vec3 }) => rectOf(edge(b.min[0], b.min[2]), edge(b.max[0], b.max[2])), shows: (b: { min: Vec3; max: Vec3 }) => b.min[1] <= EPS },
    { at: (b: { min: Vec3; max: Vec3 }) => rectOf(end(b.min[2], b.min[1]), end(b.max[2], b.max[1])), shows: (b: { min: Vec3; max: Vec3 }) => b.max[0] >= L - EPS },
  ];
  for (const pass of [false, true]) {
    for (const v of views) {
      for (const { m, b } of regions) {
        if (v.shows(b) !== pass) continue;
        const r = v.at(b);
        if (r[2] < 0.05 && r[3] < 0.05) continue;
        const standing = LEFT_STANDING.has(m.label);
        pen.rect(...r, pass ? { stroke_mm: standing ? OUTLINE : THIN, ...(standing ? {} : { fill: CUT_AWAY }) } : { stroke_mm: FINE, dashed: true });
      }
    }
  }
  for (const h of holes) {
    const r = Math.max(0.6, h.m.diameter_mm ?? 4) / 2 / s;
    const name = faceName(f, h.m.face);
    for (const c of h.at) {
      const [x, y] = h.drill === 2 ? face(c[0], c[1]) : h.drill === 1 ? edge(c[0], c[2]) : end(c[2], c[1]);
      const shows = h.drill === 2 ? name === "near face" : h.drill === 1 ? name === "bottom edge" : name === "right end";
      pen.circle(x, y, Math.max(r, 0.4), shows ? { stroke_mm: THIN, fill: "#ffffff" } : { stroke_mm: FINE, dashed: true });
      if (shows) {
        pen.line(x - r - 0.6, y, x + r + 0.6, y, FINE);
        pen.line(x, y - r - 0.6, x, y + r + 0.6, FINE);
      }
    }
  }

  // A slope's angle, written just outside it, two thirds of the way along.
  for (const sl of shape?.slopes ?? []) {
    const [mx, my] = face(sl.a[0] + ((sl.b[0] - sl.a[0]) * 2) / 3, sl.a[1] + ((sl.b[1] - sl.a[1]) * 2) / 3);
    pen.text(mx + sl.out[0] * 3, my - sl.out[1] * 3 + 1, degrees(sl.angle_deg), { anchor: "middle" });
    sheet.dims.push({ view: "face", along: sl.side, kind: "angle", values_mm: [roundCut(sl.run_mm), roundCut(sl.rise_mm)], angle_deg: Math.round(sl.angle_deg * 10) / 10 });
  }

  // Balloons tie each piece of machining, and each slope and hole, on the face view to its note.
  const anchors = [
    ...part.machining.map((m): [number, number] => {
      if (FASTENER_LABELS.has(m.label)) {
        const c = holes.find((x) => x.m === m)!.at[0]!;
        return face(c[0], c[1]);
      }
      const b = boxInFrame(f, m.region);
      return face((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2);
    }),
    ...shaped.map((x) => face(x.at[0], x.at[1])),
  ];
  anchors.forEach((anchor, k) => {
    const bx = anchor[0] + 4;
    const by = anchor[1] - 4;
    pen.line(anchor[0], anchor[1], bx - 1.4, by + 1.4, FINE);
    pen.circle(bx, by, 2, { stroke_mm: THIN, fill: "#ffffff" });
    pen.text(bx, by + 0.8, String(k + 1), { size_mm: 2.2, anchor: "middle", bold: true });
  });

  // Overall sizes, then the machining chains nearer the views.
  const rowAt = (edgeMm: number, side: Side, n: number) => edgeMm + (side === "below" || side === "right" ? 1 : -1) * (DIM_FIRST + n * DIM_STEP);
  const faceTop = fy;
  const faceLeft = fx;
  let n = 0;
  if (chainX) {
    const values = gapsBetween(chainX);
    dimRow(pen, "above", faceTop, rowAt(faceTop, "above", n++), chainX.map((x) => face(x, W)[0]), values);
    sheet.dims.push({ view: "face", along: "length", kind: "chain", values_mm: values });
  }
  dimRow(pen, "above", faceTop, rowAt(faceTop, "above", n), [face(0, W)[0], face(L, W)[0]], [row.length_mm]);
  sheet.dims.push({ view: "face", along: "length", kind: "overall", values_mm: [row.length_mm] });
  n = 0;
  if (chainY) {
    const values = gapsBetween(chainY);
    dimRow(pen, "left", faceLeft, rowAt(faceLeft, "left", n++), chainY.map((y) => face(0, y)[1]), values);
    sheet.dims.push({ view: "face", along: "width", kind: "chain", values_mm: values });
  }
  dimRow(pen, "left", faceLeft, rowAt(faceLeft, "left", n), [face(0, 0)[1], face(0, W)[1]], [row.width_mm]);
  sheet.dims.push({ view: "face", along: "width", kind: "overall", values_mm: [row.width_mm] });
  if (chainRight) {
    const faceRight = fx + L / s;
    const values = gapsBetween(chainRight);
    dimRow(pen, "right", faceRight, rowAt(faceRight, "right", 0), chainRight.map((y) => face(L, y)[1]), values);
    sheet.dims.push({ view: "face", along: "right end", kind: "chain", values_mm: values });
  }
  dimRow(pen, "left", ex, rowAt(ex, "left", 0), [edge(0, 0)[1], edge(0, T)[1]], [row.thickness_mm]);
  sheet.dims.push({ view: "edge", along: "thickness", kind: "overall", values_mm: [row.thickness_mm] });

  const label = (x: number, y: number, text: string) => pen.text(x, y, text, { size_mm: 3, anchor: "middle", bold: true });
  label(fx + L / s / 2, fy + W / s + 5.5, "Face");
  label(ex + L / s / 2, ey + T / s + 5.5, "Edge");
  label(nx + T / s / 2, ny + W / s + 5.5, "End");

  // Notes and the legend.
  let y = bottom + 4;
  if (notes.length) {
    const heading = !shaped.length ? "Machining" : part.machining.length ? "Machining and shape" : "Shape";
    pen.text(area.x, y, heading, { size_mm: 3, bold: true });
    y += 5;
    noteLines.forEach((lines, k) => {
      pen.circle(area.x + 2, y - 0.9, 2, { stroke_mm: THIN, fill: "#ffffff" });
      pen.text(area.x + 2, y - 0.1, String(k + 1), { size_mm: 2.2, anchor: "middle", bold: true });
      for (const line of lines) {
        pen.text(area.x + 6, y, line);
        y += 3.6;
      }
      y += 0.8;
    });
  } else {
    pen.text(area.x, y, "No machining. Cut it to size.", { size_mm: 3 });
    y += 5;
  }
  for (const line of legend) {
    pen.text(area.x, y, line, { colour: GREY });
    y += 3.6;
  }

  sheet.marks = pen.marks;
  return sheet;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

interface Column {
  head: string;
  /** A share of the table's width. */
  weight: number;
  align?: "start" | "end";
}

const ROW_LINE = 3.6;

/** A table across as many sheets as it needs, its header on each. */
function tableSheets(kind: Sheet["kind"], title: string, intro: string[], cols: Column[], rows: string[][], paper: Paper): Sheet[] {
  const area = drawingArea(paper);
  const total = cols.reduce((s, c) => s + c.weight, 0);
  const widths = cols.map((c) => (c.weight / total) * area.w);
  const sheets: Sheet[] = [];
  let pen = new Pen();
  let y = 0;
  const start = () => {
    const sheet = blankSheet(kind, sheets.length ? `${title} (continued)` : title, paper, null);
    sheets.push(sheet);
    pen = new Pen();
    sheet.marks = pen.marks;
    y = area.y + 5;
    pen.text(area.x, y, sheet.title, { size_mm: 5, bold: true });
    y += 6;
    if (sheets.length === 1) {
      for (const line of intro.flatMap((t) => wrap(t, area.w, 3))) {
        pen.text(area.x, y, line, { size_mm: 3 });
        y += 4.5;
      }
    }
    y += 2;
    pen.rect(area.x, y, area.w, 6, { stroke_mm: 0, fill: "#eeeeee" });
    let x = area.x;
    cols.forEach((c, i) => {
      const w = widths[i]!;
      const text = clip(c.head, w - 2, TEXT, true);
      if (c.align === "end") pen.text(x + w - 3, y + 4.2, text, { bold: true, anchor: "end" });
      else pen.text(x + 1, y + 4.2, text, { bold: true });
      x += w;
    });
    y += 6;
    pen.line(area.x, y, area.x + area.w, y, THIN);
  };
  start();
  for (const row of rows) {
    const cells = row.map((cell, i) => wrap(cell, widths[i]! - (cols[i]!.align === "end" ? 4 : 2), TEXT));
    const h = Math.max(...cells.map((c) => c.length)) * ROW_LINE + 2.4;
    if (y + h > area.y + area.h) start();
    let x = area.x;
    cells.forEach((lines, i) => {
      const w = widths[i]!;
      lines.forEach((line, k) => {
        const ly = y + 1.2 + 2.6 + k * ROW_LINE;
        if (cols[i]!.align === "end") pen.text(x + w - 3, ly, line, { anchor: "end" });
        else pen.text(x + 1, ly, line);
      });
      x += w;
    });
    y += h;
    pen.line(area.x, y, area.x + area.w, y, FINE);
  }
  return sheets;
}

function cutListSheets(list: CutList, d: DeriveResult, paper: Paper, sheetOf: Map<number, number>): Sheet[] {
  // The kinds of machining, counted. The row's own sheet has the detail.
  const summary = (r: CutRow) => {
    const counts = new Map<string, number>();
    for (const m of d.byId.get(r.parts[0]!)?.machining ?? []) counts.set(m.label, (counts.get(m.label) ?? 0) + 1);
    return [...counts].map(([label, n]) => (n > 1 ? `${label} ×${n}` : label)).join(", ");
  };
  const parts = list.rows.reduce((s, r) => s + r.qty, 0);
  const intro = [
    "Cut sizes include joinery, and lengths run along the grain. Sizes are in mm, to 0.1 mm as in the app.",
    `${parts} ${parts === 1 ? "part" : "parts"} in ${list.rows.length} ${list.rows.length === 1 ? "row" : "rows"}. Each row has its own sheet with its machining.`,
  ];
  if (list.excluded.length) intro.push(`Left off: ${list.excluded.map((e) => `${e.id} (${e.reason})`).join(", ")}.`);
  if (!list.rows.length) intro.push("Nothing to cut yet.");
  return tableSheets(
    "cut list",
    "Cut list",
    intro,
    [
      { head: "#", weight: 5, align: "end" },
      { head: "Part", weight: 30 },
      { head: "Qty", weight: 6, align: "end" },
      { head: "Length", weight: 10, align: "end" },
      { head: "Width", weight: 10, align: "end" },
      { head: "Thick", weight: 8, align: "end" },
      { head: "Material", weight: 32 },
      { head: "Grain", weight: 9 },
      { head: "Machining", weight: 34 },
      { head: "Sheet", weight: 7, align: "end" },
    ],
    list.rows.map((r) => [
      String(r.row),
      r.name,
      String(r.qty),
      num(r.length_mm),
      num(r.width_mm),
      num(r.thickness_mm),
      r.material_name,
      r.grain ? "along L" : "",
      summary(r),
      String(sheetOf.get(r.row) ?? ""),
    ]),
    paper,
  );
}

/**
 * Every screw, dowel and pocket hole, one line per kind of hole in each
 * cut-list row's part, with centres measured on that part's drawing.
 */
export function drillingList(design: Design, d: DeriveResult, list: CutList = cutList(design, d)): DrillRow[] {
  const out: DrillRow[] = [];
  for (const row of list.rows) {
    const part = d.byId.get(row.parts[0]!);
    if (!part) continue;
    const f = frameOf(part);
    const byKind = new Map<string, DrillRow>();
    for (const m of part.machining) {
      if (!FASTENER_LABELS.has(m.label)) continue;
      const drillAxis = FACE_AXIS[m.face];
      const drill = frameAxis(f, drillAxis);
      const extent = [f.size.L, f.size.W, f.size.T][drill]!;
      const face = faceName(f, m.face);
      const other = machiningWith(m);
      const diameter_mm = roundCut(m.diameter_mm ?? 4);
      const depth_mm = roundCut(m.depth_mm);
      const key = [m.label, other, diameter_mm, depth_mm, face].join("|");
      const centres = centresInFrame(f, m, d).map((c) => centreText(f, drill, c));
      const n = Math.max(1, m.count ?? 1);
      const hit = byKind.get(key);
      if (hit) {
        hit.count += n;
        hit.centres.push(...centres);
        continue;
      }
      const r: DrillRow = {
        row: row.row,
        part: row.name,
        qty: row.qty,
        holes: m.label,
        with: other,
        count: n,
        diameter_mm,
        depth_mm,
        through: m.label === "screw holes" && m.depth_mm >= extent - EPS,
        face,
        centres,
      };
      byKind.set(key, r);
      out.push(r);
    }
  }
  return out;
}

function drillingSheets(rows: DrillRow[], paper: Paper, sheetOf: Map<number, number>): Sheet[] {
  if (!rows.length) return [];
  const depth = (r: DrillRow) => (r.through ? "through" : r.holes === "pocket holes" ? "set by jig" : num(r.depth_mm));
  return tableSheets(
    "drilling",
    "Drilling list",
    [
      "Every screw, dowel and pocket hole, from each part's machining. Sizes are in mm, to 0.1 mm as in the cut list.",
      `Centres are measured on each part's sheet. ${POSITIONS}`,
    ],
    [
      { head: "Part", weight: 24 },
      { head: "Sheet", weight: 7, align: "end" },
      { head: "Make", weight: 7, align: "end" },
      { head: "Holes", weight: 15 },
      { head: "For", weight: 18 },
      { head: "Each", weight: 7, align: "end" },
      { head: "Total", weight: 7, align: "end" },
      { head: "Ø", weight: 6, align: "end" },
      { head: "Depth", weight: 11, align: "end" },
      { head: "Face", weight: 12 },
      { head: "Centres", weight: 56 },
    ],
    rows.map((r) => [
      `${r.row}. ${r.part}`,
      String(sheetOf.get(r.row) ?? ""),
      String(r.qty),
      r.holes,
      r.with,
      String(r.count),
      String(r.count * r.qty),
      num(r.diameter_mm),
      depth(r),
      r.face,
      r.centres.join("; "),
    ]),
    paper,
  );
}

function hardwareSheets(list: CutList, paper: Paper): Sheet[] {
  if (!list.hardware.length) return [];
  return tableSheets(
    "hardware",
    "Hardware list",
    ["Everything to buy that isn't cut from timber. Spec sizes are as the design gives them."],
    [
      { head: "Item", weight: 40 },
      { head: "Kind", weight: 18 },
      { head: "Qty", weight: 7, align: "end" },
      { head: "Spec", weight: 60 },
      { head: "Library part", weight: 22 },
    ],
    list.hardware.map((h) => [h.name, h.kind.replace(/_/g, " "), String(h.qty), h.spec, h.library_part ?? ""]),
    paper,
  );
}

// ---------------------------------------------------------------------------
// The frame on every sheet
// ---------------------------------------------------------------------------

/** A scale bar: about 50 mm on paper, in round model millimetres. */
function scaleBar(scale: number): { length_mm: number; parts: number } {
  const bars: Record<number, { length_mm: number; parts: number }> = {
    1: { length_mm: 50, parts: 5 },
    2: { length_mm: 100, parts: 5 },
    5: { length_mm: 200, parts: 4 },
    10: { length_mm: 500, parts: 5 },
    20: { length_mm: 1000, parts: 5 },
    50: { length_mm: 2000, parts: 4 },
  };
  return bars[scale] ?? { length_mm: 50 * scale, parts: 5 };
}

function frame(sheet: Sheet, name: string, date: string, n: number, total: number) {
  const pen = new Pen();
  const W = sheet.width_mm;
  const H = sheet.height_mm;
  pen.rect(BORDER, BORDER, W - 2 * BORDER, H - 2 * BORDER, { stroke_mm: 0.5 });

  // The title block.
  const x0 = W - BORDER - TB_W;
  const y0 = H - BORDER - TB_H;
  pen.rect(x0, y0, TB_W, TB_H, { stroke_mm: OUTLINE, fill: "#ffffff" });
  pen.line(x0, y0 + 10, x0 + TB_W, y0 + 10);
  pen.line(x0, y0 + 17, x0 + TB_W, y0 + 17);
  pen.text(x0 + 3, y0 + 7, clip(name, TB_W - 30, 4.5, true), { size_mm: 4.5, bold: true });
  pen.text(x0 + TB_W - 3, y0 + 4.5, "Woodchuck", { size_mm: 2, colour: GREY, anchor: "end" });
  pen.text(x0 + 3, y0 + 14.8, clip(sheet.title, TB_W - 6, 3.2), { size_mm: 3.2 });
  const cells: [number, string][] = [
    [32, sheet.scale ? `Scale 1:${sheet.scale}` : "Not to scale"],
    [16, sheet.paper],
    [52, date],
    [50, `Sheet ${n} of ${total}`],
  ];
  let cx = x0;
  cells.forEach(([w, text], i) => {
    if (i) pen.line(cx, y0 + 17, cx, y0 + TB_H);
    pen.text(cx + 2.5, y0 + 23, clip(text, w - 4, 3), { size_mm: 3, bold: i === 3 });
    cx += w;
  });

  // The scale bar and the note to print at full size, left of the title block.
  const scale = sheet.scale ?? 1;
  const bar = scaleBar(scale);
  const bx = BORDER + PAD;
  const by = y0 + 7;
  const len = bar.length_mm / scale;
  pen.text(bx, y0 + 4, sheet.scale ? `Scale 1:${sheet.scale}` : "Print check, full size", { size_mm: 2.8, bold: true });
  for (let k = 0; k < bar.parts; k++) {
    const w = len / bar.parts;
    pen.rect(bx + k * w, by, w, 2, { stroke_mm: FINE, fill: k % 2 ? "#ffffff" : "#000000" });
  }
  pen.text(bx, by + 5.5, "0", { size_mm: 2.2, anchor: "middle" });
  pen.text(bx + len, by + 5.5, `${fmt(bar.length_mm)} mm`, { size_mm: 2.2, anchor: "middle" });
  pen.text(bx, y0 + 19, "Print at 100%, actual size, not fit to page.", { size_mm: TEXT, bold: true });
  pen.text(bx, y0 + 23.5, "Measure the scale bar before you cut. Sizes are in mm.", { size_mm: TEXT });
  sheet.marks.push(...pen.marks);
}

function longDate(d: Date): string {
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * The workshop drawings for a design: the general arrangement, a sheet for
 * each cut-list row, then the cut list, drilling list and hardware list.
 * Every sheet is on the same paper, so the set prints in one go, and each
 * drawing takes the largest standard scale that fits it.
 */
export function workshopDrawings(design: Design, d: DeriveResult, opts: DrawingOptions = {}): Sheet[] {
  const list = cutList(design, d);
  const date = opts.date ?? longDate(new Date());
  const paper = opts.paper ?? "A4";
  const ga = arrangement(design, d, paper);
  const parts = list.rows.map((row) => partSheet(row, d, paper));
  const sheetOf = new Map(list.rows.map((r, i) => [r.row, i + 2]));
  const tables = [...cutListSheets(list, d, paper, sheetOf), ...drillingSheets(drillingList(design, d, list), paper, sheetOf), ...hardwareSheets(list, paper)];
  const sheets = [ga, ...parts, ...tables];
  sheets.forEach((s, i) => frame(s, design.name, date, i + 1, sheets.length));
  return sheets;
}

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

const n2 = (v: number) => String(Math.round(v * 100) / 100);

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** One sheet as SVG at true size, in millimetres. */
export function sheetSvg(sheet: Sheet): string {
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sheet.width_mm}mm" height="${sheet.height_mm}mm" viewBox="0 0 ${sheet.width_mm} ${sheet.height_mm}" font-family="Helvetica, Arial, sans-serif">`,
    `<rect width="${sheet.width_mm}" height="${sheet.height_mm}" fill="#ffffff"/>`,
  ];
  const stroke = (m: { stroke_mm: number; dashed?: boolean }) =>
    m.stroke_mm > 0 ? ` stroke="#000000" stroke-width="${n2(m.stroke_mm)}" stroke-linecap="round" stroke-linejoin="round"${m.dashed ? ' stroke-dasharray="2 1"' : ""}` : "";
  for (const m of sheet.marks) {
    switch (m.kind) {
      case "line":
        out.push(`<line x1="${n2(m.x1_mm)}" y1="${n2(m.y1_mm)}" x2="${n2(m.x2_mm)}" y2="${n2(m.y2_mm)}"${stroke(m)}/>`);
        break;
      case "shape":
        if (m.holes_mm?.length) {
          // Each hole is a loop of its own, left open by the even-odd rule.
          const d = [m.points_mm, ...m.holes_mm].map((l) => `M${l.map((p) => `${n2(p[0])},${n2(p[1])}`).join("L")}Z`).join("");
          out.push(`<path d="${d}" fill-rule="evenodd" fill="${m.fill ?? "none"}"${stroke(m)}/>`);
          break;
        }
        out.push(`<polygon points="${m.points_mm.map((p) => `${n2(p[0])},${n2(p[1])}`).join(" ")}" fill="${m.fill ?? "none"}"${stroke(m)}/>`);
        break;
      case "circle":
        out.push(`<circle cx="${n2(m.cx_mm)}" cy="${n2(m.cy_mm)}" r="${n2(m.r_mm)}" fill="${m.fill ?? "none"}"${stroke(m)}/>`);
        break;
      case "text": {
        const anchor = m.anchor && m.anchor !== "start" ? ` text-anchor="${m.anchor}"` : "";
        const weight = m.bold ? ' font-weight="bold"' : "";
        const turn = m.vertical ? ` transform="rotate(-90 ${n2(m.x_mm)} ${n2(m.y_mm)})"` : "";
        out.push(`<text x="${n2(m.x_mm)}" y="${n2(m.y_mm)}" font-size="${n2(m.size_mm)}" fill="${m.colour ?? "#000000"}"${anchor}${weight}${turn}>${esc(m.text)}</text>`);
        break;
      }
    }
  }
  out.push("</svg>");
  return out.join("\n");
}
