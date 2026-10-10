// What Woodchuck tells another chat, such as Crossband, about the open
// design: its summary, its sizes and problems, any part of its drawings and
// lists, and the outcome of a size or a colour changed from that chat. The
// app works each answer out from the design it has open, and its MCP server
// only relays it. A new version of Woodchuck then reaches the chat as soon
// as it's running, with no restart of the chat app.

import {
  applyOp,
  AXIS_FACES,
  cutLayout,
  cutList,
  cuttingPlanText,
  derive,
  drillingList,
  FACE_AXIS,
  finishLabel,
  fmt,
  literalValue,
  OpError,
  PALETTES,
  partSheetTexts,
  refsOf,
  runChecks,
  speciesOf,
  type DerivedPart,
  type Design,
  type Op,
  type ParamUnit,
} from "@woodchuck/core";
import type { Item } from "./progress.js";
import type { EditSummary } from "./tools.js";
import { READ_PARTS, type ReadPart } from "./reads.js";

export { READ_PARTS, type ReadPart };

/** "a, b and c", or "a, b and 4 more" past the cap. */
export function listed(xs: string[], max = xs.length): string {
  const kept = xs.length > max ? [...xs.slice(0, max - 1), `${xs.length - max + 1} more`] : xs;
  return kept.length < 2 ? kept.join("") : `${kept.slice(0, -1).join(", ")} and ${kept.at(-1)}`;
}

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
export const plural = (n: number, word: string) => `${n === 0 ? "no" : n} ${word}${n === 1 ? "" : "s"}`;

/** One change to a design, as the window's history lists it. */
export interface Change {
  id: number;
  author: string;
  label: string;
  at: string;
}

export interface AppState {
  busy: boolean;
  waiting: string[];
  design: Design;
  project: { slug: string; name: string; example?: string };
  report: { errors: number; warnings: number; ready_to_cut: boolean };
  chat: Item[];
  /** The changes that can be undone, latest last. */
  history?: Change[];
  /** The changes undone, next to redo last. */
  undone?: Change[];
  /** Every design, by id. */
  projects?: { slug: string; name: string; starred: boolean; changed: string | null }[];
  /** The design's saved versions, newest first. */
  versions?: { sha: string; author: string; at: string; message: string }[];
  /** The room photo kept with the design, if any. */
  backdrop?: string | null;
  has_openai_key?: boolean;
}

/** A short account of the open design: its name, problems, timber, finishes and joints. */
export function summarise(s: AppState): string {
  const d = s.design;
  const lines = [
    `Design: ${s.project.name}`,
    s.report.ready_to_cut ? "Ready to cut." : `${s.report.errors} errors and ${s.report.warnings} warnings.`,
    "Materials:",
    ...d.materials.map((m) => {
      const own = d.finishes?.[`material:${m.id}`];
      return `- ${m.name} (${m.id}): ${speciesOf(m).name}, ${own ? finishLabel(own) : "no finish of its own"}`;
    }),
  ];
  const others = Object.entries(d.finishes ?? {}).filter(([t]) => !t.startsWith("material:"));
  if (others.length) {
    const byColour = new Map<string, string[]>();
    for (const [t, f] of others) byColour.set(f, [...(byColour.get(f) ?? []), t]);
    lines.push("Finishes on pieces and faces:");
    for (const [f, ts] of byColour) lines.push(`- ${finishLabel(f)}: ${ts.length > 6 ? `${ts.slice(0, 5).join(", ")} and ${ts.length - 5} more` : ts.join(", ")}`);
  }
  // A joint's id is what woodchuck_view's focus_joint takes.
  if (d.joints.length) lines.push(`Joints, by id: ${listed(d.joints.map((j) => j.id), 20)}`);
  // A change's number is what woodchuck_undo and woodchuck_redo take.
  const said = (c: Change) => `${c.id} "${c.label}"`;
  if (s.history?.length) lines.push(`Changes, latest first: ${listed([...s.history].reverse().map(said), 5)}`);
  if (s.undone?.length) lines.push(`Undone, next to redo first: ${listed([...s.undone].reverse().map(said), 5)}`);
  lines.push(...claudeLines(s, false));
  return lines.join("\n");
}

