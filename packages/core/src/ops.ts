// Every change to a design is one of these operations, whether it comes
// from Claude, a mouse edit or the command line. Each one checks its input
// and either returns a new design or throws an OpError that says how to
// fix the call.

import { parse, refsOf, ExprError } from "./expr.js";
import { partRefParts } from "./derive.js";
import { validateLibraryPart } from "./library.js";
import { finishesInside, normaliseFinish, parseFinishTarget, PALETTES } from "./finishes.js";
import { SPECIES, SPECIES_IDS } from "./species.js";
import { DEFAULT_TRIM_MM } from "./layout.js";
import {
  AXES,
  AXIS_FACES,
  FACE_AXIS,
  FACES,
  ID_PATTERN,
  JOINT_FAMILY,
  JOINT_TYPES,
  type ArrayPattern,
  type Axis,
  type AxisSpec,
  type Bound,
  type Cutout,
  type Design,
  type EdgeCut,
  type Face,
  type Hardware,
  type Joint,
  type JointType,
  type Material,
  type MaterialStock,
  type Panel,
  type PanelCut,
  type Param,
  type ParamUnit,
  type Plan,
  type Rule,
  type Severity,
  type StockSettings,
  type UnverifiedBox,
  emptyDesign,
} from "./types.js";

export class OpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpError";
  }
}

export type Op =
  | ({ op: "set_param" } & Param)
  | { op: "delete_param"; name: string }
  | ({ op: "define_material" } & Material)
  | { op: "delete_material"; id: string }
  | ({ op: "add_panel" } & Panel)
  | ({ op: "update_panel"; id: string } & Partial<Omit<Panel, "id">>)
  | { op: "delete_part"; id: string }
  /** Adds or replaces a straight cut along one edge of a panel. `id` is the panel and `cut` names the cut. */
  | ({ op: "set_edge_cut"; id: string; cut: string } & Omit<EdgeCut, "id" | "kind">)
  /** Adds or replaces a rectangle or circle cut right through a panel. */
  | ({ op: "set_cutout"; id: string; cut: string } & Omit<Cutout, "id" | "kind">)
  | { op: "delete_cut"; id: string; cut: string }
  | ({ op: "add_joint" } & Joint)
  | { op: "delete_joint"; id: string }
  | ({ op: "set_array" } & ArrayPattern)
  | { op: "delete_array"; id: string }
  | ({ op: "set_hardware" } & Hardware)
  | { op: "delete_hardware"; id: string }
  | ({ op: "set_rule" } & Rule)
  | { op: "delete_rule"; id: string }
  | ({ op: "add_unverified_box" } & UnverifiedBox)
  | { op: "set_plan"; plan: Plan }
  | { op: "set_plan_status"; status: Plan["status"] }
  | { op: "set_finish"; targets: string[]; finish: string | null }
  | {
      op: "set_stock";
      /** null goes back to the default. */
      kerf_mm?: number | null;
      trim_mm?: number | null;
      /** The material that sheet_mm or lengths_mm is for. */
      material?: string;
      sheet_mm?: [number, number] | null;
      lengths_mm?: number[] | null;
    }
  | { op: "rename_design"; name: string }
  | { op: "clear_design" };

export type OpName = Op["op"];

const PARAM_UNITS: ParamUnit[] = ["mm", "count", "kg", "deg", "none"];
const SEVERITIES: Severity[] = ["error", "warning"];

function need<T>(v: T | undefined | null, what: string): T {
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
    throw new OpError(`${what} is required`);
  }
  return v;
}

function checkId(id: unknown, what: string): string {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    throw new OpError(`${what} "${String(id)}" must start with a lowercase letter and use only a-z, 0-9 and _`);
  }
  return id;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], what: string): T {
  if (!allowed.includes(v as T)) {
    throw new OpError(`${what} "${String(v)}" isn't allowed. Use one of: ${allowed.join(", ")}`);
  }
  return v as T;
}

function finite(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new OpError(`${what} must be a number`);
  return v;
}

function checkExpr(src: unknown, what: string): string {
  if (typeof src !== "string" || src.trim() === "") throw new OpError(`${what} needs a number or a formula`);
  try {
    parse(src);
  } catch (e) {
    // The message names the expression too, which this one already quotes.
    const err = e as ExprError;
    const why = err.expr !== undefined && err.message.endsWith(` in "${err.expr}"`) ? err.message.slice(0, -` in "${err.expr}"`.length) : err.message;
    throw new OpError(`Couldn't read "${src}" for ${what}: ${why.charAt(0).toLowerCase()}${why.slice(1)}`);
  }
  return src;
}

/** Names an expression uses must already exist, so mistakes show at once. */
function checkRefs(d: Design, src: string, what: string, extraParts: string[] = []) {
  const params = new Set(d.params.map((p) => p.name));
  const parts = new Set([...d.parts.map((p) => p.id), ...d.unverified.map((u) => u.id), ...extraParts]);
  for (const name of refsOf(src)) {
    const dot = name.indexOf(".");
    if (dot < 0) {
      if (!params.has(name)) {
        const close = [...params].filter((p) => p.includes(name) || name.includes(p)).slice(0, 5);
        throw new OpError(
          `There's no size called "${name}" in ${what}. ${close.length ? `Did you mean ${close.join(" or ")}?` : "Pick one from Sizes, or ask Claude to add it as a parameter."}`,
        );
      }
      continue;
    }
    const { source } = partRefParts(name.slice(0, dot));
    if (!parts.has(source)) {
      throw new OpError(`There's no part called "${source}" for ${what}, which uses ${name}. Check the name, or add the part first.`);
    }
  }
}

