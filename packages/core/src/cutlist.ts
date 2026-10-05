// The cut list. Parts that come out the same, with the same machining on
// the same faces and the same shape, share a row. Mirror-image parts stay
// separate, because their housings are on opposite faces. Shapes match only
// when they're the same to 0.1 mm, and a mirror image keys apart.

import { AXIS_INDEX, type DeriveResult, type DerivedPart, type Machining } from "./derive.js";
import { fmt } from "./expr.js";
import { shapeKey } from "./profile.js";
import type { Design } from "./types.js";

export interface CutRow {
  row: number;
  name: string;
  qty: number;
  material: string;
  material_name: string;
  length_mm: number;
  width_mm: number;
  thickness_mm: number;
  grain: boolean;
  machining: string[];
  /** What the part's cuts do to its blank, in workshop words. Only a row of shaped parts has it. */
  shape?: string[];
  parts: string[];
}

export interface HardwareRow {
  name: string;
  library_part?: string;
  kind: string;
  qty: number;
  spec: string;
  ids: string[];
}

export interface CutList {
  rows: CutRow[];
  hardware: HardwareRow[];
  /** Parts left off: decor, unverified and broken ones. */
  excluded: { id: string; reason: string }[];
}

/** The cut list's precision, 0.1 mm. The workshop drawings round the same way, so the two always agree. */
export function roundCut(n: number): number {
  return Math.round(n * 10) / 10;
}
const r1 = roundCut;

/** A count with its noun, singular for one: "1 screw hole", "2 screw holes". */
function counted(count: number | undefined, noun: string): string {
  return `${count ?? "?"} ${noun}${count === 1 ? "" : "s"}`;
}

/** One line of workshop instructions for a piece of machining. */
export function machiningText(m: Machining, part?: DerivedPart): string {
  const n = (v: number) => fmt(r1(v));
  const where = part
    ? ` at (${(["x", "y", "z"] as const).map((a) => n(m.region.min[AXIS_INDEX[a]]! - part.box.min[AXIS_INDEX[a]]!)).join(",")})`
    : "";
  switch (m.label) {
    case "screw holes":
      return `${counted(m.count, "screw hole")}, ${n(m.diameter_mm ?? 4)} mm, through the ${m.face} face for ${m.with}`;
    case "pocket holes":
      return `${counted(m.count, "pocket hole")} in the ${m.face} face, screwing into ${m.with}`;
    case "dowel holes":
      return `${counted(m.count, "dowel hole")}, ${n(m.diameter_mm ?? 8)} mm × ${n(m.depth_mm)} deep, in the ${m.face} face for ${m.with}`;
    case "through slot":
      return `through slot ${n(m.width_mm)} × ${n(m.length_mm)}, right through ${n(m.depth_mm)}, for ${m.with}${where}`;
    case "open slot":
      return `open slot (bridle) ${n(m.width_mm)} × ${n(m.length_mm)} from the ${m.open_end ?? "?"} end, right through ${n(m.depth_mm)}, for ${m.with}${where}`;
    case "half lap":
      return `half lap ${n(m.width_mm)} × ${n(m.length_mm)} × ${n(m.depth_mm)} deep in the ${m.face} face for ${m.with}${where}`;
    case "box joint fingers":
      return `${counted(m.count, "box joint slot")}, ${n(m.width_mm)} wide × ${n(m.depth_mm)} deep, for ${m.with}`;
    case "tenon":
    case "tongue":
      return `${m.label} ${n(m.width_mm)} thick × ${n(m.length_mm)} wide × ${n(m.depth_mm)} long on the ${m.face} end, into ${m.with}`;
    default:
      return `${m.label} ${n(m.width_mm)} wide × ${n(m.depth_mm)} deep × ${n(m.length_mm)} long in the ${m.face} face for ${m.with}${where}`;
  }
}

function machiningLines(p: DerivedPart): string[] {
  // Copies in an array get the same machining, so name the original part.
  return p.machining.map((m) => machiningText({ ...m, with: m.with.replace(/#\d+$/, "") }, p)).sort();
}

export function cutList(design: Design, d: DeriveResult): CutList {
  const materials = new Map(design.materials.map((m) => [m.id, m]));
  const groups = new Map<string, CutRow>();
  const excluded: CutList["excluded"] = [];
  for (const p of d.parts) {
    if (p.decor) {
      excluded.push({ id: p.id, reason: "decor" });
      continue;
    }
    if (p.unverified) {
      excluded.push({ id: p.id, reason: "unverified" });
      continue;
    }
    if (p.broken) {
      excluded.push({ id: p.id, reason: "geometry error" });
      continue;
    }
    const m = materials.get(p.material);
    const machining = machiningLines(p);
    const L = r1(p.cut.length);
    const W = r1(p.cut.width);
    const T = r1(p.cut.thickness);
    const shape = p.profile?.cuts.map((c) => c.text) ?? [];
    const key = [p.material, L, W, T, ...machining, ...(p.profile ? ["shape", shapeKey(p), ...shape] : [])].join("|");
    const row = groups.get(key);
    if (row) {
      row.qty++;
      row.parts.push(p.id);
      continue;
    }
    const entry: CutRow = {
      row: 0,
      name: p.copy === 1 ? p.name : (d.byId.get(p.source)?.name ?? p.name),
      qty: 1,
      material: p.material,
      material_name: m?.name ?? p.material,
      length_mm: L,
      width_mm: W,
      thickness_mm: T,
      grain: m?.grained ?? false,
      machining,
      parts: [p.id],
    };
    if (shape.length) {
      const { parts, ...rest } = entry;
      groups.set(key, { ...rest, shape, parts });
    } else groups.set(key, entry);
  }
  const rows = [...groups.values()].sort(
    (a, b) => a.material.localeCompare(b.material) || b.length_mm - a.length_mm || b.width_mm - a.width_mm,
  );
  rows.forEach((row, i) => (row.row = i + 1));

  const hw = new Map<string, HardwareRow>();
  for (const h of d.hardware) {
    const spec = Object.entries(h.spec)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
    const key = `${h.kind}|${h.name}|${spec}`;
    const row = hw.get(key);
    if (row) {
      row.qty += h.qty;
      row.ids.push(h.id);
    } else {
      const row: HardwareRow = { name: h.name, kind: h.kind, qty: h.qty, spec, ids: [h.id] };
      if (h.library_part) row.library_part = h.library_part;
      hw.set(key, row);
    }
  }
  return { rows, hardware: [...hw.values()], excluded };
}

function csvCell(v: string | number | boolean): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function cutListCsv(list: CutList): string {
  const lines = [
    ["Row", "Name", "Qty", "Material", "Length mm", "Width mm", "Thickness mm", "Grain along length", "Machining", "Shape", "Parts"].join(","),
  ];
  for (const r of list.rows) {
    lines.push(
      [r.row, r.name, r.qty, r.material_name, r.length_mm, r.width_mm, r.thickness_mm, r.grain ? "yes" : "no", r.machining.join("; "), (r.shape ?? []).join("; "), r.parts.join(" ")]
        .map(csvCell)
        .join(","),
    );
  }
  if (list.hardware.length) {
    lines.push("");
    lines.push(["Hardware", "Kind", "Qty", "Spec"].join(","));
    for (const h of list.hardware) lines.push([h.name, h.kind, h.qty, h.spec].map(csvCell).join(","));
  }
  return lines.join("\n") + "\n";
}