/** Whether Woodchuck's Claude is working or waiting on the woodworker. */
function claudeLines(s: Pick<AppState, "busy" | "waiting">, sayFree: boolean): string[] {
  const out: string[] = [];
  if (s.busy) out.push("Woodchuck's Claude is working right now.");
  if (s.waiting.length) out.push(`Woodchuck's Claude is waiting for an answer to a ${s.waiting.join(" and ")}.`);
  if (!out.length && sayFree) out.push("Woodchuck's Claude isn't working on anything.");
  return out;
}

/** A parameter's value with its unit, such as "2040 mm" or "5". */
function withUnit(v: number | null, unit: ParamUnit): string {
  if (v === null) return "nothing that works out";
  if (unit === "mm") return `${fmt(v)} mm`;
  if (unit === "kg") return `${fmt(v)} kg`;
  if (unit === "deg") return `${fmt(v)}°`;
  return fmt(v);
}

const UNIT_WORDS: Record<ParamUnit, string> = {
  mm: "a size in mm",
  count: "a count",
  kg: "a weight in kg",
  deg: "an angle in degrees",
  none: "a plain number",
};

/** The most a part's shape takes on its line in woodchuck_design. */
const SHAPE_CHARS = 100;

const CUT_NOUNS = { chamfer: ["corner cut off", "corners cut off"], hole: ["hole", "holes"], notch: ["notch", "notches"] } as const;

/**
 * A shaped part's cuts in a few words: each slope with its two ends and its
 * angle, then a count of corners cut off, holes and notches. "" for a part
 * its cuts haven't shaped.
 */
export function shapeWords(p: Pick<DerivedPart, "source" | "profile">, design: Design): string {
  const pr = p.profile;
  if (!pr) return "";
  const own = design.parts.find((x) => x.id === p.source)?.cuts ?? [];
  const mm = (n: number | undefined) => fmt(Math.round((n ?? 0) * 10) / 10);
  const out: string[] = [];
  const counts = { chamfer: 0, hole: 0, notch: 0 };
  for (const c of pr.cuts) {
    if (c.kind !== "slope") {
      counts[c.kind]++;
      continue;
    }
    const cut = own.find((x) => x.id === c.id);
    const edge = cut?.kind === "edge" ? cut.edge : null;
    const run = edge ? (FACE_AXIS[edge] === pr.u ? pr.v : pr.u) : null;
    const angle = Math.round((c.angle_deg ?? 0) * 10) / 10;
    const [from, to] = run ? AXIS_FACES[run] : ["start", "end"];
    out.push(
      angle === 0
        ? `${edge ?? "an edge"} cut down to ${mm(c.start_mm)}`
        : `${edge ?? "an edge"} sloped from ${mm(c.start_mm)} at the ${from} to ${mm(c.end_mm)} at the ${to}, ${fmt(angle)}°`,
    );
  }
  for (const k of ["chamfer", "hole", "notch"] as const) if (counts[k]) out.push(`${counts[k]} ${CUT_NOUNS[k][counts[k] === 1 ? 0 : 1]}`);
  return clip(out.join(", "), SHAPE_CHARS);
}

/** How long each list in woodchuck_design runs before "and N more". */
const DESIGN_LIMITS = { params: 20, materials: 10, parts: 24, problems: 8 };

/**
 * The open design in compact lines for another model: parameters, materials,
 * parts with their sizes and shapes, the overall size and the problems.
 * Copies in an array fold into one line, and every list stops at a cap.
 */
