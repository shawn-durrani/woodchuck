// Read-only questions about a design: explain a number, measure between
// faces, describe a part, and check the model against its plan.

import { AXIS_INDEX, partRefParts, type DeriveResult, type DerivedPart } from "./derive.js";
import { fmt } from "./expr.js";
import { machiningText } from "./cutlist.js";
import { JOINT_LIBRARY, type JointParam } from "./joints.js";
import { AXES, FACE_AXIS, FACES, type Axis, type Design, type Face, type PlanDim } from "./types.js";

export class QueryError extends Error {}

function part(d: DeriveResult, id: string): DerivedPart {
  const p = d.byId.get(id);
  if (!p) {
    const known = d.parts.slice(0, 40).map((x) => x.id).join(", ");
    throw new QueryError(`There's no part "${id}". Parts: ${known || "none yet"}`);
  }
  return p;
}

/** The face axis that isn't `a`: the one an end of the part runs along. */
function otherFaceAxis(p: DerivedPart, a: Axis): Axis | null {
  return AXES.find((x) => x !== a && x !== p.thickness_axis) ?? null;
}

function axisName(p: DerivedPart, a: Axis): string {
  if (a === p.grain_axis) return "length";
  if (a === p.thickness_axis) return "thickness";
  return "width";
}

/** Plain-language working for one part's sizes, including joinery. */
export function explainPart(d: DeriveResult, id: string): string[] {
  const p = part(d, id);
  const lines: string[] = [];
  for (const a of AXES) {
    const t = p.axes[a];
    lines.push(`${a} (${axisName(p, a)}): from ${fmt(t.start.value)} to ${fmt(t.end.value)}, so ${fmt(t.size.value)} mm`);
    lines.push(`  start = ${t.start.text}`);
    lines.push(`  end = ${t.end.text}`);
    lines.push(`  size = ${t.size.text}`);
  }
  for (const a of AXES) {
    const ext = p.extensions.filter((e) => e.axis === a);
    if (!ext.length) continue;
    const nominal = p.axes[a].size.value;
    const extra = ext.map((e) => `${fmt(e.depth_mm)} into ${e.host} (${e.joint})`).join(" + ");
    const total = nominal + ext.reduce((s, e) => s + e.depth_mm, 0);
    lines.push(`Cut ${axisName(p, a)} ${fmt(total)} = visible ${fmt(nominal)} + ${extra}`);
  }
  for (const m of p.machining) lines.push(machiningText(m));
  for (const c of p.profile?.cuts ?? []) {
    lines.push(`Cut ${c.id}: ${c.text}`);
    lines.push(`  ${c.trace}`);
  }
  // A housing goes into its host only where no cut has touched the end.
  for (const e of p.profile?.extensions ?? []) {
    const end = otherFaceAxis(p, FACE_AXIS[e.face]);
    if (!end) continue;
    const whole = p.nominal.max[AXIS_INDEX[end]]! - p.nominal.min[AXIS_INDEX[end]]!;
    const covered = e.along_mm.reduce((s, [a, b]) => s + b - a, 0);
    if (covered >= whole - 0.01) continue;
    const spans = e.along_mm.map(([a, b]) => `${fmt(a)} to ${fmt(b)}`).join(" and ");
    lines.push(
      e.along_mm.length
        ? `Joint ${e.joint} takes the ${e.face} end only from ${spans} along ${end}, where no cut has touched it`
        : `Cuts took the whole ${e.face} end, so joint ${e.joint} has nothing to go into its host`,
    );
  }
  for (const j of d.joints.filter((x) => x.host === p.id || x.guest === p.id)) {
    const entry = JOINT_LIBRARY[j.type];
    const ps = Object.entries(j.params)
      .map(([k, v]) => `${k} ${fmt(v)}${j.defaulted.includes(k as JointParam) ? " (library default)" : ""}`)
      .join(", ");
    lines.push(`Joint ${j.id}: ${entry.name}, ${j.guest} into ${j.host}${ps ? `. ${ps}` : ""}`);
  }
  return lines;
}

export function explain(design: Design, d: DeriveResult, target: string): string[] {
  const t = target.trim();
  const param = design.params.find((p) => p.name === t);
  if (param) {
    const v = d.params[t];
    if (!v) return [`${t} hasn't been worked out`];
    return "error" in v ? [`${t} can't be worked out: ${v.error}`] : [`${t} = ${param.expr}`, `  = ${v.text}`, `  = ${fmt(v.value)}`];
  }
  const rule = design.rules.find((r) => r.id === t);
  if (rule) {
    try {
      const r = d.evaluate(rule.expr);
      return [`${rule.id}: ${rule.expr}`, `  = ${r.text}`, `  → ${r.value ? "passes" : "fails"}`];
    } catch (e) {
      return [`${rule.id} can't be worked out: ${(e as Error).message}`];
    }
  }
  if (d.byId.has(t)) return explainPart(d, t);
  // Any other expression, such as "right_side.left - left_side.right".
  try {
    const r = d.evaluate(t);
    return [`${t}`, `  = ${r.text}`, `  = ${typeof r.value === "number" ? fmt(r.value) : r.value}`];
  } catch (e) {
    throw new QueryError(`Can't explain "${t}": ${(e as Error).message}`);
  }
}

