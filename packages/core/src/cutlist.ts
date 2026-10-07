// The cut list. Parts that come out the same, with the same machining on
// the same faces and the same shape, share a row. Mirror-image parts stay
// separate, because their housings are on opposite faces. Shapes match only
// when they're the same to 0.1 mm, and a mirror image keys apart.

import { AXIS_INDEX, DOMINO_MORTISE, stopWords, type DeriveResult, type DerivedJoint, type DerivedPart, type Machining } from "./derive.js";
import { fmt } from "./expr.js";
import { dominoSize, housingWord, type JointParam } from "./joints.js";
import { cornerName, shapeKey } from "./profile.js";
import { isRunner } from "./runners.js";
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
  /** How to finish or fit what's cut, such as waxing the runners. Only a list with something to say has it. */
  notes?: string[];
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
    case DOMINO_MORTISE:
      return `Domino mortise ${n(m.width_mm)} wide × ${n(m.length_mm)} long × ${n(m.depth_mm)} deep, ${m.play_mm ? `${n(m.play_mm)} mm play` : "tight"}, in the ${m.face} face for ${m.with}${where}`;
    case "tenon":
    case "tongue":
      return `${m.label} ${n(m.width_mm)} thick × ${n(m.length_mm)} wide × ${n(m.depth_mm)} long on the ${m.face} end${m.flush ? `, flush with the ${m.flush} face` : ""}, into ${m.with}`;
    case "notch":
      return `notch ${n(m.length_mm)} × ${n(m.width_mm)} out of the ${cornerName(m.corner ? [m.corner, m.face] : [m.face])} corner, to fit the stopped ${housingWord(m.type)} in ${m.with}${where}`;
    default: {
      const stopped = m.stop_mm ? `, stopped ${stopWords(m.stop_mm)}` : "";
      return `${m.label} ${n(m.width_mm)} wide × ${n(m.depth_mm)} deep × ${n(m.length_mm)} long in the ${m.face} face for ${m.with}${where}${stopped}`;
    }
  }
}

/**
 * The other part in a piece of machining, as the workshop reads it. Copies
 * in an array get the same machining, so a copy reads as its original. A
 * joint that names one copy keeps its number, since it's on that copy alone.
 */
export function machiningWith(m: Machining): string {
  return m.on_copy ? m.with : m.with.replace(/#\d+$/, "");
}

/** One joint's sizes, as the drawer beside the model lists them under its section. */
export interface JointSizes {
  /** Each setting with its value in words, such as "15 mm", and whether it's the joint library's usual one. */
  settings: { name: string; value: string; usual: boolean }[];
  /** A stopped housing's stops, such as "10 mm from the front". */
  stopped?: string;
  /** What to cut on each part, in the cut list's words. */
  cuts: { part: string; lines: string[] }[];
}

const SETTING_NAMES: [JointParam, string][] = [
  ["depth", "Depth"],
  ["thickness", "Thickness"],
  ["width", "Width"],
  ["shoulder", "Shoulder"],
  ["fit", "Fit"],
  ["finger", "Finger width"],
  ["count", "Count"],
  ["diameter", "Diameter"],
  ["length", "Length"],
];

/** A joint's settings and the cuts it makes on each of its parts, or null for a joint that isn't there. */
export function jointSizes(d: { parts: readonly DerivedPart[]; joints: readonly DerivedJoint[] }, id: string): JointSizes | null {
  const j = d.joints.find((x) => x.id === id);
  if (!j) return null;
  const settings = SETTING_NAMES.flatMap(([k, name]) => {
    const v = j.params[k];
    // No fit is no setting at all.
    if (v === undefined || (k === "fit" && !v)) return [];
    return [{ name, value: k === "count" ? fmt(v) : `${fmt(r1(v))} mm`, usual: j.defaulted.includes(k) }];
  });
  const cuts = [j.host, j.guest].flatMap((pid) => {
    const p = d.parts.find((x) => x.id === pid);
    const lines = (p?.machining ?? []).filter((m) => m.joint === id).map((m) => machiningText({ ...m, with: machiningWith(m) }, p));
    return lines.length ? [{ part: pid, lines }] : [];
  });
  return { settings, ...(j.stop_mm ? { stopped: stopWords(j.stop_mm) } : {}), cuts };
}

function machiningLines(p: DerivedPart): string[] {
  return p.machining.map((m) => machiningText({ ...m, with: machiningWith(m) }, p)).sort();
}

/**
 * Names the rows of copies a joint names alone, such as "Shelf (shelf#2)",
 * where that joint sets them apart from the rest of their array.
 */
function nameCopyRows(rows: CutRow[], design: Design, d: DeriveResult) {
  const named = new Set(d.joints.filter((j) => j.on_copy).flatMap((j) => [j.host, j.guest]));
  if (!named.size) return;
  const sourceOf = (id: string) => d.byId.get(id)!.source;
  const rowsOf = new Map<string, number>();
  for (const row of rows) for (const s of new Set(row.parts.map(sourceOf))) rowsOf.set(s, (rowsOf.get(s) ?? 0) + 1);
  for (const row of rows) {
    if (!row.parts.every((id) => named.has(id)) || (rowsOf.get(sourceOf(row.parts[0]!)) ?? 0) < 2) continue;
    // The original reads as shelf#1, the way a joint names it alone.
    const refs = row.parts.map((id) => (design.arrays.some((a) => a.parts.includes(id)) ? `${id}#1` : id));
    row.name = `${row.name} (${refs.join(", ")})`;
  }
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
  nameCopyRows(rows, design, d);

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
  // Dominos are bought, so each size is a library part on the list, counted from the tenons the joints place.
  for (const j of d.joints) {
    const size = j.type === "domino" ? dominoSize(j.params.thickness, j.params.length) : undefined;
    const qty = j.features.filter((f) => f.kind === "tongue").length;
    if (!size || !qty) continue;
    const row = hw.get(`domino|${size.library_part}`);
    if (row) {
      row.qty += qty;
      row.ids.push(j.id);
    } else {
      const spec = `thickness_mm ${size.thickness_mm}, width_mm ${size.width_mm}, length_mm ${size.length_mm}`;
      hw.set(`domino|${size.library_part}`, { name: size.name, kind: "fixing", qty, spec, ids: [j.id], library_part: size.library_part });
    }
  }
  const list: CutList = { rows, hardware: [...hw.values()], excluded };
  // Runners are timber like any part. Wax is what makes a drawer slide on them.
  const runnerRows = rows.filter((r) => r.parts.some((id) => isRunner(d.byId.get(id) ?? { tags: [] }))).map((r) => r.row);
  if (runnerRows.length) {
    const which = runnerRows.length === 1 ? `row ${runnerRows[0]}` : `rows ${runnerRows.slice(0, -1).join(", ")} and ${runnerRows[runnerRows.length - 1]}`;
    list.notes = [`Wax the runners in ${which}, and the drawer edges or grooves that run on them, so the drawers slide freely.`];
  }
  return list;
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
  if (list.notes?.length) {
    lines.push("");
    lines.push("Notes");
    for (const n of list.notes) lines.push(csvCell(n));
  }
  return lines.join("\n") + "\n";
}