export function designText(s: AppState): string {
  const design = s.design;
  const d = derive(design);
  const report = runChecks(design, d);
  const lines = [`Design: ${s.project.name}`, ...claudeLines(s, true)];

  const solid = d.parts.filter((p) => !p.broken && !p.decor);
  if (solid.length) {
    const span = (i: number) => fmt(Math.max(...solid.map((p) => p.nominal.max[i]!)) - Math.min(...solid.map((p) => p.nominal.min[i]!)));
    lines.push(`Overall: ${span(0)} mm wide, ${span(1)} mm high and ${span(2)} mm deep.`);
  } else lines.push("It has no parts yet.");

  if (design.params.length) {
    lines.push("Parameters, which woodchuck_set_param changes:");
    const rows = design.params.map((p) => {
      const v = d.params[p.name];
      const value = v && "value" in v ? withUnit(v.value, p.unit) : `can't be worked out (${clip(v?.error ?? "unknown", 80)})`;
      const formula = literalValue(p.expr) === null ? `, worked out as ${clip(p.expr, 160)}` : "";
      const kind = p.unit === "mm" || p.unit === "none" ? "" : `, ${UNIT_WORDS[p.unit]}`;
      return `- ${p.name} = ${value}${kind}${formula}${p.note ? `: ${clip(p.note, 60)}` : ""}`;
    });
    lines.push(...capped(rows, DESIGN_LIMITS.params));
  } else lines.push("No parameters yet.");

  if (design.materials.length) {
    lines.push("Materials:");
    lines.push(...capped(design.materials.map((m) => `- ${m.id}: ${m.name} (${m.thickness_mm} mm ${m.kind}, ${speciesOf(m).name})`), DESIGN_LIMITS.materials));
  }

  if (d.parts.length) {
    lines.push("Parts, length × width × thickness in mm:");
    const groups = new Map<string, { id: string; name: string; count: number; size: string; what: string }>();
    for (const p of d.parts) {
      const size = p.broken ? "can't be worked out" : [p.finished.length, p.finished.width, p.finished.thickness].map((n) => fmt(Math.round(n * 10) / 10)).join(" × ");
      const shape = shapeWords(p, design);
      const what = p.unverified ? "a stand-in not checked yet" : `${p.material}${p.decor ? ", decor" : ""}${shape ? `, ${shape}` : ""}`;
      const key = `${p.source}|${size}|${shape}`;
      const g = groups.get(key);
      if (g) g.count++;
      else groups.set(key, { id: p.source, name: p.name, count: 1, size, what });
    }
    const plain = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
    const rows = [...groups.values()].map((g) => {
      const name = plain(g.name) === plain(g.id) ? "" : ` (${clip(g.name, 40)})`;
      return `- ${g.id}${g.count > 1 ? ` ×${g.count}` : ""}${name}: ${g.size}, ${g.what}`;
    });
    lines.push(...capped(rows, DESIGN_LIMITS.parts));
  }

  const counts = `${plural(report.errors, "error")} and ${plural(report.warnings, "warning")}`;
  lines.push(`Checks: ${counts}, ${report.ready_to_cut ? "ready to cut" : "not ready to cut yet"}${report.issues.length ? ":" : "."}`);
  const issues = report.issues.map((i) => `- ${i.severity === "error" ? "Error" : "Warning"}: ${clip(i.message, 160)}`);
  lines.push(...capped(issues, DESIGN_LIMITS.problems));
  return lines.join("\n");
}


/**
 * One part of the open design in words, as the app shows it, so another
 * chat can answer a question about it without guessing. A part's id, its
 * cut-list row number or its name narrows the parts, joints, cut list and
 * drilling list to it.
 */