/** The distance between two faces on the same axis. */
export function measure(d: DeriveResult, a: string, b: string): { mm: number; text: string } {
  const parseFace = (s: string): { id: string; face: Face } => {
    const dot = s.lastIndexOf(".");
    const id = s.slice(0, dot);
    const face = s.slice(dot + 1) as Face;
    if (dot < 0 || !(FACES as readonly string[]).includes(face)) {
      throw new QueryError(`"${s}" isn't a face. Write it as part.face, with a face from ${FACES.join(", ")}`);
    }
    part(d, id);
    return { id, face };
  };
  const fa = parseFace(a);
  const fb = parseFace(b);
  if (FACE_AXIS[fa.face] !== FACE_AXIS[fb.face]) {
    throw new QueryError(`${a} is on the ${FACE_AXIS[fa.face]} axis and ${b} is on ${FACE_AXIS[fb.face]}. Measure between faces on the same axis`);
  }
  const i = AXIS_INDEX[FACE_AXIS[fa.face]];
  const at = (f: { id: string; face: Face }) => {
    const p = part(d, f.id);
    return f.face === "right" || f.face === "top" || f.face === "front" ? p.nominal.max[i]! : p.nominal.min[i]!;
  };
  const va = at(fa);
  const vb = at(fb);
  return { mm: Math.abs(vb - va), text: `${b} (${fmt(vb)}) - ${a} (${fmt(va)}) = ${fmt(vb - va)}` };
}

export interface PartSummary {
  id: string;
  name: string;
  material: string;
  tags: string[];
  finished_mm: { length: number; width: number; thickness: number };
  cut_mm: { length: number; width: number; thickness: number };
  position_mm: { min: number[]; max: number[] };
  /** What its cuts do to its blank, when it has any that take wood. */
  shape?: string[];
  decor?: boolean;
  unverified?: boolean;
}

export function summarisePart(p: DerivedPart): PartSummary {
  const r = (n: number) => Math.round(n * 10) / 10;
  const dims = (x: { length: number; width: number; thickness: number }) => ({
    length: r(x.length),
    width: r(x.width),
    thickness: r(x.thickness),
  });
  const s: PartSummary = {
    id: p.id,
    name: p.name,
    material: p.material,
    tags: p.tags,
    finished_mm: dims(p.finished),
    cut_mm: dims(p.cut),
    position_mm: { min: p.nominal.min.map(r), max: p.nominal.max.map(r) },
  };
  if (p.profile) s.shape = p.profile.cuts.map((c) => c.text);
  if (p.decor) s.decor = true;
  if (p.unverified) s.unverified = true;
  return s;
}

export interface PlanCheck {
  item: string;
  ok: boolean;
  detail: string;
}

/** One of a plan's key sizes, worked out on the model. */
export interface KeySizeCheck {
  label: string;
  expr: string;
  expected_mm: number;
  /** The plan's own tolerance, or 0.5 mm. */
  tolerance_mm: number;
  ok: boolean;
  /** What the model gives, when the expression works out to a size. */
  model_mm?: number;
  /** The expression with each name's value, such as "right.left (582) - left.right (18)". */
  working?: string;
  /** Why there's no size, such as "can't work out top.bottom: Unknown part". */
  error?: string;
}

/**
 * Works out each key size on the model and holds it to its expected value.
 * submit_plan refuses a plan when one fails, and verify_against_plan
 * reports them.
 */
export function checkKeySizes(dims: readonly PlanDim[], d: DeriveResult): KeySizeCheck[] {
  return dims.map((dim) => {
    const base = { label: dim.label, expr: dim.expr, expected_mm: dim.expected_mm, tolerance_mm: dim.tolerance_mm ?? 0.5 };
    try {
      const r = d.evaluate(dim.expr);
      if (typeof r.value !== "number") return { ...base, ok: false, error: `${dim.expr} gives true/false, not a size` };
      return { ...base, ok: Math.abs(r.value - dim.expected_mm) <= base.tolerance_mm, model_mm: r.value, working: r.text };
    } catch (e) {
      return { ...base, ok: false, error: `can't work out ${dim.expr}: ${(e as Error).message}` };
    }
  });
}

export function verifyPlan(design: Design, d: DeriveResult): PlanCheck[] {
  const plan = design.plan;
  if (!plan) throw new QueryError("There's no plan to check against. Submit one with submit_plan");
  const out: PlanCheck[] = [];
  for (const pp of plan.parts) {
    const found = d.parts.filter((p) => p.tags.includes(pp.tag) && !p.decor);
    out.push({
      item: `${pp.label} (tag ${pp.tag})`,
      ok: found.length === pp.qty,
      detail: `planned ${pp.qty}, model has ${found.length}${found.length ? `: ${found.map((p) => p.id).slice(0, 12).join(", ")}` : ""}`,
    });
  }
  for (const k of checkKeySizes(plan.key_dims, d)) {
    out.push({
      item: k.label,
      ok: k.ok,
      detail: k.error ?? `planned ${fmt(k.expected_mm)} ± ${fmt(k.tolerance_mm)}, model ${fmt(k.model_mm!)} (${k.working})`,
    });
  }
  return out;
}

export { partRefParts };
