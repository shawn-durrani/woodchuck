// What changed between two versions of a design, in plain words: one line
// per parameter, material, part, joint, rule or stock setting that was
// added, removed or changed. Claude reads it with ids, and people read it
// with names: a size by its note and a part by its name.

import { fmt, literalValue } from "./expr.js";
import { finishLabel, parseFinishTarget } from "./finishes.js";
import { DEFAULT_KERF_MM, DEFAULT_TRIM_MM } from "./layout.js";
import type { Design, Panel, Param } from "./types.js";

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A size's name for people: its note, or else its id in words. */
export function paramLabel(p: Pick<Param, "name" | "note">): string {
  return capital(p.note?.trim() || p.name.replace(/_/g, " "));
}

/** A size's name in a few words: its note up to the first aside, such as "Slat thickness" from "slat thickness (matches 19 mm material)". */
export function paramShortLabel(p: Pick<Param, "name" | "note">): string {
  const full = paramLabel(p);
  return full.split(/ \(|, /)[0]!.trim() || full;
}

function byKey<T extends object>(list: T[], key: keyof T): Map<string, T> {
  return new Map(list.map((x) => [String(x[key]), x]));
}

/** Names of the fields that differ between two versions of one item. */
function changedFields(a: object, b: object): string[] {
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  return [...keys].filter((k) => JSON.stringify(ra[k]) !== JSON.stringify(rb[k])).sort();
}

function section<T extends object>(
  out: string[],
  what: string,
  before: T[],
  after: T[],
  key: keyof T,
  describe: (x: T) => string,
  change?: (a: T, b: T) => string | string[] | null,
) {
  const a = byKey(before, key);
  const b = byKey(after, key);
  for (const [k, x] of b) if (!a.has(k)) out.push(`Added ${what} ${describe(x)}`);
  for (const [k, x] of a) if (!b.has(k)) out.push(`Removed ${what} ${describe(x)}`);
  for (const [k, x] of b) {
    const old = a.get(k);
    if (!old || JSON.stringify(old) === JSON.stringify(x)) continue;
    const lines = change?.(old, x) ?? `Changed ${what} ${k}: ${changedFields(old, x).join(", ")}`;
    out.push(...(Array.isArray(lines) ? lines : [lines]));
  }
}

const andList = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/**
 * What changed, a line each. Lines name things by id, as Claude reads them.
 * With names, they name sizes by their notes and parts by their names, for
 * people to read.
 */
export function diffDesigns(before: Design, after: Design, opts: { names?: boolean } = {}): string[] {
  if (opts.names) return namedDiff(before, after);
  const out: string[] = [];
  if (before.name !== after.name) out.push(`Renamed "${before.name}" to "${after.name}"`);
  section(out, "parameter", before.params, after.params, "name", (p) => `${p.name} = ${p.expr}`, (a, b) =>
    a.expr !== b.expr ? `Changed ${b.name} from ${a.expr} to ${b.expr}` : `Changed parameter ${b.name}: ${changedFields(a, b).join(", ")}`,
  );
  section(out, "material", before.materials, after.materials, "id", (m) => `${m.id} (${m.thickness_mm} mm ${m.name})`, (a, b) =>
    a.thickness_mm !== b.thickness_mm
      ? `Changed material ${b.id} from ${a.thickness_mm} to ${b.thickness_mm} mm thick`
      : `Changed material ${b.id}: ${changedFields(a, b).join(", ")}`,
  );
  section(out, "part", before.parts, after.parts, "id", (p) => `${p.id} (${p.name})`, partChange);
  section(out, "box", before.unverified, after.unverified, "id", (u) => `${u.id} (${u.name}, unverified)`);
  section(out, "joint", before.joints, after.joints, "id", (j) => `${j.id} (${j.type.replace(/_/g, " ")}, ${j.guest} into ${j.host})`);
  section(out, "array", before.arrays, after.arrays, "id", (a) => `${a.id} (${a.count} of ${a.parts.join(", ")})`, (a, b) =>
    a.count !== b.count ? `Changed array ${b.id} from ${a.count} to ${b.count}` : `Changed array ${b.id}: ${changedFields(a, b).join(", ")}`,
  );
  section(out, "hardware", before.hardware, after.hardware, "id", (h) => `${h.id} (${h.name})`);
  section(out, "rule", before.rules, after.rules, "id", (r) => `${r.id} (${r.expr})`);
  finishesAndStock(out, before, after, (t) => t, (id) => id);
  return out;
}

/** A part's changed fields on one line, and a line for each cut added, removed or changed. */
function partChange(a: Panel, b: Panel): string[] {
  const fields = changedFields(a, b).filter((f) => f !== "cuts");
  const out = fields.length ? [`Changed part ${b.id}: ${fields.join(", ")}`] : [];
  const kind = (c: { kind: string }) => (c.kind === "edge" ? "edge cut" : "cutout");
  section(out, "cut", a.cuts ?? [], b.cuts ?? [], "id", (c) => `${c.id} (${kind(c)}) on ${b.id}`, (x, y) => `Changed cut ${y.id} on ${b.id}: ${changedFields(x, y).join(", ")}`);
  if (!out.length) out.push(`Changed the order of the cuts on ${b.id}`);
  return out;
}

/** Finishes, stock and the plan, which both kinds of line share. */
function finishesAndStock(out: string[], before: Design, after: Design, target: (t: string) => string, material: (id: string) => string) {
  // Finishes, one line per colour, naming at most three targets.
  const fa = before.finishes ?? {};
  const fb = after.finishes ?? {};
  const byColour = new Map<string, string[]>();
  for (const t of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
    if (fa[t] === fb[t]) continue;
    const k = fb[t] ?? "";
    byColour.set(k, [...(byColour.get(k) ?? []), target(t)]);
  }
  const names = (ts: string[]) => (ts.length <= 3 ? ts.join(", ") : `${ts.slice(0, 2).join(", ")} and ${ts.length - 2} more`);
  for (const [colour, ts] of byColour) out.push(colour ? `Finished ${names(ts)} with ${finishLabel(colour)}` : `Took the finish off ${names(ts)}`);
  // Stock for the cutting layouts, a line per setting that changed.
  const sa = before.stock ?? {};
  const sb = after.stock ?? {};
  const kerf = [sa.kerf_mm ?? DEFAULT_KERF_MM, sb.kerf_mm ?? DEFAULT_KERF_MM];
  if (kerf[0] !== kerf[1]) out.push(`Changed the saw kerf from ${fmt(kerf[0]!)} to ${fmt(kerf[1]!)} mm`);
  const trim = [sa.trim_mm ?? DEFAULT_TRIM_MM, sb.trim_mm ?? DEFAULT_TRIM_MM];
  if (trim[0] !== trim[1]) out.push(`Changed the sheet trim from ${fmt(trim[0]!)} to ${fmt(trim[1]!)} mm`);
  const kept = new Set(after.materials.map((m) => m.id));
  for (const id of [...new Set([...Object.keys(sa.materials ?? {}), ...Object.keys(sb.materials ?? {})])].sort()) {
    const a = sa.materials?.[id];
    const b = sb.materials?.[id];
    if (!kept.has(id) || JSON.stringify(a) === JSON.stringify(b)) continue;
    const same = (k: "sheet_mm" | "lengths_mm" | "widths_mm" | "owned") => JSON.stringify(a?.[k]) === JSON.stringify(b?.[k]);
    const sizes = !same("sheet_mm") || !same("lengths_mm");
    if (sizes && b?.sheet_mm) out.push(`Changed stock for ${material(id)} to ${fmt(b.sheet_mm[0])} × ${fmt(b.sheet_mm[1])} mm sheets`);
    else if (sizes && b?.lengths_mm) out.push(`Changed stock for ${material(id)} to ${andList(b.lengths_mm.map(fmt))} mm lengths`);
    else if (sizes) out.push(`Changed stock for ${material(id)} back to the default`);
    if (!same("widths_mm")) out.push(b?.widths_mm ? `Changed the board widths for ${material(id)} to ${andList(b.widths_mm.map(fmt))} mm` : `Took the board widths off ${material(id)}`);
    if (!same("owned")) {
      const n = (b?.owned ?? []).reduce((t, o) => t + o.qty, 0);
      out.push(n ? `Set your own stock of ${material(id)} to ${n} ${n === 1 ? "piece" : "pieces"}` : `Cleared your own stock of ${material(id)}`);
    }
  }
  if (JSON.stringify(before.plan) !== JSON.stringify(after.plan)) {
    if (!before.plan && after.plan) out.push("Pinned a plan");
    else if (before.plan && !after.plan) out.push("Removed the plan");
    else if (before.plan?.status !== after.plan?.status) out.push(`Plan is now ${after.plan?.status.replace(/_/g, " ")}`);
    else out.push("Changed the plan");
  }
}

/** What a part's changed fields mean, in words. */
const PART_FIELDS: Record<string, string> = {
  x: "size or place",
  y: "size or place",
  z: "size or place",
  material: "material",
  grain_axis: "grain direction",
  thickness_axis: "which way it lies",
  tags: "tags",
  decor: "whether it's decor",
  note: "note",
  cuts: "shape",
};

/** The same lines with names in place of ids, for people to read. */
function namedDiff(before: Design, after: Design): string[] {
  const out: string[] = [];
  const partNames = new Map([...before.parts, ...before.unverified, ...after.parts, ...after.unverified].map((p) => [p.id, p.name]));
  const materialNames = new Map([...before.materials, ...after.materials].map((m) => [m.id, m.name]));
  const part = (ref: string) => {
    const [, source, copy] = /^(.*?)(?:#(\d+))?$/.exec(ref)!;
    const name = partNames.get(source!) ?? ref;
    return copy ? `${name} ${copy}` : name;
  };
  const material = (id: string) => materialNames.get(id) ?? id;
  const target = (t: string) => {
    const f = parseFinishTarget(t);
    if (!f) return t;
    if (f.kind === "material") return `everything in ${material(f.material)}`;
    return f.kind === "face" ? `the ${f.face} face of ${part(f.part)}` : part(f.part);
  };
  const size = (p: Param, expr: string) => (p.unit === "mm" && literalValue(expr) !== null ? `${expr} mm` : expr);
  if (before.name !== after.name) out.push(`Renamed "${before.name}" to "${after.name}"`);
  section(out, "the size", before.params, after.params, "name", (p) => `${paramShortLabel(p)}, ${size(p, p.expr)}`, (a, b) =>
    a.expr !== b.expr ? `${paramShortLabel(b)} from ${a.expr} to ${size(b, b.expr)}` : `Changed the size ${paramShortLabel(b)}: ${changedFields(a, b).join(", ")}`,
  );
  section(out, "the material", before.materials, after.materials, "id", (m) => `${m.name}, ${m.thickness_mm} mm`, (a, b) =>
    a.thickness_mm !== b.thickness_mm ? `Changed ${b.name} from ${a.thickness_mm} to ${b.thickness_mm} mm thick` : `Changed the material ${b.name}: ${changedFields(a, b).join(", ")}`,
  );
  section(out, "the part", before.parts, after.parts, "id", (p) => p.name, (a, b) => {
    if (a.name !== b.name && changedFields(a, b).length === 1) return `Renamed the part "${a.name}" to "${b.name}"`;
    const what = [...new Set(changedFields(a, b).filter((f) => f !== "name").map((f) => PART_FIELDS[f] ?? f))];
    return `Changed ${b.name}${what.length ? `: its ${andList(what)}` : ""}`;
  });
  section(out, "the stand-in box", before.unverified, after.unverified, "id", (u) => `${u.name}, not checked yet`);
  section(out, "a joint:", before.joints, after.joints, "id", (j) => `${j.type.replace(/_/g, " ")}, ${part(j.guest)} into ${part(j.host)}`, (a, b) =>
    `Changed the ${b.type.replace(/_/g, " ")} joining ${part(b.guest)} to ${part(b.host)}`,
  );
  section(out, "a row of", before.arrays, after.arrays, "id", (a) => `${andList(a.parts.map(part))} × ${a.count}`, (a, b) =>
    a.count !== b.count ? `How many of ${andList(b.parts.map(part))}: from ${a.count} to ${b.count}` : `Changed how ${andList(b.parts.map(part))} repeat`,
  );
  section(out, "the hardware", before.hardware, after.hardware, "id", (h) => h.name, (a, b) => `Changed ${b.name}`);
  section(out, "the rule", before.rules, after.rules, "id", (r) => `"${r.message}"`, (a, b) => `Changed the rule "${b.message}"`);
  finishesAndStock(out, before, after, target, material);
  return out;
}