export function readText(s: AppState, what: ReadPart, part?: string): string {
  const design = s.design;
  const d = derive(design);
  const list = cutList(design, d);
  const of = `${s.project.name}'s`;
  // The part ids a narrowed read covers: a row's parts, or a part and its array copies.
  const wanted = part?.trim().toLowerCase();
  const ids = wanted
    ? new Set([
        ...list.rows.filter((r) => String(r.row) === wanted || r.name.toLowerCase() === wanted).flatMap((r) => r.parts),
        ...d.parts.filter((p) => [p.id, p.source].some((id) => id.toLowerCase() === wanted)).map((p) => p.id),
      ])
    : null;
  if (ids && !ids.size) return `There's no part "${part}" in ${s.project.name}. Parts, by id: ${listed([...new Set(d.parts.map((p) => p.source))], 40)}.`;
  const covers = (partIds: string[]) => !ids || partIds.some((id) => ids.has(id));

  switch (what) {
    case "parts": {
      const sheets = partSheetTexts(design, d, list).filter((t) => covers(t.parts));
      if (!sheets.length) return `${s.project.name} has no parts to draw yet.`;
      return [
        `The part sheets in ${of} workshop drawings:`,
        ...sheets.flatMap((t) => [
          "",
          `Sheet ${t.sheet}, part ${t.row}: ${t.name}. Make ${t.qty} (${t.parts.join(", ")}).`,
          `${t.cut}, ${t.material}.`,
          `Views: ${t.views.face}, ${t.views.edge} and ${t.views.end}.`,
          ...(t.notes.length ? t.notes.map((n, i) => `${i + 1}. ${n}`) : ["No machining. Cut it to size."]),
          t.positions,
        ]),
      ].join("\n");
    }
    case "joints": {
      const joints = d.joints.filter((j) => covers([j.host, j.guest]));
      if (!joints.length) return part ? `${part} has no joints.` : `${s.project.name} has no joints yet.`;
      const notes = new Map(design.joints.map((j) => [j.id, j.note]));
      return [
        `${of} joints, by id:`,
        ...joints.map((j) => {
          const params = Object.entries(j.params).map(([k, v]) => `${k} ${fmt(v!)}`);
          const lib = j.defaulted.length ? `, with ${listed(j.defaulted)} from the library` : "";
          const note = notes.get(j.source);
          return `- ${j.id}: ${j.type}, ${j.guest} into ${j.host}${params.length ? `; ${params.join(", ")}${lib}` : ""}.${note ? ` Note: ${note}` : ""}`;
        }),
      ].join("\n");
    }
    case "cut_list": {
      const rows = list.rows.filter((r) => covers(r.parts));
      if (!rows.length) return part ? `${part} isn't on the cut list.` : `${s.project.name} has nothing to cut yet.`;
      return [
        `${of} cut list, length × width × thickness in mm. A cut's (x, y, z) is its corner nearest the part's left, bottom and back, and a Domino mortise's is the middle of its mouth, measured from that corner of the part. Read parts for where each cut starts and ends on its sheet.`,
        ...rows.flatMap((r) => [
          `${r.row}. ${r.name} ×${r.qty}: ${fmt(r.length_mm)} × ${fmt(r.width_mm)} × ${fmt(r.thickness_mm)}, ${r.material_name}${r.grain ? ", grain along the length" : ""}. Parts: ${r.parts.join(", ")}.`,
          ...r.machining.map((m) => `  - ${m}`),
          ...(r.shape ?? []).map((x) => `  - ${x}`),
        ]),
        ...(list.excluded.length ? [`Left off: ${list.excluded.map((x) => `${x.id} (${x.reason})`).join(", ")}.`] : []),
      ].join("\n");
    }
    case "cutting_plan":
      return [`${of} cutting plan:`, ...cuttingPlanText(cutLayout(design, list))].join("\n");
    case "drilling": {
      const rows = drillingList(design, d, list).filter((r) => covers(list.rows.find((x) => x.row === r.row)?.parts ?? []));
      if (!rows.length) return part ? `${part} has no holes to drill.` : "There are no holes to drill.";
      return [
        `${of} drilling list. Centres are measured as on each part's sheet:`,
        ...rows.map((r) => {
          const depth = r.through ? "right through" : r.holes === "pocket holes" ? "set by the jig" : `${fmt(r.depth_mm)} deep`;
          return `- ${r.row}. ${r.part} ×${r.qty}: ${r.count} ${r.holes} each for ${r.with}, Ø${fmt(r.diameter_mm)}, ${depth}, in the ${r.face}. Centres: ${r.centres.join("; ")}.`;
        }),
      ].join("\n");
    }
    case "hardware":
      if (!list.hardware.length) return "There's no hardware to buy.";
      return [`${of} hardware to buy:`, ...list.hardware.map((h) => `- ${h.name}: ${h.qty}${h.spec ? `, ${h.spec}` : ""}`)].join("\n");
    case "checks": {
      const report = runChecks(design, d);
      const counts = `${plural(report.errors, "error")} and ${plural(report.warnings, "warning")}`;
      return [
        `Checks for ${s.project.name}: ${counts}, ${report.ready_to_cut ? "ready to cut" : "not ready to cut yet"}${report.issues.length ? ":" : "."}`,
        ...report.issues.map((i) => `- ${i.severity === "error" ? "Error" : "Warning"}: ${i.message}`),
      ].join("\n");
    }
    case "file":
      return [`${of} file, as JSON:`, JSON.stringify(design)].join("\n");
  }
}