/** A bound on an axis. A part's own faces are allowed only for its cuts, which nothing reads back. */
function checkBound(d: Design, partId: string, axis: Axis, b: unknown, what: string, ownFaces = false): Bound {
  if (typeof b !== "object" || b === null) throw new OpError(`${what} must be {"at": expr} or {"face": "part.face", "offset": expr}`);
  const o = b as Record<string, unknown>;
  if ("at" in o) {
    const at = checkExpr(o.at, what);
    checkRefs(d, at, what, [partId]);
    return { at };
  }
  if ("face" in o) {
    const face = o.face;
    if (typeof face !== "string" || !face.includes(".")) {
      throw new OpError(`${what}.face must look like "left_side.right"`);
    }
    const dot = face.lastIndexOf(".");
    const ref = face.slice(0, dot);
    const f = face.slice(dot + 1);
    oneOf(f, FACES, `${what} face`);
    if (FACE_AXIS[f as Face] !== axis) {
      const allowed = FACES.filter((x) => FACE_AXIS[x] === axis);
      throw new OpError(`${what} is on the ${axis} axis, so its face must be ${allowed.join(" or ")}, not ${f}`);
    }
    const { source } = partRefParts(ref);
    if (source === partId && !ownFaces) throw new OpError(`${what} can't refer to the part's own face`);
    if (source !== partId && !d.parts.some((p) => p.id === source) && !d.unverified.some((u) => u.id === source)) {
      throw new OpError(`There's no part called "${source}" for ${what}, which sits against ${face}. Check the name, or add the part first.`);
    }
    const out: Bound = { face };
    if (o.offset !== undefined && o.offset !== null && String(o.offset).trim() !== "") {
      const offset = checkExpr(String(o.offset), `${what} offset`);
      checkRefs(d, offset, what, [partId]);
      out.offset = offset;
    }
    return out;
  }
  throw new OpError(`${what} must have "at" or "face"`);
}

const CUT_FIELDS = {
  edge: ["id", "kind", "edge", "start", "end", "start_along", "end_along", "note"],
  rect: ["id", "kind", "shape", "x", "y", "z", "radius", "note"],
  circle: ["id", "kind", "shape", "centre", "diameter", "note"],
};

const given = (v: unknown) => v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "");

/** An expression in a cut. It may use its own part's sizes. */
function checkCutExpr(d: Design, partId: string, src: unknown, what: string): string {
  const expr = checkExpr(String(src ?? ""), what);
  checkRefs(d, expr, what, [partId]);
  return expr;
}

/** A cutout's span on one axis: two of start, end and size, like a part's own. */
function checkCutSpan(d: Design, partId: string, a: Axis, raw: unknown, what: string): AxisSpec {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new OpError(`${what} needs two of start, end and size`);
  const spec = raw as AxisSpec;
  const clean: AxisSpec = {};
  if (given(spec.start)) clean.start = checkBound(d, partId, a, spec.start, `${what}.start`, true);
  if (given(spec.end)) clean.end = checkBound(d, partId, a, spec.end, `${what}.end`, true);
  if (given(spec.size)) clean.size = checkCutExpr(d, partId, spec.size, `${what}.size`);
  const count = [clean.start, clean.end, clean.size].filter((x) => x !== undefined).length;
  if (count !== 2) throw new OpError(`${what} needs two of start, end and size, but it has ${count}. ${count > 2 ? "Clear one of them" : "Fill in one more"}.`);
  return clean;
}

/**
 * One cut on a panel, checked against the panel's axes. Every position is a
 * bound and every size an expression, held to the same rules as a part's.
 */
