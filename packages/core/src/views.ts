// Draws a design from fixed cameras as SVG: front, back, top, left, right
// and an isometric view. Claude gets these as pictures to check its work,
// and the app shows them as 2D views. Each part can carry its id.
//
// Parts are drawn as their visible boxes. Joinery tongues sit inside their
// hosts, so they'd never show, and leaving them out keeps the drawing order
// exact.

import { AXIS_INDEX, type Box, type DeriveResult, type DerivedPart, type Vec3 } from "./derive.js";
import { fmt } from "./expr.js";

export type ViewName = "front" | "back" | "top" | "left" | "right" | "iso";
export const VIEW_NAMES: readonly ViewName[] = ["front", "back", "top", "left", "right", "iso"];

/**
 * The colours of the sheet a drawing is made on. The default is white paper
 * with dark ink. The app passes its own theme's, so the 2D views suit a dark
 * theme. The parts keep their own colours.
 */
export interface PaperColours {
  background: string;
  /** The thin line round each view on a sheet. */
  rule: string;
  /** Titles and sizes. */
  ink: string;
  /** Size lines and notes. */
  mid: string;
  /** The outline of a part in a see-through drawing, where there's no fill to hold it. */
  edge: string;
  /** A part's name in a see-through drawing. */
  label: string;
}

export const WHITE_PAPER: PaperColours = { background: "#ffffff", rule: "#dddddd", ink: "#333333", mid: "#555555", edge: "#3b2f25", label: "#1d1712" };

/** Six hex digits with a hash, which is all a paper colour may be: it goes straight into the drawing. */
export function isPaperColour(v: unknown): v is string {
  return typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
}

const PAPER_KEYS = Object.keys(WHITE_PAPER) as (keyof PaperColours)[];

/** A paper as address parameters, such as paper-ink=f4f4f5, for the picture of a view. */
export function paperParams(paper: Partial<PaperColours>): string {
  return PAPER_KEYS.filter((k) => isPaperColour(paper[k]))
    .map((k) => `paper-${k}=${paper[k]!.slice(1).toLowerCase()}`)
    .join("&");
}

/** The paper those parameters ask for. Anything that isn't six hex digits is ignored. */
export function paperFromParams(params: URLSearchParams): Partial<PaperColours> {
  const out: Partial<PaperColours> = {};
  for (const k of PAPER_KEYS) {
    const v = `#${params.get(`paper-${k}`) ?? ""}`;
    if (isPaperColour(v)) out[k] = v;
  }
  return out;
}

export interface ViewOptions {
  labels?: boolean;
  highlight?: string[];
  /** Only these parts are drawn. */
  isolate?: string[];
  width?: number;
  height?: number;
  dims?: boolean;
  /** See-through: faint parts, with tongues, cut-outs and fixings drawn on top. */
  xray?: boolean;
  /** The sheet's colours, where they differ from white paper. */
  paper?: Partial<PaperColours>;
}

/** The sheet to draw on: white paper, with any colours asked for that are safe to draw. */
function colourOf(opts: ViewOptions): PaperColours {
  const out = { ...WHITE_PAPER };
  for (const k of PAPER_KEYS) {
    const v = opts.paper?.[k];
    if (isPaperColour(v)) out[k] = v;
  }
  return out;
}

type P2 = [number, number];

const WOOD = ["#d9b98c", "#c89f6d", "#e3c9a0", "#b98b5a", "#d2ab7c", "#e8d3b0", "#a87d4f", "#cfa774"];