/** A list of lines cut to a cap, with a last line saying how many more there are. */
function capped(rows: string[], max: number): string[] {
  return rows.length > max ? [...rows.slice(0, max - 1), `- and ${rows.length - max + 1} more`] : rows;
}

/** One parameter to change, as woodchuck_set_param takes it. */
export interface ParamChange {
  name: string;
  value_mm?: number;
  value?: number;
  expression?: string;
}

/** A parameter change checked against the design, with its value before and after. */
export interface PlannedChange {
  name: string;
  unit: ParamUnit;
  from_expr: string;
  to_expr: string;
  from_value: number | null;
  to_value: number | null;
  /** The names the parameter's formula used before, which it stops following once it's a plain number. */
  followed: string[];
}

/** Values pass to the design as plain decimals, never in exponent form. */
const asExpr = (n: number) => String(Math.round(n * 10_000) / 10_000);

/**
 * Checks a list of parameter changes against the design before anything is
 * sent. Each name must be a parameter the design has, and each new value a
 * number in its unit or a formula that works out. Making a parameter is
 * Claude's job, so an unknown name is refused. A change to the value the
 * parameter already has is left out.
 */
export function planParams(design: Design, changes: ParamChange[]): { refused: string } | { ops: Op[]; planned: PlannedChange[]; unchanged: string[] } {
  const before = derive(design);
  const valueOf = (d: ReturnType<typeof derive>, name: string) => {
    const v = d.params[name];
    return v && "value" in v ? v.value : null;
  };
  let trial = design;
  const ops: Op[] = [];
  const pending: Omit<PlannedChange, "to_value">[] = [];
  const unchanged: string[] = [];
  const seen = new Set<string>();
  for (const c of changes) {
    const p = design.params.find((x) => x.name === c.name);
    if (!p) {
      const names = design.params.map((x) => x.name);
      const close = names.filter((n) => n.includes(c.name) || c.name.includes(n)).slice(0, 3);
      return {
        refused:
          `There's no parameter called "${c.name}".${close.length ? ` Did you mean ${listed(close).replace(/ and /, " or ")}?` : ""}` +
          (names.length ? ` The design's parameters are ${listed(names, 15)}.` : " The design has no parameters yet.") +
          " Making a new one is a job for woodchuck_ask.",
      };
    }
    if (seen.has(p.name)) return { refused: `${p.name} is listed twice. Give each parameter once.` };
    seen.add(p.name);
    const given = [c.value_mm, c.value, c.expression].filter((x) => x !== undefined).length;
    const numberField = p.unit === "mm" ? "value_mm" : "value";
    if (given !== 1) return { refused: `Give ${p.name} one of ${numberField} or expression.` };
    if (c.value_mm !== undefined && p.unit !== "mm") return { refused: `${p.name} is ${UNIT_WORDS[p.unit]}, so give it as value.` };
    if (c.value !== undefined && p.unit === "mm") return { refused: `${p.name} is a size in mm, so give it as value_mm.` };
    const n = c.value_mm ?? c.value;
    if (n !== undefined && p.unit === "count" && !Number.isInteger(n)) return { refused: `${p.name} is a count, so it takes a whole number, not ${fmt(n)}.` };
    const expr = n !== undefined ? asExpr(n) : c.expression!.trim();
    if (expr === p.expr) {
      unchanged.push(`${p.name} is already ${withUnit(valueOf(before, p.name), p.unit)}`);
      continue;
    }
    const op: Op = { op: "set_param", name: p.name, expr, unit: p.unit };
    try {
      trial = applyOp(trial, op);
    } catch (e) {
      if (e instanceof OpError) return { refused: e.message };
      throw e;
    }
    ops.push(op);
    const followed = literalValue(p.expr) === null ? refsOf(p.expr) : [];
    pending.push({ name: p.name, unit: p.unit, from_expr: p.expr, to_expr: expr, from_value: valueOf(before, p.name), followed });
  }
  // A formula that loops back on itself, divides by zero or gives true or
  // false is refused here, with every parameter that worked before still working.
  const after = derive(trial);
  for (const [name, v] of Object.entries(after.params)) {
    if (!("error" in v) || (before.params[name] && "error" in before.params[name]!)) continue;
    const own = pending.some((c) => c.name === name);
    return { refused: `${own ? name : `${name}, which is worked out from what you changed,`} wouldn't work out: ${v.error}` };
  }
  return { ops, planned: pending.map((c) => ({ ...c, to_value: valueOf(after, c.name) })), unchanged };
}