function checkCut(d: Design, p: Pick<Panel, "id" | "thickness_axis">, raw: unknown): PanelCut {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new OpError(`Each cut on ${p.id} must be an object`);
  const c = raw as Record<string, unknown>;
  const id = checkId(c.id, "Cut id");
  const what = `${p.id} cut ${id}`;
  const faceAxes = AXES.filter((a) => a !== p.thickness_axis);
  const only = (fields: string[], kind: string) => {
    const extra = Object.keys(c).filter((k) => !fields.includes(k) && c[k] !== undefined);
    if (extra.length) throw new OpError(`${extra.join(", ")} ${extra.length === 1 ? "isn't a field" : "aren't fields"} of ${kind}. Its fields: ${fields.filter((f) => f !== "kind" && f !== "id").join(", ")}`);
  };
  if (c.kind === "edge") {
    only(CUT_FIELDS.edge, "an edge cut");
    const edge = oneOf(c.edge, FACES, `${what} edge`);
    const axis = FACE_AXIS[edge];
    if (axis === p.thickness_axis) {
      const edges = faceAxes.flatMap((a) => AXIS_FACES[a]);
      throw new OpError(`${what} can't take wood from the ${edge} face, which is a broad face of ${p.id}. Pick one of its edges: ${edges.join(", ")}`);
    }
    const run = faceAxes.find((a) => a !== axis)!;
    if (!given(c.start) || !given(c.end)) throw new OpError(`${what} needs start and end: where its new edge sits on ${axis} at each end of its run`);
    const cut: EdgeCut = {
      id,
      kind: "edge",
      edge,
      start: checkBound(d, p.id, axis, c.start, `${what} start`, true),
      end: checkBound(d, p.id, axis, c.end, `${what} end`, true),
    };
    if (given(c.start_along)) cut.start_along = checkBound(d, p.id, run, c.start_along, `${what} start_along`, true);
    if (given(c.end_along)) cut.end_along = checkBound(d, p.id, run, c.end_along, `${what} end_along`, true);
    if (given(c.note)) cut.note = String(c.note);
    return cut;
  }
  if (c.kind !== "cutout") throw new OpError(`${what} kind must be "edge" or "cutout"`);
  const shape = oneOf(c.shape, ["rect", "circle"] as const, `${what} shape`);
  if (given(c[p.thickness_axis]) || (typeof c.centre === "object" && c.centre !== null && given((c.centre as Record<string, unknown>)[p.thickness_axis]))) {
    throw new OpError(`${what} goes right through ${p.id}, and ${p.thickness_axis} is its thickness axis. Give it only ${faceAxes.join(" and ")}`);
  }
  const cut: Cutout = { id, kind: "cutout", shape };
  if (shape === "rect") {
    only(CUT_FIELDS.rect, "a rect cutout");
    for (const a of faceAxes) cut[a] = checkCutSpan(d, p.id, a, c[a], `${what}.${a}`);
    if (given(c.radius)) cut.radius = checkCutExpr(d, p.id, c.radius, `${what} radius`);
  } else {
    only(CUT_FIELDS.circle, "a circle cutout");
    const centre = c.centre;
    if (typeof centre !== "object" || centre === null || Array.isArray(centre)) {
      throw new OpError(`${what} needs a centre, such as {"${faceAxes[0]}": {"at": "100"}, "${faceAxes[1]}": {"face": "${p.id}.${AXIS_FACES[faceAxes[1]!][0]}", "offset": "80"}}`);
    }
    const extra = Object.keys(centre).filter((k) => !faceAxes.includes(k as Axis));
    if (extra.length) throw new OpError(`${what} centre takes only ${faceAxes.join(" and ")}, not ${extra.join(", ")}`);
    cut.centre = {};
    for (const a of faceAxes) {
      const b = (centre as Record<string, unknown>)[a];
      if (!given(b)) throw new OpError(`${what} centre needs ${a}`);
      cut.centre[a] = checkBound(d, p.id, a, b, `${what} centre.${a}`, true);
    }
    if (!given(c.diameter)) throw new OpError(`${what} needs a diameter`);
    cut.diameter = checkCutExpr(d, p.id, c.diameter, `${what} diameter`);
  }
  if (given(c.note)) cut.note = String(c.note);
  return cut;
}

/** The axes a cut is drawn on, which have to be the panel's face axes. */
function cutStranded(c: PanelCut, thickness: Axis): string | null {
  if (c.kind === "edge") {
    if (FACE_AXIS[c.edge] === thickness) return `takes wood from its ${c.edge} face`;
    if (c.start_along || c.end_along) return "is placed along its old run";
    return null;
  }
  const axes = c.shape === "rect" ? AXES.filter((a) => c[a] !== undefined) : (Object.keys(c.centre ?? {}) as Axis[]);
  return axes.includes(thickness) ? `is drawn on ${axes.join(" and ")}` : null;
}

function checkPanel(d: Design, p: Panel, before?: Panel): Panel {
  checkId(p.id, "Part id");
  need(p.name, "name");
  if (!d.materials.some((m) => m.id === p.material)) {
    const known = d.materials.map((m) => m.id);
    throw new OpError(`Material "${p.material}" doesn't exist. ${known.length ? `Materials: ${known.join(", ")}` : "Define one with define_material first"}`);
  }
  const thickness_axis = oneOf(p.thickness_axis, AXES, "thickness_axis");
  const grain_axis = oneOf(p.grain_axis, AXES, "grain_axis");
  if (thickness_axis === grain_axis) throw new OpError("grain_axis must differ from thickness_axis");
  const out: Panel = { id: p.id, name: p.name, material: p.material, thickness_axis, grain_axis, x: {}, y: {}, z: {} };
  for (const a of AXES) {
    const spec = (p[a] ?? {}) as AxisSpec;
    const what = `${p.id}.${a}`;
    const clean: AxisSpec = {};
    if (spec.start !== undefined) clean.start = checkBound(d, p.id, a, spec.start, `${what}.start`);
    if (spec.end !== undefined) clean.end = checkBound(d, p.id, a, spec.end, `${what}.end`);
    if (spec.size !== undefined && String(spec.size).trim() !== "") {
      clean.size = checkExpr(String(spec.size), `${what}.size`);
      // A part may use its own thickness; a real loop is caught when it's worked out.
      checkRefs(d, clean.size, `${what}.size`, [p.id]);
    }
    const given = [clean.start, clean.end, clean.size].filter((x) => x !== undefined).length;
    if (a === thickness_axis) {
      if (clean.size !== undefined) {
        throw new OpError(`${what} is the thickness axis. Its size comes from the material, so give only start or end`);
      }
      if (given !== 1) throw new OpError(`${what} is the thickness axis, so give exactly one of start or end`);
    } else if (given !== 2) {
      throw new OpError(`${what} needs two of start, end and size, but it has ${given}. ${given > 2 ? "Clear one of them" : "Fill in one more"}.`);
    }
    out[a] = clean;
  }
  if (p.tags !== undefined) {
    if (!Array.isArray(p.tags) || p.tags.some((t) => typeof t !== "string")) throw new OpError("tags must be a list of words");
    out.tags = p.tags;
  }
  if (p.decor) out.decor = true;
  if (p.note) out.note = p.note;
  if (p.cuts !== undefined && p.cuts !== null) {
    if (!Array.isArray(p.cuts)) throw new OpError("cuts must be a list");
    if (before && before.thickness_axis !== thickness_axis) {
      for (const c of p.cuts) {
        const why = typeof c === "object" && c !== null ? cutStranded(c, thickness_axis) : null;
        if (why) {
          throw new OpError(
            `Turning ${p.id} so its thickness runs along ${thickness_axis} would strand cut ${c.id}, which ${why}. Delete the cut first, or set it again once the part is turned`,
          );
        }
      }
    }
    const cuts = p.cuts.map((c) => checkCut(d, out, c));
    const ids = cuts.map((c) => c.id);
    const twice = ids.find((id, i) => ids.indexOf(id) !== i);
    if (twice) throw new OpError(`${p.id} has two cuts called ${twice}. Give each its own id`);
    if (cuts.length) out.cuts = cuts;
  }
  return out;
}