function hash(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
  const r = ch((n >> 16) & 255);
  const g = ch((n >> 8) & 255);
  const b = ch(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

const HARDWARE = "__hardware";

/** Hardware models are drawn and sorted like parts, in grey. */
export function hardwareParts(d: DeriveResult, isolate?: Set<string>): DerivedPart[] {
  const out: DerivedPart[] = [];
  for (const h of d.hardware) {
    if (isolate && !isolate.has(h.id) && !isolate.has(h.source) && !h.connects.some((c) => isolate.has(c))) continue;
    h.boxes.forEach((b, i) => {
      out.push({
        id: h.boxes.length > 1 ? `${h.id}:${i + 1}` : h.id,
        source: h.source,
        copy: 1,
        name: h.name,
        material: HARDWARE,
        thickness_axis: "z",
        grain_axis: "x",
        width_axis: "y",
        tags: ["hardware"],
        decor: false,
        unverified: false,
        broken: false,
        nominal: b,
        box: b,
        axes: {} as DerivedPart["axes"],
        extensions: [],
        machining: [],
        finished: { length: 0, width: 0, thickness: 0 },
        cut: { length: 0, width: 0, thickness: 0 },
      });
    });
  }
  return out;
}

function colourFor(p: DerivedPart): string {
  if (p.material === HARDWARE) return "#adb5bd";
  if (p.unverified) return "#f0a24a";
  if (p.decor) return "#c9c9c9";
  return WOOD[hash(p.material) % WOOD.length]!;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function polyArea(ps: P2[]): number {
  let a = 0;
  for (let i = 0; i < ps.length; i++) {
    const [x1, y1] = ps[i]!;
    const [x2, y2] = ps[(i + 1) % ps.length]!;
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

function inPoly(pt: P2, ps: P2[]): boolean {
  let inside = false;
  for (let i = 0, j = ps.length - 1; i < ps.length; j = i++) {
    const [xi, yi] = ps[i]!;
    const [xj, yj] = ps[j]!;
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const S2 = Math.SQRT2;
const S6 = Math.sqrt(6);
const S3 = Math.sqrt(3);

function project(view: ViewName, x: number, y: number, z: number): P2 {
  switch (view) {
    case "front":
      return [x, -y];
    case "back":
      return [-x, -y];
    case "top":
      return [x, z];
    case "left":
      return [z, -y];
    case "right":
      return [-z, -y];
    case "iso":
      return [(x - z) / S2, -(-x + 2 * y - z) / S6];
  }
}

function depthOf(view: ViewName, x: number, y: number, z: number): number {
  switch (view) {
    case "front":
      return z;
    case "back":
      return -z;
    case "top":
      return y;
    case "left":
      return -x;
    case "right":
      return x;
    case "iso":
      return (x + y + z) / S3;
  }
}

/** The direction the camera looks from, as a sign per axis. 0 means side-on. */
const VIEWER: Record<ViewName, [number, number, number]> = {
  front: [0, 0, 1],
  back: [0, 0, -1],
  top: [0, 1, 0],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  iso: [1, 1, 1],
};

function corners(b: Box): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) out.push([x, y, z]);
  return out;
}

/** Visible faces of a box as polygons, nearest-facing first. */
function faces(view: ViewName, b: Box): { pts: P2[]; light: number }[] {
  const v = VIEWER[view];
  const out: { pts: P2[]; light: number }[] = [];
  const [x0, y0, z0] = b.min;
  const [x1, y1, z1] = b.max;
  const quad = (pts: [number, number, number][], light: number) =>
    out.push({ pts: pts.map(([x, y, z]) => project(view, x, y, z)), light });
  if (v[0] > 0) quad([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], 0.82);
  if (v[0] < 0) quad([[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]], 0.9);
  if (v[1] > 0) quad([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], 1.08);
  if (v[2] > 0) quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], 1);
  if (v[2] < 0) quad([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], 0.95);
  return out;
}

/** Back-to-front order. Boxes separated along a viewed axis sort exactly. */
export function paintOrder(view: ViewName, parts: DerivedPart[]): DerivedPart[] {
  const v = VIEWER[view];
  const n = parts.length;
  const centreDepth = (p: DerivedPart) =>
    depthOf(view, (p.nominal.min[0] + p.nominal.max[0]) / 2, (p.nominal.min[1] + p.nominal.max[1]) / 2, (p.nominal.min[2] + p.nominal.max[2]) / 2);
  // True when a is behind b. Boxes split along a viewed axis sort exactly.
  // When two axes disagree the boxes can't overlap on screen, so there's no
  // order between them ("skip"). Boxes that interpenetrate, as at a joint,
  // fall back to comparing their centres.
  const behind = (a: Box, b: Box): boolean | null | "skip" => {
    const votes = new Set<boolean>();
    for (let i = 0; i < 3; i++) {
      if (v[i] === 0) continue;
      const aFirst = v[i]! > 0 ? a.max[i]! <= b.min[i]! + 1e-6 : a.min[i]! >= b.max[i]! - 1e-6;
      const bFirst = v[i]! > 0 ? b.max[i]! <= a.min[i]! + 1e-6 : b.min[i]! >= a.max[i]! - 1e-6;
      if (aFirst) votes.add(true);
      if (bFirst) votes.add(false);
    }
    if (votes.size === 2) return "skip";
    if (votes.size === 1) return [...votes][0]!;
    return null;
  };
  const after: number[][] = parts.map(() => []);
  const indeg = new Array<number>(n).fill(0);
  const rects = parts.map((p) => {
    const ps = corners(p.nominal).map(([x, y, z]) => project(view, x, y, z));
    return [Math.min(...ps.map((q) => q[0])), Math.min(...ps.map((q) => q[1])), Math.max(...ps.map((q) => q[0])), Math.max(...ps.map((q) => q[1]))];
  });
  const screenOverlap = (i: number, j: number) => {
    const a = rects[i]!;
    const b = rects[j]!;
    return a[0]! < b[2]! - 1e-6 && b[0]! < a[2]! - 1e-6 && a[1]! < b[3]! - 1e-6 && b[1]! < a[3]! - 1e-6;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (!screenOverlap(i, j)) continue;
      let r = behind(parts[i]!.nominal, parts[j]!.nominal);
      if (r === "skip") continue;
      if (r === null) r = centreDepth(parts[i]!) <= centreDepth(parts[j]!);
      if (r) {
        after[i]!.push(j);
        indeg[j]!++;
      } else {
        after[j]!.push(i);
        indeg[i]!++;
      }
    }
  }
  const ready = parts.map((_, i) => i).filter((i) => indeg[i] === 0);
  const out: DerivedPart[] = [];
  const done = new Set<number>();
  while (out.length < n) {
    if (!ready.length) {
      // A cycle from overlapping parts: take the farthest remaining.
      const rest = parts.map((_, i) => i).filter((i) => !done.has(i));
      rest.sort((a, b) => centreDepth(parts[a]!) - centreDepth(parts[b]!));
      ready.push(rest[0]!);
      indeg[rest[0]!] = 0;
    }
    ready.sort((a, b) => centreDepth(parts[a]!) - centreDepth(parts[b]!));
    const i = ready.shift()!;
    if (done.has(i)) continue;
    done.add(i);
    out.push(parts[i]!);
    for (const j of after[i]!) {
      indeg[j]!--;
      if (indeg[j] === 0 && !done.has(j)) ready.push(j);
    }
  }
  return out;
}

export interface RenderedView {
  svg: string;
  width: number;
  height: number;
}

function viewBody(view: ViewName, d: DeriveResult, opts: ViewOptions, w: number, h: number): string {
  const paper = colourOf(opts);
  const highlight = new Set(opts.highlight ?? []);
  let parts = d.parts.filter((p) => !p.broken);
  const keep = opts.isolate?.length ? new Set(opts.isolate) : undefined;
  if (keep) parts = parts.filter((p) => keep.has(p.id) || keep.has(p.source));
  parts = [...parts, ...hardwareParts(d, keep)];
  if (!parts.length) {
    return `<text x="${w / 2}" y="${h / 2}" text-anchor="middle" font-size="14" fill="${paper.mid}">Nothing to draw yet</text>`;
  }
  const pts = parts.flatMap((p) => corners(p.nominal).map(([x, y, z]) => project(view, x, y, z)));
  const minX = Math.min(...pts.map((p) => p[0]));
  const maxX = Math.max(...pts.map((p) => p[0]));
  const minY = Math.min(...pts.map((p) => p[1]));
  const maxY = Math.max(...pts.map((p) => p[1]));
  const pad = opts.dims === false || view === "iso" ? 24 : 56;
  const scale = Math.min((w - 2 * pad) / Math.max(maxX - minX, 1), (h - 2 * pad - 20) / Math.max(maxY - minY, 1));
  const ox = pad + (w - 2 * pad - (maxX - minX) * scale) / 2 - minX * scale;
  const oy = pad + 20 + (h - 2 * pad - 20 - (maxY - minY) * scale) / 2 - minY * scale;
  const tx = (p: P2): P2 => [ox + p[0] * scale, oy + p[1] * scale];

  const out: string[] = [];
  const order = paintOrder(view, parts);
  const drawn = order.map((p) => ({ p, faces: faces(view, p.nominal).map((f) => ({ ...f, pts: f.pts.map(tx) })) }));
  for (const { p, faces: fs } of drawn) {
    const base = colourFor(p);
    const hl = highlight.has(p.id) || highlight.has(p.source);
    // A solid part's outline sits on its own colour. A see-through one has only the outline to show it.
    const stroke = hl ? "#d6336c" : opts.xray ? paper.edge : "#3b2f25";
    const sw = hl ? 2.2 : 0.8;
    const opacity = opts.xray ? ' fill-opacity="0.12"' : "";
    for (const f of fs) {
      const fill = p.unverified ? "url(#unverified)" : shade(base, f.light);
      const pts = f.pts.map((q) => q.map((v) => v.toFixed(1)).join(",")).join(" ");
      out.push(`<polygon points="${pts}" fill="${fill}"${opacity} stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"/>`);
    }
  }
  if (opts.xray) {
    const shown = new Set(parts.map((p) => p.id));
    const feats = d.joints.flatMap((j) => j.features.filter((f) => shown.has(f.part)));
    const poly = (b: Box) =>
      faces(view, b).map((f) => f.pts.map((q) => tx(q).map((v) => v.toFixed(1)).join(",")).join(" "));
    for (const f of feats.filter((x) => x.kind === "removed" && x.box)) {
      for (const pts of poly(f.box!)) out.push(`<polygon points="${pts}" fill="#e03131" fill-opacity="0.28" stroke="#c92a2a" stroke-width="0.9"/>`);
    }
    for (const f of feats.filter((x) => x.kind === "tongue" && x.box)) {
      const owner = d.byId.get(f.part);
      const fill = owner ? colourFor(owner) : "#d2ab7c";
      for (const pts of poly(f.box!)) out.push(`<polygon points="${pts}" fill="${fill}" stroke="#7a3e00" stroke-width="1.4"/>`);
    }
    for (const f of feats.filter((x) => x.kind === "fastener" && x.from && x.to)) {
      const [x1, y1] = tx(project(view, ...f.from!));
      const [x2, y2] = tx(project(view, ...f.to!));
      const w = Math.max(1.6, (f.diameter_mm ?? 4) * scale);
      out.push(`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#343a40" stroke-width="${w.toFixed(1)}" stroke-linecap="round"/>`);
    }
  }
  // See-through drawings get busy, so they're labelled only for a few parts.
  if (opts.labels !== false && !(opts.xray && parts.length > 14)) {
    // Label a part only where it can be seen: at the middle of its largest
    // face, if nothing drawn later covers that spot.
    drawn.forEach(({ p, faces: fs }, k) => {
      const face = fs.reduce((a, b) => (polyArea(b.pts) > polyArea(a.pts) ? b : a), fs[0]!);
      if (!face) return;
      const cx = face.pts.reduce((s, q) => s + q[0], 0) / face.pts.length;
      const cy = face.pts.reduce((s, q) => s + q[1], 0) / face.pts.length;
      const covered = !opts.xray && drawn.slice(k + 1).some((later) => later.faces.some((f) => inPoly([cx, cy], f.pts)));
      if (covered) return;
      const xs = face.pts.map((q) => q[0]);
      const ys = face.pts.map((q) => q[1]);
      const bw = Math.max(...xs) - Math.min(...xs);
      const bh = Math.max(...ys) - Math.min(...ys);
      const size = Math.min(11, Math.max(bw, bh) / Math.max(p.id.length * 0.62, 1));
      if (size < 6.5) return;
      const vertical = bh > bw * 1.6 && bw < p.id.length * size * 0.62;
      const rot = vertical ? ` transform="rotate(-90 ${cx.toFixed(1)} ${cy.toFixed(1)})"` : "";
      out.push(
        `<text x="${cx.toFixed(1)}" y="${(cy + size / 3).toFixed(1)}" text-anchor="middle" font-size="${size.toFixed(1)}" fill="${opts.xray ? paper.label : "#1d1712"}" stroke="${opts.xray ? paper.background : "#fff"}" stroke-width="2.4" paint-order="stroke"${rot}>${esc(p.id)}</text>`,
      );
    });
  }
  if (view !== "iso" && opts.dims !== false) {
    const [x0, y0] = tx([minX, minY]);
    const [x1, y1] = tx([maxX, maxY]);
    const across = (maxX - minX).toFixed(1);
    const up = (maxY - minY).toFixed(1);
    const dimY = y1 + 22;
    const dimX = x0 - 22;
    out.push(
      `<g stroke="${paper.mid}" stroke-width="0.8" fill="none"><line x1="${x0}" y1="${dimY}" x2="${x1}" y2="${dimY}"/><line x1="${x0}" y1="${dimY - 5}" x2="${x0}" y2="${dimY + 5}"/><line x1="${x1}" y1="${dimY - 5}" x2="${x1}" y2="${dimY + 5}"/>` +
        `<line x1="${dimX}" y1="${y0}" x2="${dimX}" y2="${y1}"/><line x1="${dimX - 5}" y1="${y0}" x2="${dimX + 5}" y2="${y0}"/><line x1="${dimX - 5}" y1="${y1}" x2="${dimX + 5}" y2="${y1}"/></g>`,
    );
    out.push(`<text x="${((x0 + x1) / 2).toFixed(1)}" y="${dimY + 14}" text-anchor="middle" font-size="11" fill="${paper.ink}">${fmt(Number(across))}</text>`);
    out.push(
      `<text x="${dimX - 6}" y="${((y0 + y1) / 2).toFixed(1)}" text-anchor="middle" font-size="11" fill="${paper.ink}" transform="rotate(-90 ${dimX - 6} ${((y0 + y1) / 2).toFixed(1)})">${fmt(Number(up))}</text>`,
    );
  }
  return out.join("\n");
}

const DEFS = `<defs><pattern id="unverified" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="8" height="8" fill="#f6c27f"/><rect width="4" height="8" fill="#e8892c"/></pattern></defs>`;

const XRAY_NOTE = "See-through: red is cut away, outlined blocks are tongues and tenons, dark rods are screws and dowels";

const TITLES: Record<ViewName, string> = {
  front: "Front",
  back: "Back",
  top: "Top (plan)",
  left: "Left side",
  right: "Right side",
  iso: "Isometric",
};

export function renderView(view: ViewName, d: DeriveResult, opts: ViewOptions = {}): RenderedView {
  const w = opts.width ?? 640;
  const h = opts.height ?? 480;
  const paper = colourOf(opts);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="Helvetica, Arial, sans-serif">` +
    DEFS +
    `<rect width="${w}" height="${h}" fill="${paper.background}"/>` +
    `<text x="12" y="20" font-size="13" font-weight="bold" fill="${paper.ink}">${TITLES[view]}${opts.xray ? " (see-through)" : ""}</text>` +
    viewBody(view, d, opts, w, h) +
    `</svg>`;
  return { svg, width: w, height: h };
}

/** Several views on one sheet, two to a row. */
export function renderSheet(views: ViewName[], d: DeriveResult, opts: ViewOptions = {}): RenderedView {
  const cw = opts.width ?? 560;
  const ch = opts.height ?? 420;
  const cols = views.length === 1 ? 1 : 2;
  const rows = Math.ceil(views.length / cols);
  const paper = colourOf(opts);
  const w = cw * cols;
  const h = ch * rows;
  const cells = views.map((v, i) => {
    const x = (i % cols) * cw;
    const y = Math.floor(i / cols) * ch;
    return (
      `<g transform="translate(${x} ${y})"><rect width="${cw}" height="${ch}" fill="${paper.background}" stroke="${paper.rule}"/>` +
      `<text x="12" y="20" font-size="13" font-weight="bold" fill="${paper.ink}">${TITLES[v]}${opts.xray ? " (see-through)" : ""}</text>` +
      viewBody(v, d, opts, cw, ch) +
      `</g>`
    );
  });
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="Helvetica, Arial, sans-serif">` +
    DEFS +
    `<rect width="${w}" height="${h}" fill="${paper.background}"/>` +
    cells.join("") +
    (opts.xray ? `<text x="12" y="${h - 8}" font-size="11" fill="${paper.mid}">${XRAY_NOTE}</text>` : "") +
    `</svg>`;
  return { svg, width: w, height: h };
}

export { AXIS_INDEX };

/** For the workshop drawings, which draw the same views at a true scale. */
export { faces as visibleFaces, project as projectPoint, HARDWARE as HARDWARE_MATERIAL };

/** A small drawing of a library part's model, for its card. */
export function renderPartPreview(
  part: { id: string; name: string; kind: string; shape: { name: string; min_mm: [number, number, number]; max_mm: [number, number, number] }[] },
  width = 360,
  height = 220,
  paper?: Partial<PaperColours>,
): string {
  const boxes = part.shape.map((b) => ({ min: [...b.min_mm] as Vec3, max: [...b.max_mm] as Vec3 }));
  const d = {
    params: {},
    parts: [],
    joints: [],
    hardware: [{ id: part.id, source: part.id, kind: part.kind, name: part.name, connects: [], qty: 1, spec: {}, boxes }],
    issues: [],
    byId: new Map(),
    evaluate: () => {
      throw new Error("no design");
    },
  } as unknown as DeriveResult;
  return renderSheet(["iso", "front"], d, { labels: false, width: width / 2, height, ...(paper ? { paper } : {}) }).svg;
}