/** How far a change moves a parameter, as a share of its value now, or null when it can't be told. */
function shareMoved(c: PlannedChange): number | null {
  if (c.from_value === null || c.to_value === null) return null;
  if (c.from_value === 0) return c.to_value === 0 ? 0 : Infinity;
  return Math.abs(c.to_value - c.from_value) / Math.abs(c.from_value);
}

/** The most a parameter can move in one call before the woodworker has to confirm it, as a share of its value. */
export const CONFIRM_SHARE = 0.2;

/**
 * Changes a misheard number could explain: one that moves a parameter by
 * more than a fifth of its value, or takes it to zero or below. Each comes
 * back with why, for the calling model to put to the woodworker.
 */
export function needsConfirming(planned: PlannedChange[]): { change: PlannedChange; why: string }[] {
  return planned.flatMap((c) => {
    if (c.to_value !== null && c.to_value <= 0) return [{ change: c, why: "and a value of 0 or below is almost always a mishearing" }];
    const share = shareMoved(c);
    if (share === null || share <= CONFIRM_SHARE) return [];
    const why = share === Infinity ? "a change from zero" : `${Math.round(share * 100)}% ${c.to_value! > c.from_value! ? "more" : "less"}`;
    return [{ change: c, why }];
  });
}

/** The refusal for a change the woodworker has to confirm, with what to ask them. */
export function confirmText(check: { change: PlannedChange; why: string }[]): string {
  const said = check.map(({ change: c, why }) => `${c.name} from ${withUnit(c.from_value, c.unit)} to ${newValue(c)}, ${why}`);
  const c = check[0]!.change;
  const ask = `${c.name.charAt(0).toUpperCase()}${c.name.slice(1).replace(/_/g, " ")} from ${withUnit(c.from_value, c.unit)} to ${withUnit(c.to_value, c.unit)}${check.length > 1 ? `, and the ${check.length > 2 ? "others" : "other"}` : ""}, is that right?`;
  return (
    `Nothing changed yet. ${check.length === 1 ? "This change needs" : "These changes need"} the woodworker's yes first, in case a number was misheard: ${listed(said)}. ` +
    `Say it back to them, such as "${ask}", and once they say yes, call again with the same values and confirmed true.`
  );
}

/** A parameter's new value, with the formula when it has one, such as "top_length / 4 (510 mm)". */
function newValue(c: PlannedChange): string {
  return literalValue(c.to_expr) === null ? `${c.to_expr} (${withUnit(c.to_value, c.unit)})` : withUnit(c.to_value, c.unit);
}

/** The changes in a few words, for the undo step's label and the window's note. */
export function paramChangeLabel(planned: PlannedChange[]): string {
  return `set ${listed(planned.map((c) => `${c.name} from ${withUnit(c.from_value, c.unit)} to ${newValue(c)}`), 3)}`;
}

/** How many new problems a parameter change's reply names before it counts the rest. */
const NEW_PROBLEMS_SHOWN = 20;