function panelFor(d: Design, id: unknown): Panel {
  const p = d.parts.find((x) => x.id === id);
  if (p) return p;
  if (d.unverified.some((u) => u.id === id)) throw new OpError(`${String(id)} is a stand-in box, which can't be cut. Replace it with a panel first`);
  throw new OpError(`There's no panel "${String(id)}"${typeof id === "string" && id.includes("#") ? ". Name the original part: its copies repeat its cuts" : ""}`);
}

/** Every position and size a cut uses, for finding what it depends on. */
function cutRefs(c: PanelCut): { bounds: Bound[]; exprs: string[] } {
  if (c.kind === "edge") return { bounds: [c.start, c.end, c.start_along, c.end_along].filter((b): b is Bound => !!b), exprs: [] };
  const spans = AXES.map((a) => c[a]).filter((s): s is AxisSpec => !!s);
  return {
    bounds: [...spans.flatMap((s) => [s.start, s.end]), ...Object.values(c.centre ?? {})].filter((b): b is Bound => !!b),
    exprs: [...spans.map((s) => s.size), c.radius, c.diameter].filter((e): e is string => !!e),
  };
}

function usedBy(d: Design, name: string, isPart: boolean): string[] {
  const hits: string[] = [];
  const uses = (src: string | undefined) => {
    if (!src) return false;
    try {
      return refsOf(src).some((r) => (isPart ? partRefParts(r.split(".")[0]!).source === name : r === name));
    } catch {
      return false;
    }
  };
  const boundUses = (b: Bound | undefined) =>
    !!b && ("at" in b ? uses(b.at) : (isPart && partRefParts(b.face.slice(0, b.face.lastIndexOf("."))).source === name) || uses(b.offset));
  for (const p of d.params) if (uses(p.expr)) hits.push(`parameter ${p.name}`);
  for (const p of d.parts) {
    if (p.id === name) continue;
    if (AXES.some((a) => boundUses(p[a].start) || boundUses(p[a].end) || uses(p[a].size))) hits.push(`part ${p.id}`);
    for (const c of p.cuts ?? []) {
      const { bounds, exprs } = cutRefs(c);
      if (bounds.some(boundUses) || exprs.some(uses)) hits.push(`cut ${c.id} on ${p.id}`);
    }
  }
  for (const r of d.rules) if (uses(r.expr)) hits.push(`rule ${r.id}`);
  for (const a of d.arrays) if (uses(a.count) || uses(a.pitch)) hits.push(`array ${a.id}`);
  for (const j of d.joints) if (uses(j.depth) || uses(j.fit)) hits.push(`joint ${j.id}`);
  return hits;
}

function upsert<T>(list: T[], item: T, same: (x: T) => boolean): T[] {
  const i = list.findIndex(same);
  if (i < 0) return [...list, item];
  const out = [...list];
  out[i] = item;
  return out;
}

function partExists(d: Design, id: string): boolean {
  return d.parts.some((p) => p.id === id) || d.unverified.some((u) => u.id === id);
}

function checkPartRef(d: Design, ref: unknown, what: string): string {
  if (typeof ref !== "string") throw new OpError(`${what} must be a part id`);
  const { source } = partRefParts(ref);
  if (!partExists(d, source)) throw new OpError(`${what} "${ref}" isn't a part`);
  if (ref !== source) throw new OpError(`${what} must name the original part "${source}". Array copies repeat its joints automatically`);
  return ref;
}

/** Drops finishes whose target matches, so nothing points at a deleted part or material. */
function withoutFinishes(d: Design, drop: (target: string) => boolean): Design {
  if (!d.finishes) return d;
  const kept = Object.fromEntries(Object.entries(d.finishes).filter(([t]) => !drop(t)));
  const out: Design = { ...d, finishes: kept };
  if (!Object.keys(kept).length) delete out.finishes;
  return out;
}

