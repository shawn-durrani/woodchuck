// Woodchuck as an MCP server, so a chat elsewhere (Crossband) can work on
// the open design. It speaks MCP over stdio and talks to the running app
// over HTTP, so every change shows live in the Woodchuck window too.
//
// Nothing here edits a design itself. Messages go to Woodchuck's own
// Claude, which changes the design only through its woodworking tools,
// and previews are answered the same way as in the app. Colours and the
// design's existing parameters can also change straight away, through the
// same operations as the app's own controls.
//
// Any tool but the two that send Woodchuck's Claude a message also asks the
// app to warm its prompt cache, which it does only once the cache has gone
// cold, so the next message doesn't wait on a cold cache.
//
// Run it with: tsx packages/server/src/mcp.ts (WOODCHUCK_URL defaults to
// http://127.0.0.1:8905).

import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  applyOp,
  AXIS_FACES,
  derive,
  FACE_AXIS,
  finishLabel,
  fmt,
  JOINT_TYPES,
  literalValue,
  normaliseFinish,
  OpError,
  ORBIT_SPEED,
  PALETTES,
  refsOf,
  runChecks,
  SIDE_TABS,
  speciesOf,
  type DerivedPart,
  type Design,
  type JointType,
  type Op,
  type ParamUnit,
} from "@woodchuck/core";
import { background, describe, hasReply, itemsAfter, progressText, type Item, type Progress } from "./progress.js";
import type { EditSummary } from "./tools.js";

const BASE = (process.env.WOODCHUCK_URL ?? "http://127.0.0.1:8905").replace(/\/$/, "");
/** Named in the note the Woodchuck window shows when its view is changed. */
const CALLER = process.env.WOODCHUCK_CALLER ?? "another app";
/** The caller's name at the start of a line. */
const CALLER_AT_START = CALLER.charAt(0).toUpperCase() + CALLER.slice(1);

/**
 * How long woodchuck_ask waits for a quick answer before handing the work
 * over. A chat app holds its turn while a tool runs, so it's kept short.
 */
const ASK_WAIT_MS = 6_000;
/** How long woodchuck_reply waits for a request to finish. */
const REPLY_WAIT_MS = 8_000;

export { describe, itemsAfter, type Item };