/** What a parameter change did, for the calling model to tell the woodworker. */
export function paramChangeText(planned: PlannedChange[], change: EditSummary, unchanged: string[], windows: number): string {
  const lines = [`Done: ${listed(planned.map((c) => `${c.name} ${withUnit(c.from_value, c.unit)} → ${newValue(c)}`))}.`];
  for (const c of planned) {
    const follows = literalValue(c.to_expr) === null ? refsOf(c.to_expr) : [];
    if (c.followed.length) {
      const now = follows.length ? `It's now worked out as ${clip(c.to_expr, 160)}` : `It's now a plain ${withUnit(c.to_value, c.unit)} and stops following them`;
      lines.push(`${c.name} was worked out as ${clip(c.from_expr, 160)}, so it followed ${listed(c.followed, 6)}. ${now}; undo puts the formula back.`);
    } else if (follows.length) lines.push(`${c.name} now follows ${listed(follows, 6)}, and moves when they do.`);
  }
  const set = new Set(planned.map((c) => c.name));
  const knockOn = change.params.filter((p) => !set.has(p.name));
  if (knockOn.length) {
    const words = knockOn.map((p) => `${p.name} ${withUnit(p.from_value, p.unit)} → ${withUnit(p.to_value, p.unit)}`);
    lines.push(`Sizes worked out from ${planned.length > 1 ? "them" : "it"} changed too: ${listed(words, 8)}.`);
  }
  const moved = change.sizes.length + (change.more_changed ?? 0);
  if (moved) {
    const groups = new Map<string, { count: number; cut: string }>();
    for (const s of change.sizes) {
      const id = s.id.replace(/#\d+$/, "");
      const g = groups.get(id);
      if (g) g.count++;
      else groups.set(id, { count: 1, cut: `${fmt(s.cut_mm.length)} × ${fmt(s.cut_mm.width)} × ${fmt(s.cut_mm.thickness)}` });
    }
    // The summary lists the first parts only, so a last group it cut short isn't named with a count.
    const whole = [...groups].slice(0, change.more_changed ? -1 : undefined);
    const shown = whole.slice(0, 5);
    const rest = moved - shown.reduce((n, [, g]) => n + g.count, 0);
    const words = shown.map(([id, g]) => `${id}${g.count > 1 ? ` ×${g.count}` : ""} cut ${g.cut} mm`);
    const more = rest > 0 ? `${words.length ? "; and " : ""}${rest} more` : "";
    lines.push(`${plural(moved, "part")} moved or changed size: ${words.join("; ")}${more}.`);
  } else lines.push("No part moved or changed size.");
  if (change.added.length) lines.push(`${plural(change.added.length, "part")} added: ${listed(change.added, 6)}.`);
  if (change.removed.length) lines.push(`${plural(change.removed.length, "part")} removed: ${listed(change.removed, 6)}.`);
  const p = change.problems;
  lines.push(`Checks: ${plural(p.errors, "error")} and ${plural(p.warnings, "warning")}, ${p.ready_to_cut ? "ready to cut" : "not ready to cut yet"}.`);
  // Every new problem is named, up to a cap that keeps a broken change from flooding a voice model's context.
  const fresh = p.new.slice(0, NEW_PROBLEMS_SHOWN).map((i) => `- New ${i.severity}: ${clip(i.message, 200)}`);
  lines.push(...(fresh.length ? fresh : ["No new errors or warnings."]));
  if (p.new.length > NEW_PROBLEMS_SHOWN) lines.push(`- and ${p.new.length - NEW_PROBLEMS_SHOWN} more new problems, which woodchuck_design lists`);
  if (p.fixed.length) lines.push(`Fixed: ${listed(p.fixed.map((m) => clip(m, 120)), 4)}.`);
  if (unchanged.length) lines.push(`${listed(unchanged)}, so that stays as it was.`);
  lines.push(
    "It's one change the woodworker can undo in one step, and Woodchuck's Claude will be told." +
      (windows ? " The Woodchuck window shows it now." : " No Woodchuck window is open to show it; woodchuck_picture can draw it."),
  );
  return lines.join("\n");
}

/** The colour cards, in lines another model can choose from. */
export function colourCards(): string {
  return PALETTES.map(
    (p) =>
      `${p.maker} ${p.name} (${p.source.toLowerCase()}):\n` +
      p.colours.map((c) => `- ${c.number ? `${c.number} ` : ""}${c.name}${p.photographed_on && c.swatch ? ` ${c.swatch}` : ""}${c.note ? `: ${c.note}` : ""}`).join("\n"),
  ).join("\n\n");
}