/** Sets the stock settings, leaving out anything empty so the file stays tidy. */
function withStock(d: Design, stock: StockSettings): Design {
  const s: StockSettings = {};
  if (stock.kerf_mm !== undefined) s.kerf_mm = stock.kerf_mm;
  if (stock.trim_mm !== undefined) s.trim_mm = stock.trim_mm;
  const materials = Object.fromEntries(Object.entries(stock.materials ?? {}).filter(([, m]) => m?.sheet_mm || m?.lengths_mm));
  if (Object.keys(materials).length) s.materials = materials;
  const out: Design = { ...d, stock: s };
  if (!Object.keys(s).length) delete out.stock;
  return out;
}

/** Drops a material's stock once the material is gone or has changed kind. */
function withoutStock(d: Design, id: string): Design {
  if (!d.stock?.materials?.[id]) return d;
  const materials = Object.fromEntries(Object.entries(d.stock.materials).filter(([k]) => k !== id));
  return withStock(d, { ...d.stock, materials });
}

function checkStock(d: Design, op: Extract<Op, { op: "set_stock" }>): Design {
  if (op.material === undefined && (op.sheet_mm !== undefined || op.lengths_mm !== undefined)) {
    throw new OpError("Say which material the stock is for, with material");
  }
  if (op.kerf_mm === undefined && op.trim_mm === undefined && op.material === undefined) {
    throw new OpError("set_stock needs kerf_mm, trim_mm, or a material with sheet_mm or lengths_mm");
  }
  const next: StockSettings = { ...d.stock, materials: { ...d.stock?.materials } };
  const upTo = (v: unknown, what: string, max: number) => {
    const n = finite(v, what);
    if (n < 0 || n > max) throw new OpError(`${what} must be from 0 to ${max} mm`);
    return n;
  };
  if (op.kerf_mm === null) delete next.kerf_mm;
  else if (op.kerf_mm !== undefined) next.kerf_mm = upTo(op.kerf_mm, "kerf_mm", 20);
  if (op.trim_mm === null) delete next.trim_mm;
  else if (op.trim_mm !== undefined) next.trim_mm = upTo(op.trim_mm, "trim_mm", 100);
  if (op.material === undefined) return withStock(d, next);
  const m = d.materials.find((x) => x.id === op.material);
  if (!m) throw new OpError(`There's no material "${String(op.material)}"`);
  if (op.sheet_mm === undefined && op.lengths_mm === undefined) throw new OpError(`Give sheet_mm or lengths_mm for ${m.id}, or null for the default`);
  if (m.kind === "sheet" && op.lengths_mm !== undefined) throw new OpError(`${m.id} is sheet goods, so give sheet_mm as [length along the grain, width]`);
  if (m.kind === "solid" && op.sheet_mm !== undefined) throw new OpError(`${m.id} is solid timber, so give lengths_mm, such as [2400, 3000, 3600]`);
  let own: MaterialStock | null = null;
  if (op.sheet_mm !== undefined && op.sheet_mm !== null) {
    const s = op.sheet_mm;
    if (!Array.isArray(s) || s.length !== 2) throw new OpError("sheet_mm must be [length along the grain, width] in mm");
    const sheet: [number, number] = [finite(s[0], "sheet length"), finite(s[1], "sheet width")];
    const trim = next.trim_mm ?? DEFAULT_TRIM_MM;
    if (sheet.some((v) => v <= 2 * trim || v > 10000)) {
      throw new OpError(`Each side of sheet_mm must be more than twice the ${trim} mm trim, and at most 10000 mm`);
    }
    own = { sheet_mm: sheet };
  }
  if (op.lengths_mm !== undefined && op.lengths_mm !== null) {
    const ls = op.lengths_mm;
    if (!Array.isArray(ls) || ls.length === 0 || ls.length > 20) throw new OpError("lengths_mm must list 1 to 20 lengths in mm, such as [2400, 3000, 3600]");
    const lengths = ls.map((v) => finite(v, "Each length"));
    if (lengths.some((v) => v <= 0 || v > 12000)) throw new OpError("Each length must be above 0 and at most 12000 mm");
    own = { lengths_mm: [...new Set(lengths)].sort((a, b) => a - b) };
  }
  if (own) next.materials![m.id] = own;
  else delete next.materials![m.id];
  return withStock(d, next);
}