/** One change to a design, as the window's history lists it. */
interface Change {
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

/** Every design by id, with the open one's file to download. */
export function designList(s: AppState): string {
  const all = s.projects ?? [];
  return [
    "Designs, by id:",
    ...all.map((p) => `- ${p.slug}: ${p.name}${p.starred ? ", starred" : ""}${p.slug === s.project.slug ? ", open" : ""}${p.changed ? `, changed ${p.changed.slice(0, 10)}` : ""}`),
    `The open design's file: ${BASE}/api/design.json`,
  ].join("\n");
}

/** Whether Woodchuck's Claude is working or waiting on the woodworker. */
function claudeLines(s: Pick<AppState, "busy" | "waiting">, sayFree: boolean): string[] {
  const out: string[] = [];
  if (s.busy) out.push("Woodchuck's Claude is working right now.");
  if (s.waiting.length) out.push(`Woodchuck's Claude is waiting for an answer to a ${s.waiting.join(" and ")}.`);
  if (!out.length && sayFree) out.push("Woodchuck's Claude isn't working on anything.");
  return out;
}

/** "a, b and c", or "a, b and 4 more" past the cap. */
function listed(xs: string[], max = xs.length): string {
  const kept = xs.length > max ? [...xs.slice(0, max - 1), `${xs.length - max + 1} more`] : xs;
  return kept.length < 2 ? kept.join("") : `${kept.slice(0, -1).join(", ")} and ${kept.at(-1)}`;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const plural = (n: number, word: string) => `${n === 0 ? "no" : n} ${word}${n === 1 ? "" : "s"}`;

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

/** The largest number woodchuck_set_param takes, a kilometre in mm. */
const MAX_VALUE = 1_000_000;

/**
 * Read by a voice model, where "15" and "50" sound alike, so it says the
 * change back before calling. Crossband keeps 900 characters of a
 * description, and a test holds this one under that.
 */
export const SET_PARAM_DESCRIPTION =
  "Change sizes in the open Woodchuck design straight away, without asking Woodchuck's Claude, by setting parameters it already has. " +
  "Use it only when the woodworker names a size that maps to an existing parameter; call woodchuck_design first for the names. " +
  "Before calling, say the change back (parameter, old → new in mm) and get a yes, unless the woodworker said which size and the exact number in one breath. " +
  "Give value_mm for a size in mm, value for another unit such as a count, or expression for a formula. " +
  "A change over 20%, or to 0 or below, is refused unless confirmed is true. " +
  "Sizes worked out from it move too. It works mid-build as its own undo step, and Woodchuck's Claude is told. " +
  "Anything that adds, removes or reshapes parts, or needs a new parameter, goes to woodchuck_ask.";

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

/** The least time between two asks to warm Woodchuck's cache. Woodchuck decides whether one is needed. */
const WARM_ASK_EVERY_MS = 60_000;
let warmAskedAt = -Infinity;

/**
 * Asks Woodchuck to warm its Claude's prompt cache, without waiting. A tool
 * call from another app is a sign the woodworker is about to talk about the
 * design, and Woodchuck sends a warm-up only when the cache has gone cold.
 * The tools that send its Claude a message never ask, since that message
 * writes the cache itself.
 */
function warmUp() {
  if (Date.now() - warmAskedAt < WARM_ASK_EVERY_MS) return;
  warmAskedAt = Date.now();
  void fetch(`${BASE}/api/warm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: "mcp" }) })
    .then((r) => r.body?.cancel())
    .catch(() => undefined);
}

async function getState(): Promise<AppState> {
  const r = await fetch(`${BASE}/api/state`);
  if (!r.ok) throw new Error(`Woodchuck answered ${r.status}`);
  return (await r.json()) as AppState;
}

async function postJson(path: string, body: unknown): Promise<{ status: number; error?: string; steered?: boolean; change?: EditSummary }> {
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as { error?: string; steered?: boolean; change?: EditSummary };
  return { status: r.status, ...(j.error ? { error: j.error } : {}), ...(j.steered ? { steered: true } : {}), ...(j.change ? { change: j.change } : {}) };
}

/** Woodchuck's reason for refusing, as one sentence after "Nothing changed." */
const refusal = (r: { status: number; error?: string }) => text(`Nothing changed. ${String(r.error ?? `Woodchuck answered ${r.status}`).replace(/\.?$/, ".")}`);

/**
 * Undoes or redoes the change it names, once. Sent again, the change is
 * already where it was asked to go, so nothing more happens.
 */
async function historyStep(which: "undo" | "redo", change: number) {
  const r = await fetch(`${BASE}/api/${which}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ change }) });
  const j = (await r.json().catch(() => ({}))) as { error?: string; already?: boolean; entry?: { id: number; label: string } | null };
  if (!r.ok) return refusal({ status: r.status, ...(j.error ? { error: j.error } : {}) });
  const label = j.entry?.label ?? "";
  if (j.already) return text(`Change ${change}, "${label}", is ${which === "undo" ? "undone" : "in the design"} already, so nothing changed.`);
  return which === "undo"
    ? text(`Undid change ${change}, "${label}". woodchuck_redo with change ${change} puts it back.`)
    : text(`Redid change ${change}, "${label}". woodchuck_undo with change ${change} takes it out again.`);
}

export interface DesignRequest {
  action: "list" | "open" | "new" | "copy" | "rename" | "star" | "delete";
  design?: string | undefined;
  name?: string | undefined;
  example?: boolean | undefined;
  starred?: boolean | undefined;
  confirmed?: boolean | undefined;
}

/**
 * The design menu, for another chat. Each action names the design or the
 * name it means, so sent twice it does its job once: a design already
 * open, made, named, starred or gone is left as it is.
 */