export function applyOp(d: Design, op: Op): Design {
  switch (op.op) {
    case "set_param": {
      const name = checkId(op.name, "Parameter name");
      const expr = checkExpr(String(op.expr), `parameter ${name}`);
      checkRefs(d, expr, `parameter ${name}`);
      const unit = oneOf(op.unit ?? "mm", PARAM_UNITS, "unit");
      const p: Param = { name, expr, unit };
      if (op.min !== undefined) p.min = finite(op.min, "min");
      if (op.max !== undefined) p.max = finite(op.max, "max");
      if (op.step !== undefined) p.step = finite(op.step, "step");
      if (op.note) p.note = op.note;
      const existing = d.params.find((x) => x.name === name);
      if (existing && op.min === undefined && existing.min !== undefined) p.min = existing.min;
      if (existing && op.max === undefined && existing.max !== undefined) p.max = existing.max;
      if (existing && op.step === undefined && existing.step !== undefined) p.step = existing.step;
      if (existing && !op.note && existing.note) p.note = existing.note;
      return { ...d, params: upsert(d.params, p, (x) => x.name === name) };
    }
    case "delete_param": {
      if (!d.params.some((p) => p.name === op.name)) throw new OpError(`There's no parameter "${op.name}"`);
      const users = usedBy(d, op.name, false);
      if (users.length) throw new OpError(`Parameter ${op.name} is still used by ${users.join(", ")}`);
      return { ...d, params: d.params.filter((p) => p.name !== op.name) };
    }
    case "define_material": {
      const id = checkId(op.id, "Material id");
      const m: Material = {
        id,
        name: need(op.name, "name"),
        kind: oneOf(op.kind, ["sheet", "solid"] as const, "kind"),
        thickness_mm: finite(op.thickness_mm, "thickness_mm"),
        grained: !!op.grained,
      };
      if (m.thickness_mm <= 0) throw new OpError("thickness_mm must be above 0");
      if (op.nominal_thickness_mm !== undefined) m.nominal_thickness_mm = finite(op.nominal_thickness_mm, "nominal_thickness_mm");
      if (op.sheet_sizes_mm !== undefined) {
        if (!Array.isArray(op.sheet_sizes_mm) || op.sheet_sizes_mm.some((s) => !Array.isArray(s) || s.length !== 2)) {
          throw new OpError("sheet_sizes_mm must be a list of [length, width] pairs");
        }
        m.sheet_sizes_mm = op.sheet_sizes_mm.map(([l, w]) => [finite(l, "sheet length"), finite(w, "sheet width")]);
      }
      if (op.board_max_length_mm !== undefined) m.board_max_length_mm = finite(op.board_max_length_mm, "board_max_length_mm");
      if (op.board_max_width_mm !== undefined) m.board_max_width_mm = finite(op.board_max_width_mm, "board_max_width_mm");
      if (op.species !== undefined && op.species !== null && op.species !== "") {
        const species = String(op.species);
        if (!SPECIES[species]) throw new OpError(`Species "${species}" isn't known. Use one of: ${SPECIES_IDS.join(", ")}`);
        m.species = species;
      } else if (op.species === undefined) {
        // Redefining a material keeps its species unless told otherwise.
        const old = d.materials.find((x) => x.id === id)?.species;
        if (old) m.species = old;
      }
      if (op.note) m.note = op.note;
      const next = { ...d, materials: upsert(d.materials, m, (x) => x.id === id) };
      // Sheet sizes don't apply to solid timber, nor lengths to sheets.
      return d.materials.some((x) => x.id === id && x.kind !== m.kind) ? withoutStock(next, id) : next;
    }
    case "delete_material": {
      const users = d.parts.filter((p) => p.material === op.id).map((p) => p.id);
      if (users.length) throw new OpError(`Material ${op.id} is still used by ${users.join(", ")}`);
      return withoutStock(
        withoutFinishes({ ...d, materials: d.materials.filter((m) => m.id !== op.id) }, (t) => t === `material:${op.id}`),
        op.id,
      );
    }
    case "add_panel": {
      const { op: _op, ...rest } = op;
      if (partExists(d, rest.id)) throw new OpError(`Part "${rest.id}" already exists. Use update_panel to change it`);
      const p = checkPanel(d, rest as Panel);
      return { ...d, parts: [...d.parts, p] };
    }
    case "update_panel": {
      const cur = d.parts.find((p) => p.id === op.id);
      if (!cur) throw new OpError(`There's no panel "${op.id}"`);
      const { op: _op, ...patch } = op;
      const merged = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as Panel;
      const p = checkPanel(d, merged, cur);
      return { ...d, parts: d.parts.map((x) => (x.id === op.id ? p : x)) };
    }
    case "set_edge_cut":
    case "set_cutout": {
      const panel = panelFor(d, op.id);
      const kind = op.op === "set_edge_cut" ? "edge" : "cutout";
      const { op: _op, id: _id, cut: cutId, ...fields } = op as Record<string, unknown>;
      const cut = checkCut(d, panel, { ...fields, id: cutId, kind });
      const old = panel.cuts?.find((c) => c.id === cut.id);
      if (old && old.kind !== cut.kind) {
        const [name, tool] = old.kind === "edge" ? ["an edge cut", "set_edge_cut"] : ["a cutout", "set_cutout"];
        throw new OpError(`${panel.id} already has ${name} called ${cut.id}. Change it with ${tool}, or delete_cut it first`);
      }
      const next = checkPanel(d, { ...panel, cuts: upsert(panel.cuts ?? [], cut, (c) => c.id === cut.id) });
      return { ...d, parts: d.parts.map((x) => (x.id === panel.id ? next : x)) };
    }
    case "delete_cut": {
      const panel = panelFor(d, op.id);
      if (!panel.cuts?.some((c) => c.id === op.cut)) {
        const ids = (panel.cuts ?? []).map((c) => c.id);
        throw new OpError(`${panel.id} has no cut "${String(op.cut)}". ${ids.length ? `Its cuts: ${ids.join(", ")}` : "It has no cuts"}`);
      }
      const next: Panel = { ...panel, cuts: panel.cuts.filter((c) => c.id !== op.cut) };
      if (!next.cuts!.length) delete next.cuts;
      return { ...d, parts: d.parts.map((x) => (x.id === panel.id ? next : x)) };
    }
    case "delete_part": {
      if (!partExists(d, op.id)) throw new OpError(`There's no part "${op.id}"`);
      const users = usedBy(d, op.id, true);
      if (users.length) throw new OpError(`${op.id} is still used by ${users.join(", ")}. Change those first`);
      return withoutFinishes({
        ...d,
        parts: d.parts.filter((p) => p.id !== op.id),
        unverified: d.unverified.filter((u) => u.id !== op.id),
        joints: d.joints.filter((j) => j.host !== op.id && j.guest !== op.id),
        arrays: d.arrays
          .map((a) => ({ ...a, parts: a.parts.filter((p) => p !== op.id) }))
          .filter((a) => a.parts.length > 0),
        hardware: d.hardware
          .map((h) => ({ ...h, connects: h.connects.filter((c) => c !== op.id) }))
          .filter((h) => h.connects.length > 0),
      }, (t) => {
        const target = parseFinishTarget(t);
        return !!target && target.kind !== "material" && partRefParts(target.part).source === op.id;
      });
    }
    case "add_joint": {
      const id = checkId(op.id, "Joint id");
      if (d.joints.some((j) => j.id === id)) throw new OpError(`Joint "${id}" already exists`);
      const type = oneOf(op.type, JOINT_TYPES, "Joint type");
      const host = checkPartRef(d, op.host, "host");
      const guest = checkPartRef(d, op.guest, "guest");
      if (host === guest) throw new OpError("host and guest must be different parts");
      const j: Joint = { id, type, host, guest };
      // Sizes are optional: the joint library fills in usual proportions.
      for (const f of ["depth", "fit", "thickness", "shoulder", "diameter", "length", "finger"] as const) {
        const v = op[f];
        if (v === undefined || v === null || String(v).trim() === "") continue;
        j[f] = checkExpr(String(v), `the ${f} of joint ${id}`);
        checkRefs(d, j[f]!, `the ${f} of joint ${id}`);
      }
      if (op.count !== undefined) {
        const count = finite(op.count, "count");
        if (!Number.isInteger(count) || count < 1) throw new OpError("count must be a whole number of 1 or more");
        j.count = count;
      }
      const family = JOINT_FAMILY[type];
      const misplaced = (["thickness", "shoulder"] as const).filter((f) => j[f] !== undefined && family !== "inset");
      if (misplaced.length) throw new OpError(`${misplaced.join(" and ")} only apply to tongue and mortise_tenon joints`);
      if (j.finger !== undefined && type !== "box_joint") throw new OpError("finger only applies to box_joint");
      if (op.note) j.note = op.note;
      return { ...d, joints: [...d.joints, j] };
    }
    case "delete_joint": {
      if (!d.joints.some((j) => j.id === op.id)) throw new OpError(`There's no joint "${op.id}"`);
      return { ...d, joints: d.joints.filter((j) => j.id !== op.id) };
    }
    case "set_array": {
      const id = checkId(op.id, "Array id");
      if (!Array.isArray(op.parts) || op.parts.length === 0) throw new OpError("parts must list at least one part");
      for (const p of op.parts) {
        if (!d.parts.some((x) => x.id === p)) throw new OpError(`Array part "${p}" isn't a panel`);
        const other = d.arrays.find((a) => a.id !== id && a.parts.includes(p));
        if (other) throw new OpError(`${p} is already in array ${other.id}. A part can be in one array`);
      }
      const a: ArrayPattern = {
        id,
        parts: op.parts,
        axis: oneOf(op.axis, AXES, "axis"),
        count: checkExpr(String(op.count), `the count of array ${id}`),
        pitch: checkExpr(String(op.pitch), `the pitch of array ${id}`),
      };
      checkRefs(d, a.count, `the count of array ${id}`);
      checkRefs(d, a.pitch, `the pitch of array ${id}`);
      return { ...d, arrays: upsert(d.arrays, a, (x) => x.id === id) };
    }
    case "delete_array": {
      if (!d.arrays.some((a) => a.id === op.id)) throw new OpError(`There's no array "${op.id}"`);
      return { ...d, arrays: d.arrays.filter((a) => a.id !== op.id) };
    }
    case "set_hardware": {
      const id = checkId(op.id, "Hardware id");
      if (!Array.isArray(op.connects) || op.connects.length === 0) throw new OpError("connects must list the parts it joins");
      const connects = op.connects.map((c) => checkPartRef(d, c, "connects"));
      const qty = op.qty === undefined ? 1 : finite(op.qty, "qty");
      const h: Hardware = { id, kind: need(op.kind, "kind"), name: need(op.name, "name"), connects, qty };
      if (op.spec) {
        if (typeof op.spec !== "object") throw new OpError("spec must be an object of numbers and words");
        h.spec = op.spec;
      }
      if (op.library_part) h.library_part = String(op.library_part);
      if (op.shape !== undefined) {
        try {
          h.shape = validateLibraryPart({ id: "check", name: "check", kind: "other", sources: [{ note: "check" }], specs: {}, shape: op.shape }).shape;
        } catch (e) {
          throw new OpError((e as Error).message);
        }
      }
      if (op.place !== undefined) {
        if (!h.shape) throw new OpError("place needs a model: give library_part or shape");
        const pl = op.place as Record<string, unknown>;
        const place: NonNullable<Hardware["place"]> = { x: "", y: "", z: "" };
        for (const a of AXES) {
          place[a] = checkExpr(String(pl[a] ?? ""), `place.${a} of ${id}`);
          checkRefs(d, place[a], `place.${a} of ${id}`);
        }
        if (pl.length_axis !== undefined) place.length_axis = oneOf(pl.length_axis, AXES, "place.length_axis");
        h.place = place;
      }
      if (op.on_floor) h.on_floor = true;
      if (op.note) h.note = op.note;
      return { ...d, hardware: upsert(d.hardware, h, (x) => x.id === id) };
    }
    case "delete_hardware": {
      if (!d.hardware.some((h) => h.id === op.id)) throw new OpError(`There's no hardware "${op.id}"`);
      return { ...d, hardware: d.hardware.filter((h) => h.id !== op.id) };
    }
    case "set_rule": {
      const id = checkId(op.id, "Rule id");
      const expr = checkExpr(op.expr, `rule ${id}`);
      checkRefs(d, expr, `rule ${id}`);
      const r: Rule = { id, expr, severity: oneOf(op.severity ?? "error", SEVERITIES, "severity"), message: need(op.message, "message") };
      return { ...d, rules: upsert(d.rules, r, (x) => x.id === id) };
    }
    case "delete_rule": {
      if (!d.rules.some((r) => r.id === op.id)) throw new OpError(`There's no rule "${op.id}"`);
      return { ...d, rules: d.rules.filter((r) => r.id !== op.id) };
    }
    case "add_unverified_box": {
      const id = checkId(op.id, "Part id");
      if (partExists(d, id)) throw new OpError(`Part "${id}" already exists`);
      const min = op.min_mm?.map((v) => finite(v, "min_mm")) as [number, number, number];
      const max = op.max_mm?.map((v) => finite(v, "max_mm")) as [number, number, number];
      if (min?.length !== 3 || max?.length !== 3) throw new OpError("min_mm and max_mm must each be [x, y, z]");
      if (min.some((v, i) => v >= max[i]!)) throw new OpError("Each min_mm value must be below its max_mm value");
      const u: UnverifiedBox = { id, name: need(op.name, "name"), min_mm: min, max_mm: max, reason: need(op.reason, "reason") };
      if (op.request_id) u.request_id = op.request_id;
      return { ...d, unverified: [...d.unverified, u] };
    }
    case "set_plan": {
      const p = op.plan;
      need(p?.summary, "plan.summary");
      for (const dim of p.key_dims ?? []) {
        checkExpr(dim.expr, `plan dimension "${dim.label}"`);
        finite(dim.expected_mm, `plan dimension "${dim.label}" expected_mm`);
      }
      return {
        ...d,
        plan: {
          status: "proposed",
          summary: p.summary,
          parts: p.parts ?? [],
          key_dims: p.key_dims ?? [],
          joints: p.joints ?? [],
          assumptions: p.assumptions ?? [],
        },
      };
    }
    case "set_plan_status": {
      if (!d.plan) throw new OpError("There's no plan yet");
      return { ...d, plan: { ...d.plan, status: oneOf(op.status, ["proposed", "approved", "changes_requested"] as const, "status") } };
    }
    case "set_finish": {
      if (!Array.isArray(op.targets) || op.targets.length === 0) {
        throw new OpError('targets must list what to finish: "material:<id>", "<part>" or "<part>.<face>"');
      }
      let finish: string | null = null;
      if (op.finish !== null && op.finish !== undefined && String(op.finish).trim() !== "") {
        finish = normaliseFinish(String(op.finish));
        if (!finish) {
          const cards = PALETTES.map((p) => `"${p.id}/<colour>" from the ${p.maker} ${p.name} card`).join(" or ");
          throw new OpError(`Finish "${String(op.finish)}" isn't known. Use "raw", or ${cards}, with a colour name or number`);
        }
      }
      const next = { ...(d.finishes ?? {}) };
      // A colour on a material or a whole piece covers everything in it, so
      // colours set inside it give way. Set the broad colour first, then any
      // exceptions.
      if (finish) {
        for (const raw of op.targets) for (const key of finishesInside(d, String(raw))) delete next[key];
      }
      for (const raw of op.targets) {
        const t = parseFinishTarget(String(raw));
        if (!t) throw new OpError(`Target "${String(raw)}" must be "material:<id>", "<part>" or "<part>.<face>", with a face of ${FACES.join(", ")}`);
        if (t.kind === "material" && !d.materials.some((m) => m.id === t.material)) throw new OpError(`There's no material "${t.material}"`);
        if (t.kind !== "material") {
          const { source } = partRefParts(t.part);
          if (!partExists(d, source)) throw new OpError(`There's no part "${source}"`);
        }
        if (finish) next[String(raw)] = finish;
        else delete next[String(raw)];
      }
      const out: Design = { ...d, finishes: next };
      if (!Object.keys(next).length) delete out.finishes;
      return out;
    }
    case "set_stock":
      return checkStock(d, op);
    case "rename_design":
      return { ...d, name: need(op.name, "name") };
    case "clear_design":
      return { ...emptyDesign(d.name) };
    default: {
      const unknown = (op as { op: string }).op;
      throw new OpError(`Unknown operation "${unknown}"`);
    }
  }
}

/** Applies operations in order. Nothing changes unless all of them succeed. */
export function applyOps(d: Design, ops: Op[]): Design {
  let cur = d;
  ops.forEach((op, i) => {
    try {
      cur = applyOp(cur, op);
    } catch (e) {
      if (e instanceof OpError && ops.length > 1) throw new OpError(`Operation ${i + 1} (${op.op}): ${e.message}`);
      throw e;
    }
  });
  return cur;
}