async function designAction(a: DesignRequest) {
  const s = await getState();
  const all = s.projects ?? [];
  const byId = (id?: string) => all.find((p) => p.slug === id);
  const ids = () => `Designs: ${all.map((p) => p.slug).join(", ")}.`;
  switch (a.action) {
    case "list":
      return text(designList(s));
    case "open": {
      const p = byId(a.design);
      if (!p) return text(`Nothing changed. There's no design ${a.design ?? "named"}. ${ids()}`);
      if (p.slug === s.project.slug) return text(`${p.name} is open already.`);
      const r = await postJson("/api/projects/open", { slug: p.slug });
      return r.status >= 300 ? refusal(r) : text(`Opened ${p.name}.`);
    }
    case "new":
    case "copy": {
      const name = a.name?.trim();
      if (!name) return text(`Nothing changed. Say what to call the ${a.action === "new" ? "new design" : "copy"}.`);
      // Sent again, the design it made is the one open.
      const made = s.design.name === name && (a.action === "copy" || (a.example ? s.project.example === "record_console" : !s.design.parts.length));
      if (made) return text(`${name} is open already, so nothing changed.`);
      const clash = all.find((p) => p.name === name);
      if (clash) return text(`Nothing changed. There's already a design called ${name} (${clash.slug}). Open it, or pick another name.`);
      const r = a.action === "new" ? await postJson("/api/projects", { name, ...(a.example ? { example: "record_console" } : {}) }) : await postJson("/api/projects/copy", { name });
      if (r.status >= 300) return refusal(r);
      return text(a.action === "new" ? `Started ${name}${a.example ? " from the record console example" : ""}. It's open now.` : `Copied ${s.design.name} as ${name}. The copy is open now.`);
    }
    case "rename": {
      const name = a.name?.trim();
      if (!name) return text("Nothing changed. Say the new name.");
      if (s.design.name === name) return text(`It's called ${name} already, so nothing changed.`);
      const r = await postJson("/api/ops", { ops: [{ op: "rename_design", name }], label: `${CALLER_AT_START}: rename to ${name}` });
      return r.status >= 300 ? refusal(r) : text(`Renamed ${s.design.name} to ${name}. It's one change the woodworker can undo.`);
    }
    case "star": {
      const p = byId(a.design ?? s.project.slug);
      if (!p) return text(`Nothing changed. There's no design ${a.design}. ${ids()}`);
      if (a.starred === undefined) return text("Nothing changed. Say starred true to star it, or false to take the star off.");
      const r = await postJson("/api/projects/star", { slug: p.slug, starred: a.starred });
      return r.status >= 300 ? refusal(r) : text(`${p.name} is ${a.starred ? "starred" : "not starred"}.`);
    }
    case "delete": {
      if (!a.design) return text("Nothing changed. Say which design to delete, by its id from list.");
      const p = byId(a.design);
      if (!p) return text(`There's no design ${a.design}, so there's nothing to delete.`);
      if (!a.confirmed) {
        return text(`Nothing changed yet. Deleting ${p.name} takes it and its chat out of Woodchuck, and it can't be undone. Ask the woodworker, then call again with confirmed true.`);
      }
      const r = await postJson("/api/projects/delete", { slug: p.slug });
      if (r.status >= 300) return refusal(r);
      return text(`Deleted ${p.name}. ${(await getState()).project.name} is open now.`);
    }
  }
}

/** Sends the open window a view change, and says how many windows took it. */
async function showView(view: Record<string, unknown>): Promise<number> {
  const v = await fetch(`${BASE}/api/view`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: CALLER, ...view }) });
  return ((await v.json().catch(() => ({}))) as { windows?: number }).windows ?? 0;
}

async function getProgress(): Promise<Progress> {
  const r = await fetch(`${BASE}/api/progress`);
  if (!r.ok) throw new Error(`Woodchuck answered ${r.status}`);
  return (await r.json()) as Progress;
}

/** Watches the request until Claude stops working on it, or the time is up, whichever comes first. */
async function watch(ms: number): Promise<Progress> {
  const end = Date.now() + ms;
  let p = await getProgress();
  while (p.state === "running" && Date.now() < end) {
    await new Promise((r) => setTimeout(r, Math.min(500, Math.max(0, end - Date.now()))));
    p = await getProgress();
  }
  return p;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
/** Words for the model, and the background block another app watches the request by. */
const withProgress = (t: string, p: Progress) => ({ content: [{ type: "text" as const, text: t }], structuredContent: background(p) });
const unreachable = (e: unknown) =>
  text(`Woodchuck isn't answering at ${BASE} (${(e as Error).message}). Check it's running on this computer.`);

/** What to say once a request has been handed over: the answer if it's ready, or how it's going. */
function answer(p: Progress): string {
  if (hasReply(p.state)) return p.reply;
  if (p.state === "idle") return progressText(p);
  return `Woodchuck's Claude has started on it, and the Woodchuck window shows it working.\n${progressText(p)}\nCall woodchuck_progress when the woodworker asks how it's going.`;
}

/**
 * Sends a message to Woodchuck's Claude and never waits long. With Claude
 * idle it starts a turn and waits a few seconds for a quick answer. Mid-build
 * the message goes in after Claude's current step, and this returns at once.
 */
async function send(body: Record<string, unknown>, waitMs = ASK_WAIT_MS) {
  const r = await postJson("/api/chat", { selection: [], ...body });
  if (r.status >= 300) return text(`Woodchuck refused that: ${r.error ?? r.status}`);
  if (r.steered) {
    const p = await getProgress();
    return withProgress(
      `Passed on. Woodchuck's Claude is mid-build, so it reads the message after its current step and carries on with it in mind. The Woodchuck window shows it as sent while Claude worked.\n${progressText(p)}`,
      p,
    );
  }
  const p = await watch(waitMs);
  return withProgress(answer(p), p);
}

/** The colour cards, in lines another model can choose from. */
export function colourCards(): string {
  return PALETTES.map(
    (p) =>
      `${p.maker} ${p.name} (${p.source.toLowerCase()}):\n` +
      p.colours.map((c) => `- ${c.number ? `${c.number} ` : ""}${c.name}${p.photographed_on && c.swatch ? ` ${c.swatch}` : ""}${c.note ? `: ${c.note}` : ""}`).join("\n"),
  ).join("\n\n");
}

/** Tests pass shorter waits. */
export function buildServer(o: { askWaitMs?: number; replyWaitMs?: number } = {}): McpServer {
  const askWait = o.askWaitMs ?? ASK_WAIT_MS;
  const replyWait = o.replyWaitMs ?? REPLY_WAIT_MS;
  const server = new McpServer({ name: "woodchuck", version: "1.0.0" });

  server.registerTool(
    "woodchuck_ask",
    {
      title: "Ask Woodchuck",
      description:
        "Send a message to Woodchuck, the woodworker's furniture design app. Woodchuck's own Claude reads it and changes the open design only through its woodworking tools: sizes, joints, timber, and finishes from the Linolie Satin Wood Oil and Osmo Polyx-Oil cards. Use it for anything about the design, such as trying other colours. Pass the woodworker's request on in plain words. It never waits long: a quick answer comes straight back, and a longer build carries on in the Woodchuck window while you keep talking. Sent while Woodchuck's Claude is mid-build, the message redirects the build: it reads it after its current step and carries on with it in mind. Changes show live in the Woodchuck window; use woodchuck_view to change what that window shows, and woodchuck_picture to see the design here.",
      inputSchema: { message: z.string().min(1).describe("What to ask or tell Woodchuck, in plain words") },
    },
    async ({ message }) => {
      try {
        return await send({ text: message }, askWait);
      } catch (e) {
        return unreachable(e);
      }
    },
  );

  server.registerTool(
    "woodchuck_reply",
    {
      title: "Woodchuck's latest reply",
      description:
        "Get what Woodchuck's Claude said and did in its latest request, once it's finished or waiting on an answer. Waits a few seconds at most, then says how it's going if it's still working.",
      inputSchema: {},
    },
    async () => {
      warmUp();
      try {
        const p = await watch(replyWait);
        return withProgress(p.state === "running" ? `It's still working.\n${progressText(p)}` : answer(p), p);
      } catch (e) {
        return unreachable(e);
      }
    },
  );

  server.registerTool(
    "woodchuck_progress",
    {
      title: "How Woodchuck's build is going",
      description:
        "Say how Woodchuck's Claude is getting on, straight away: what it's doing, how many steps and how long it's taken, whether it's waiting on the woodworker, and its reply once it's done. Use it whenever someone asks how it's going. Never call it in a loop to wait; it answers at once, and the work carries on either way.",
      inputSchema: {},
    },
    async () => {
      warmUp();
      try {
        const p = await getProgress();
        const said = hasReply(p.state) ? `\n\n${p.reply}` : "";
        return withProgress(`${progressText(p)}${said}`, p);
      } catch (e) {
        return unreachable(e);
      }
    },
  );

  server.registerTool(
    "woodchuck_preview",
    {
      title: "Answer Woodchuck's preview",
      description:
        "Answer the preview Woodchuck's Claude is showing: apply makes the change as one step the woodworker can undo; not_now leaves the design as it is. Only call this when the woodworker has said which.",
      inputSchema: {
        choice: z.enum(["apply", "not_now"]),
        note: z.string().optional().describe("Anything the woodworker added, such as what to change instead"),
      },
    },
    async ({ choice, note }) => {
      try {
        const s = await getState();
        if (!s.waiting.includes("preview")) return text("Woodchuck isn't waiting on a preview right now.");
        return await send({ text: `${choice === "apply" ? "Apply it." : "Not now."}${note ? ` ${note}` : ""}`, preview: choice }, askWait);
      } catch (e) {
        return unreachable(e);
      }
    },
  );

  server.registerTool(
    "woodchuck_view",
    {
      title: "Change the Woodchuck window's view",
      // Crossband cuts a description at 900 characters, so the detail is in the inputs.
      description:
        "Change what the open Woodchuck window shows. It never changes the design. Use it whenever the woodworker wants to see something in Woodchuck, rather than asking Woodchuck's Claude. For the cut list or the cutting layout, such as \"show me the cut list\", open tab \"make\"; for problems, \"check\"; for colours, \"finish\"; for sizes or a picked part, \"edit\"; for past versions, \"history\". For a one-off turn, such as \"turn it a bit\", use turn_degrees. For a turn that keeps going, such as \"spin it slowly\", \"keep rotating\" or \"show it off while we talk\", use orbit \"start\", and orbit \"stop\" to hold it still. It can also show the 2D plan views, set the look, lighting and camera view, zoom, fit the model, turn see-through on, pull the piece or a joint apart, place the room photo, fill the window, highlight parts, show the waiting preview or a worked joint, and render a picture to the downloads.",
      inputSchema: {
        plan_views: z.boolean().optional().describe("true shows the 2D plan views (front, top, side and iso drawings); false goes back to the 3D view"),
        look: z.enum(["finished", "plain"]).optional(),
        lighting: z.enum(["daylight", "evening", "workshop"]).optional(),
        view: z.enum(["iso", "front", "top", "left", "right", "back"]).optional(),
        fit: z.boolean().optional().describe("Bring the whole model back into view"),
        turn_degrees: z.number().min(-360).max(360).optional().describe("Turn the camera around the model; positive turns it to the right. A bit is about 20"),
        orbit: z
          .enum(["start", "stop"])
          .optional()
          .describe(
            "start keeps the camera turning slowly around the model until stop; stop holds it still. An orbit keeps going while the look, lighting, zoom or fit change, and stops by itself when the woodworker takes the camera, picks a camera view or opens the plan views",
          ),
        orbit_degrees_per_second: z
          .number()
          .min(-ORBIT_SPEED.max)
          .max(ORBIT_SPEED.max)
          .optional()
          .describe(`How fast an orbit turns, in degrees a second, at least ${ORBIT_SPEED.min} either way; positive turns it to the right. The default ${ORBIT_SPEED.default} is a slow showcase spin, once round in half a minute`),
        zoom: z.number().min(0.2).max(5).optional().describe("Above 1 moves closer, below 1 further away; 1.5 is a step in"),
        see_through: z.boolean().optional().describe("Show the parts see-through so the joints show"),
        explode: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Pull the piece apart the way it goes together: 1 fully apart, 0 back together, and anything between partly apart, the last part on coming off first"),
        focus_joint: z
          .string()
          .optional()
          .describe('Pull one of the design\'s joints apart on its own, by its id from woodchuck_status, with the rest faded and its section and sizes beside it, for "how does this joint go together" or "what size is that tenon". "" goes back to the whole piece'),
        photo: z.boolean().optional().describe("Place the design in its room photo, or put the photo away"),
        render: z.boolean().optional().describe("After the other changes, save a picture of what the window shows to the woodworker's downloads"),
        fill_window: z.boolean().optional().describe("true fills the window with the 3D view; false brings the panels back"),
        highlight: z.array(z.string()).optional().describe("Part ids to pick so they're highlighted; an empty list clears it"),
        show_preview: z.boolean().optional().describe("Open the preview Woodchuck's Claude is waiting on"),
        show_joint: z.enum(JOINT_TYPES as unknown as [JointType, ...JointType[]]).optional().describe("Open a worked example of this joint"),
        close_drawer: z.boolean().optional(),
        tab: z
          .enum(SIDE_TABS)
          .optional()
          .describe(
            "Open this tab of the side panel, by its name on screen. make holds the workshop drawings, the cut list and the cutting layout; check the problems, each with a fix; finish the timber and colours; edit the picked part and the design's sizes; history every change and version",
          ),
      },
    },
    async (a) => {
      warmUp();
      try {
        const view: Record<string, unknown> = { from: CALLER };
        if (a.plan_views !== undefined) view.mode = a.plan_views ? "plan" : "3d";
        if (a.turn_degrees) view.turn = a.turn_degrees;
        // A speed on its own means start turning at that speed.
        if (a.orbit) view.orbit = a.orbit;
        else if (a.orbit_degrees_per_second !== undefined) view.orbit = "start";
        if (a.orbit_degrees_per_second !== undefined) view.orbitSpeed = a.orbit_degrees_per_second;
        if (a.zoom) view.zoom = a.zoom;
        if (a.see_through !== undefined) view.seeThrough = a.see_through;
        if (a.explode !== undefined) view.explode = a.explode;
        if (a.focus_joint !== undefined) view.focusJoint = a.focus_joint;
        if (a.photo !== undefined) view.photo = a.photo;
        if (a.render) view.render = true;
        if (a.look) view.look = a.look;
        if (a.lighting) view.lighting = a.lighting;
        if (a.view) view.view = a.view;
        if (a.fit) view.fit = true;
        if (a.fill_window !== undefined) view.fill = a.fill_window;
        if (a.highlight) view.select = a.highlight;
        if (a.show_preview) view.drawer = "preview";
        else if (a.show_joint) view.drawer = { joint: a.show_joint };
        else if (a.close_drawer) view.drawer = "close";
        if (a.tab) view.tab = a.tab;
        const r = await fetch(`${BASE}/api/view`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(view) });
        const j = (await r.json()) as { windows?: number; shown?: string; error?: string };
        if (!r.ok) return text(`Woodchuck refused that: ${j.error ?? r.status}`);
        if (!j.windows) return text(`No Woodchuck window is open, so nothing changed. Open ${BASE} in a browser on this computer, then try again.`);
        const orbiting = view.orbit === "start" ? ' It keeps turning until you send orbit "stop", or the woodworker takes the camera.' : "";
        return text(`The Woodchuck window now shows ${j.shown}.${orbiting}`);
      } catch (e) {
        return unreachable(e);
      }
    },
  );

  server.registerTool(
    "woodchuck_finish",
    {
      title: "Change colours in Woodchuck",
      description:
        "Put a finish on part of the open Woodchuck design straight away, without asking Woodchuck's Claude: fast, for trying colours. targets use the ids from woodchuck_status: \"material:<id>\" for everything in a material, a part id for a whole piece (an array's original covers its copies; \"part#2\" is one copy), or \"part.face\" with a face of left, right, bottom, top, back or front. A colour on a material or whole piece replaces colours set inside it. finish is a colour name or number from woodchuck_colours, such as \"amsterdam\", \"13\" or \"3044\", or \"raw\" for bare timber. It works while Woodchuck's Claude is mid-build too, as its own undo step. The window shows it at once, and Woodchuck's Claude is told after its current step, or on its next turn. Use woodchuck_ask instead for anything beyond colours.",
      inputSchema: {
        targets: z.array(z.string()).min(1),
        finish: z.string().min(1),
      },
    },
    async ({ targets, finish }) => {
      warmUp();
      try {
        const id = normaliseFinish(finish);
        if (!id) return text(`"${finish}" isn't a colour Woodchuck knows. Call woodchuck_colours for the list.`);
        const what = targets.length > 3 ? `${targets.slice(0, 2).join(", ")} and ${targets.length - 2} more` : targets.join(", ");
        const label = `${CALLER_AT_START}: finish ${what} with ${finishLabel(id)}`;
        const r = await postJson("/api/ops", { ops: [{ op: "set_finish", targets, finish: id }], label });
        if (r.status >= 300) return text(`Woodchuck refused that: ${r.error ?? r.status}`);
        // Show it: colours only appear in the Finished look. The note names
        // materials as the woodworker knows them.
        const design = (await getState()).design;
        const names = targets.map((t) => (t.startsWith("material:") ? `all of ${design.materials.find((m) => m.id === t.slice(9))?.name ?? t.slice(9)}` : t));
        const shown = names.length > 3 ? `${names.slice(0, 2).join(", ")} and ${names.length - 2} more` : names.join(", ");
        const windows = await showView({ look: "finished", note: `${id === "raw" ? "took the finish off" : "finished"} ${shown}${id === "raw" ? "" : ` with ${finishLabel(id)}`}.` });
        return text(
          `Done: ${what} now ${id === "raw" ? "bare timber" : `finished with ${finishLabel(id)}`}. It's one change the woodworker can undo, and Woodchuck's Claude will be told.` +
            (windows ? " The Woodchuck window shows it now." : " No Woodchuck window is open to show it; woodchuck_picture can draw it."),
        );
      } catch (e) {
        return unreachable(e);
      }
    },
  );

  server.registerTool(
    "woodchuck_set_param",
    {
      title: "Change sizes in Woodchuck",
      description: SET_PARAM_DESCRIPTION,
      inputSchema: {
        params: z
          .array(
            z.object({
              name: z.string().min(1).describe('A parameter woodchuck_design lists, such as "top_length"'),
              value_mm: z.number().min(-MAX_VALUE).max(MAX_VALUE).optional().describe("The new size in millimetres, for a parameter in mm"),
              value: z.number().min(-MAX_VALUE).max(MAX_VALUE).optional().describe("The new value of a parameter in another unit, such as a count"),
              expression: z.string().min(1).max(200).optional().describe('A formula in place of a number, using the design\'s parameters, such as "top_length / 4"'),
            }),
          )
          .min(1)
          .max(12),
        confirmed: z.boolean().optional().describe("true once the woodworker has said yes to a change of over 20%, or to 0 or below"),
      },
    },
    async ({ params, confirmed }) => {
      warmUp();
      try {
        const plan = planParams((await getState()).design, params);
        if ("refused" in plan) return text(`Nothing changed. ${plan.refused}`);
        if (!plan.ops.length) return text(`Nothing changed: ${listed(plan.unchanged)}.`);
        const check = needsConfirming(plan.planned);
        if (check.length && !confirmed) return text(confirmText(check));
        const what = paramChangeLabel(plan.planned);
        const r = await postJson("/api/ops", { ops: plan.ops, label: `${CALLER_AT_START}: ${what}`, summary: true });
        if (r.status >= 300) return text(`Woodchuck refused that, so nothing changed: ${r.error ?? r.status}`);
        // The model has a new size, so the window brings all of it into view.
        const windows = await showView({ fit: true, note: `${what}.` });
        // A Woodchuck from before the summary sends none, so the reply leans on woodchuck_design for the rest.
        if (!r.change) return text(`Done: ${what}. It's one change the woodworker can undo in one step. Call woodchuck_design for the sizes and problems now.`);
        return text(paramChangeText(plan.planned, r.change, plan.unchanged, windows));
      } catch (e) {
        return unreachable(e);
      }
    },
  );

  server.registerTool(
    "woodchuck_design",
    {
      title: "Read the Woodchuck design",
      description:
        "Read the open Woodchuck design at once, in short lines: its parameters with their values and formulas, its materials, its parts with their sizes in mm and any slopes, holes or notches, its overall size, its problems, and whether Woodchuck's Claude is busy or waiting for an answer. Call it before woodchuck_set_param to find the parameter that holds a size, and when the woodworker asks about sizes. It never changes anything.",
      inputSchema: {},
    },
    async () => {
      warmUp();
      try {
        return text(designText(await getState()));
      } catch (e) {
        return unreachable(e);
      }
    },
  );

  server.registerTool(
    "woodchuck_colours",
    {
      title: "Woodchuck's colour cards",
      description: "List the finishes Woodchuck knows: the Linolie Satin Wood Oil colours with how each looks on Douglas fir, and the Osmo Polyx-Oils. Use the name or number with woodchuck_finish.",
      inputSchema: {},
    },
    async () => {
      warmUp();
      return text(colourCards());
    },
  );

  server.registerTool(
    "woodchuck_undo",
    {
      title: "Undo a change in Woodchuck",
      description:
        "Undo the latest change to the open design, named by its number from woodchuck_status, such as 14. To go back further, undo each change in turn, latest first. A change already undone is left as it is, so calling again is safe. Woodchuck's Claude mustn't be working: wait for it, or stop it first. woodchuck_redo puts a change back.",
      inputSchema: { change: z.number().int().min(1).describe("The change's number, from woodchuck_status") },
    },
    async ({ change }) => {
      warmUp();
      try {
        return await historyStep("undo", change);
      } catch (e) {
        return unreachable(e);
      }
    },
  );

  server.registerTool(
    "woodchuck_redo",
    {
      title: "Redo a change in Woodchuck",
      description:
        "Put back a change that was undone, named by its number from woodchuck_status's undone list. Changes come back in order, the one undone last first. A change already back in the design is left as it is, so calling again is safe. Woodchuck's Claude mustn't be working.",
      inputSchema: { change: z.number().int().min(1).describe("The change's number, from woodchuck_status") },
    },
    async ({ change }) => {
      warmUp();
      try {
        return await historyStep("redo", change);
      } catch (e) {
        return unreachable(e);
      }
    },
  );

  server.registerTool(
    "woodchuck_designs",
    {
      title: "Woodchuck's designs",
      description:
        "List, open, start, copy, rename, star or delete Woodchuck's designs, as its design menu does. Name a design by its id from list, which also gives a link to download the open one. new and copy need a name, and the design they made being open counts as done, so calling again is safe. star sets starred true or false. delete takes a design and its chat out of Woodchuck for good, so ask the woodworker first, then call again with confirmed true. Woodchuck's Claude mustn't be working to open, start, copy or delete one.",
      inputSchema: {
        action: z.enum(["list", "open", "new", "copy", "rename", "star", "delete"]),
        design: z.string().optional().describe("A design's id, from list. For open, star and delete; star takes the open design without one"),
        name: z.string().min(1).max(120).optional().describe("The name for new, copy and rename"),
        example: z.boolean().optional().describe("For new: start from the record console example"),
        starred: z.boolean().optional().describe("For star: true to star it, false to take the star off"),
        confirmed: z.boolean().optional().describe("For delete: true once the woodworker has said yes"),
      },
    },
    async (a) => {
      warmUp();
      try {
        return await designAction(a);
      } catch (e) {
        return unreachable(e);
      }
    },
  );

  server.registerTool(
    "woodchuck_status",
    {
      title: "Woodchuck design status",
      description:
        "Read the open Woodchuck design's name, problems, timber, finishes and joint ids, its latest changes by number for woodchuck_undo and woodchuck_redo, and whether Woodchuck's Claude is busy or waiting for an answer.",
      inputSchema: {},
    },
    async () => {
      warmUp();
      try {
        return text(summarise(await getState()));
      } catch (e) {
        return unreachable(e);
      }
    },
  );

  server.registerTool(
    "woodchuck_picture",
    {
      title: "Picture of the Woodchuck design",
      description:
        "Draw the open design as a picture, in the Finished look with its real timber and finishes by default, and get a link to it. With preview true, it draws the preview Woodchuck's Claude is showing as if applied, without applying it. To show the picture, put the markdown image line it gives you in your reply.",
      inputSchema: {
        preview: z.boolean().optional().describe("Draw the waiting preview's change instead of the design as it is"),
        look: z.enum(["finished", "plain"]).optional(),
        lighting: z.enum(["daylight", "evening", "workshop"]).optional(),
        view: z.enum(["iso", "front", "top", "left", "right", "back"]).optional(),
      },
    },
    async ({ preview, look, lighting, view }) => {
      warmUp();
      try {
        const q = new URLSearchParams({ look: look ?? "finished", lighting: lighting ?? "daylight", view: view ?? "iso" });
        if (preview) {
          const waiting = [...(await getState()).chat].reverse().find((c) => c.kind === "preview" && c.status === "proposed");
          if (!waiting) return text("There's no preview waiting to draw.");
          q.set("preview", waiting.id);
        }
        const r = await fetch(`${BASE}/api/picture?${q}`);
        const j = (await r.json()) as { url?: string; error?: string };
        if (!r.ok || !j.url) return text(`Woodchuck couldn't draw it: ${j.error ?? r.status}`);
        const url = `${BASE}${j.url}`;
        const png = Buffer.from(await (await fetch(url)).arrayBuffer()).toString("base64");
        const s = await getState();
        return {
          content: [
            {
              type: "text" as const,
              text: `Here's ${s.project.name}${preview ? " with the preview's change, not yet applied" : ""}. Put this line in your reply, on its own, to show it:\n\n![${s.project.name}](${url})`,
            },
            { type: "image" as const, data: png, mimeType: "image/png" },
          ],
        };
      } catch (e) {
        return unreachable(e);
      }
    },
  );

  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await buildServer().connect(new StdioServerTransport());
}
