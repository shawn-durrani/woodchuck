// The quality benchmark: invented tasks, the messages each one sends Claude,
// and deterministic checks on what comes back. scripts/bench.ts runs them
// against Claude for real. A check reads only the design and Claude's
// words, so the same result always gets the same verdict, and the tests pin
// every check with no key.
//
// A speed change, such as less thinking on a turn, has to keep these
// passing. A lost requirement or a wrong size costs timber, and can make a
// piece unsafe. Expected values come from the starting design wherever they
// can, so a change to the record console example moves them with it. Every
// length is in millimetres.

import {
  derive,
  FACES,
  finishedColour,
  finishOn,
  fmt,
  literalValue,
  lookupFinish,
  parse,
  recordConsoleOps,
  refsOf,
  runChecks,
  speciesOf,
  toLinear,
  type Ast,
  type DeriveResult,
  type DerivedPart,
  type Design,
  type Face,
  type Issue,
  type Op,
  type Rule,
} from "@woodchuck/core";
import { Turn, type MessagesClient } from "./agent.js";
import { isEffort, type Effort } from "./route.js";
import type { ChatItem, Project, Store } from "./store.js";
import { effortPath } from "./turnstats.js";

// ---------------------------------------------------------------------------
// Checks and outcomes

export interface Check {
  name: string;
  ok: boolean;
  /** Why it failed, in one line of numbers and ids. Never Claude's words. */
  reason?: string;
}

/** A check, with its reason worked out only when it fails. */
const check = (name: string, ok: boolean, reason: string | (() => string)): Check =>
  ok ? { name, ok } : { name, ok, reason: typeof reason === "function" ? reason() : reason };

/** What a task left behind, for the checks to read. */
export interface Outcome {
  /** The design before the first message. */
  start: Design;
  /** The design after each message and the go-aheads that followed it, in order. */
  after: Design[];
  /** Claude's words after each message: its replies, questions, plans and previews. */
  replies: string[];
  /** Whether a turn ended in an error. */
  failed: boolean;
}

const last = (o: Outcome): Design => o.after.at(-1) ?? o.start;

export interface QualityTask {
  name: string;
  /** The record console example, or an empty design. */
  start: "console" | "empty";
  /** The woodworker's messages, each one a turn. */
  messages: string[];
  /** Rough cost of one run on Sonnet 5.5 at high effort, low and high, in US dollars. */
  usd: [number, number];
  checks(o: Outcome): Check[];
}

// ---------------------------------------------------------------------------
// Reading a design

const EPS = 0.01;
/** A 12-inch LP sleeve is about 315 mm square. */
export const LP_SLEEVE_MM = 315;

const cache = new WeakMap<Design, DeriveResult>();
/** derive, once per design object. Snapshots are never changed, so this is safe. */
export function derived(design: Design): DeriveResult {
  let d = cache.get(design);
  if (!d) {
    d = derive(design);
    cache.set(design, d);
  }
  return d;
}

/** Real parts: worked out, and no props. */
function live(design: Design): DerivedPart[] {
  return derived(design).parts.filter((p) => !p.broken && !p.decor);
}

const lo = (p: DerivedPart, axis: 0 | 1 | 2) => p.nominal.min[axis];
const hi = (p: DerivedPart, axis: 0 | 1 | 2) => p.nominal.max[axis];
const span = (p: DerivedPart, axis: 0 | 1 | 2) => hi(p, axis) - lo(p, axis);

/** A part's id, name and tags as lowercase words, for telling what it is. */
function tokens(p: DerivedPart): string[] {
  return [p.id, p.name, ...p.tags].join(" ").toLowerCase().split(/[^a-z]+/).filter(Boolean);
}
const named = (p: DerivedPart, words: RegExp) => tokens(p).some((t) => words.test(t));
const isDrawer = (p: DerivedPart) => named(p, /^drawers?$/);

export interface Extent {
  width_mm: number;
  /** From the floor, or from the lowest part when one goes below it. */
  height_mm: number;
  depth_mm: number;
}

export function extent(design: Design): Extent {
  const parts = live(design);
  if (!parts.length) return { width_mm: 0, height_mm: 0, depth_mm: 0 };
  const min = (a: 0 | 1 | 2) => Math.min(...parts.map((p) => lo(p, a)));
  const max = (a: 0 | 1 | 2) => Math.max(...parts.map((p) => hi(p, a)));
  return { width_mm: max(0) - min(0), height_mm: max(1) - Math.min(0, min(1)), depth_mm: max(2) - min(2) };
}

/** A parameter's worked-out value, or undefined when there's none. */
export function paramValue(design: Design, name: string): number | undefined {
  const v = derived(design).params[name];
  return v && "value" in v ? v.value : undefined;
}

/**
 * The fronts of the drawers: panels named or tagged drawer that face
 * forward, with no bigger drawer panel in front of them. Slivers under a
 * tenth of the biggest front, such as handles, don't count.
 */
export function drawerFronts(design: Design): DerivedPart[] {
  const panels = live(design).filter((p) => isDrawer(p) && p.thickness_axis === "z" && !p.unverified);
  const area = (p: DerivedPart) => span(p, 0) * span(p, 1);
  const biggest = Math.max(0, ...panels.map(area));
  const covers = (q: DerivedPart, p: DerivedPart) => {
    const cx = (lo(p, 0) + hi(p, 0)) / 2;
    const cy = (lo(p, 1) + hi(p, 1)) / 2;
    return q !== p && area(q) >= area(p) && lo(q, 2) >= hi(p, 2) - 1 && lo(q, 0) < cx && hi(q, 0) > cx && lo(q, 1) < cy && hi(q, 1) > cy;
  };
  return panels
    .filter((p) => area(p) >= biggest / 10 && !panels.some((q) => covers(q, p)))
    .sort((a, b) => lo(a, 1) - lo(b, 1) || lo(a, 0) - lo(b, 0));
}

export interface DrawerInside {
  front: string;
  /** Between the drawer's two sides, or null when they can't be found. */
  width_mm: number | null;
  /** From the top of the drawer's bottom to the underside of the carcass above. Infinity when nothing is above. */
  height_mm: number | null;
}

/** How far a drawer's sides can sit outside its front, as a box front between dadoed sides does. */
const SIDE_REACH_MM = 25;

/** The room inside each drawer, measured from its parts. */
export function drawerInsides(design: Design): DrawerInside[] {
  const parts = live(design).filter((p) => !p.unverified);
  const drawers = parts.filter(isDrawer);
  return drawerFronts(design).map((f) => {
    const mine = drawers.filter((p) => {
      const cx = (lo(p, 0) + hi(p, 0)) / 2;
      return p !== f && cx > lo(f, 0) - SIDE_REACH_MM && cx < hi(f, 0) + SIDE_REACH_MM && lo(p, 1) < hi(f, 1) && hi(p, 1) > lo(f, 1);
    });
    const sides = mine.filter((p) => p.thickness_axis === "x").sort((a, b) => lo(a, 0) - lo(b, 0));
    const left = sides[0];
    const right = sides.at(-1);
    const width = left && right && left !== right ? lo(right, 0) - hi(left, 0) : null;
    const bottom = mine.filter((p) => p.thickness_axis === "y").sort((a, b) => lo(a, 1) - lo(b, 1))[0];
    let height: number | null = null;
    if (bottom) {
      const floor = hi(bottom, 1);
      const [x0, x1] = width !== null ? [hi(left!, 0), lo(right!, 0)] : [lo(bottom, 0), hi(bottom, 0)];
      const above = parts.filter(
        (p) =>
          !isDrawer(p) &&
          lo(p, 1) >= floor - EPS &&
          lo(p, 0) < x1 - EPS &&
          hi(p, 0) > x0 + EPS &&
          lo(p, 2) < hi(bottom, 2) - EPS &&
          hi(p, 2) > lo(bottom, 2) + EPS,
      );
      height = above.length ? Math.min(...above.map((p) => lo(p, 1))) - floor : Infinity;
    }
    return { front: f.id, width_mm: width, height_mm: height };
  });
}

/** Shelves counted two ways: parts named or tagged shelf, and every flat panel. */
export function shelfCount(design: Design): { named: number; flat: number } {
  const parts = live(design).filter((p) => !p.unverified);
  return { named: parts.filter((p) => named(p, /^shel(f|ves)$/)).length, flat: parts.filter((p) => p.thickness_axis === "y").length };
}

/** The error-level problems the checks find. */
export function errors(design: Design): Issue[] {
  return runChecks(design, derived(design)).issues.filter((i) => i.severity === "error");
}

/** Errors in after that before didn't have. */
export function newErrors(before: Design, after: Design): Issue[] {
  const had = new Set(errors(before).map((i) => i.key));
  return errors(after).filter((i) => !had.has(i.key));
}

function describeIssues(issues: Issue[]): string {
  const one = (i: Issue) => {
    const rule = /\(rule ([a-z0-9_]+)\)$/.exec(i.message)?.[1];
    return rule ? `rule ${rule} fails` : `${i.code}${i.parts.length ? ` on ${i.parts.slice(0, 2).join(" and ")}` : ""}`;
  };
  return issues.slice(0, 3).map(one).join(", ") + (issues.length > 3 ? ` and ${issues.length - 3} more` : "");
}

/** JSON with every object's keys sorted, so equal designs give equal text. */
export function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x,
  );
}

/** The parts of a design that differ between two versions, by top-level field. */
export function designChanges(before: Design, after: Design): string[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort() as (keyof Design)[];
  return keys.filter((k) => stableJson(before[k]) !== stableJson(after[k]));
}

/** Parts added, removed, moved or resized, and any change to sizes, joints, arrays, hardware or rules. */
export function geometryChanges(before: Design, after: Design): string[] {
  const a = new Map(live(before).map((p) => [p.id, p]));
  const b = new Map(live(after).map((p) => [p.id, p]));
  const same = (p: DerivedPart, q: DerivedPart) =>
    [0, 1, 2].every((i) => Math.abs(p.nominal.min[i]! - q.nominal.min[i]!) <= EPS && Math.abs(p.nominal.max[i]! - q.nominal.max[i]!) <= EPS) &&
    (["length", "width", "thickness"] as const).every((k) => Math.abs(p.cut[k] - q.cut[k]) <= EPS);
  const out: string[] = [];
  for (const [id, p] of a) {
    const q = b.get(id);
    if (!q) out.push(`${id} removed`);
    else if (!same(p, q)) out.push(`${id} moved or resized`);
  }
  for (const id of b.keys()) if (!a.has(id)) out.push(`${id} added`);
  for (const k of ["params", "joints", "arrays", "hardware", "rules", "unverified"] as const) {
    if (stableJson(before[k]) !== stableJson(after[k])) out.push(`${k} changed`);
  }
  return out;
}

/** Materials removed, made a different thickness, or shown as a different timber. */
export function timberChanges(before: Design, after: Design): string[] {
  const out: string[] = [];
  for (const m of before.materials) {
    const n = after.materials.find((x) => x.id === m.id);
    if (!n) out.push(`${m.id} removed`);
    else {
      if (Math.abs(n.thickness_mm - m.thickness_mm) > EPS) out.push(`${m.id} is ${fmt(n.thickness_mm)} mm, was ${fmt(m.thickness_mm)}`);
      if (speciesOf(n).id !== speciesOf(m).id) out.push(`${m.id} shows as ${speciesOf(n).id}, was ${speciesOf(m).id}`);
    }
  }
  return out;
}

const list = (xs: string[], n = 3) => xs.slice(0, n).join(", ") + (xs.length > n ? ` and ${xs.length - n} more` : "");

// ---------------------------------------------------------------------------
// Rules

/** An expression tree back to text, bracketed throughout, so it can be worked out on its own. */
function source(a: Ast): string {
  switch (a.kind) {
    case "num":
      return String(a.value);
    case "ref":
      return a.name;
    case "unary":
      return `${a.op}(${source(a.arg)})`;
    case "binary":
      return `(${source(a.left)}) ${a.op} (${source(a.right)})`;
    case "call":
      return `${a.fn}(${a.args.map(source).join(", ")})`;
  }
}

/** The comparisons joined by && at the top of a rule, each as measured and required sides. */
function comparisons(expr: string): { measured: string; required: string }[] {
  const out: { measured: string; required: string }[] = [];
  const walk = (a: Ast) => {
    if (a.kind !== "binary") return;
    if (a.op === "&&") {
      walk(a.left);
      walk(a.right);
    } else if (a.op === ">=" || a.op === ">") out.push({ measured: source(a.left), required: source(a.right) });
    else if (a.op === "<=" || a.op === "<") out.push({ measured: source(a.right), required: source(a.left) });
  };
  try {
    walk(parse(expr));
  } catch {
    // An expression that doesn't parse has no sides to read.
  }
  return out;
}

/** The parameters on the required side of a rule's comparisons, such as lp_clear in "inside >= lp_clear". */
export function requiredParams(design: Design, expr: string): string[] {
  const params = new Set(design.params.map((p) => p.name));
  return [...new Set(comparisons(expr).flatMap((c) => refsOf(c.required)))].filter((n) => params.has(n));
}

/**
 * Where a rule fails: once as written, and once for each array copy of the
 * parts it reads, so a rule on the first drawer holds for every drawer.
 * Empty when it holds everywhere.
 */
export function ruleFailures(design: Design, rule: Rule): string[] {
  const d = derived(design);
  const run = (expr: string, where: string): string[] => {
    try {
      const r = d.evaluate(expr);
      if (typeof r.value !== "boolean") return [`rule ${rule.id} gives a number`];
      return r.value ? [] : [`rule ${rule.id} fails${where}`];
    } catch (e) {
      return [`rule ${rule.id} can't be worked out: ${(e as Error).message}`];
    }
  };
  let refs: string[];
  try {
    refs = refsOf(rule.expr);
  } catch (e) {
    return [`rule ${rule.id} can't be read: ${(e as Error).message}`];
  }
  const arrayed = [...new Set(refs.filter((r) => r.includes(".") && !r.includes("#")).map((r) => r.split(".")[0]!))].filter((id) => d.byId.has(`${id}#2`));
  let copies = arrayed.length ? Infinity : 1;
  for (const id of arrayed) {
    let k = 2;
    while (d.byId.has(`${id}#${k + 1}`)) k++;
    copies = Math.min(copies, k);
  }
  const out = run(rule.expr, "");
  for (let k = 2; k <= copies; k++) {
    let expr = rule.expr;
    for (const id of arrayed) expr = expr.replace(new RegExp(`(?<![a-z0-9_#])${id}(?=\\.)`, "g"), `${id}#${k}`);
    out.push(...run(expr, ` on copy ${k}`));
  }
  return out;
}

/** Rules about LPs: by their id, message or expression. */
export function lpRules(design: Design): Rule[] {
  return design.rules.filter((r) => /(^|[^a-z])lps?([^a-z]|$)|record|vinyl|sleeve|album|12.?(inch|in\b|")/i.test(`${r.id} ${r.message} ${r.expr}`));
}

/** Rules about how much a shelf carries or sags. */
export function loadRules(design: Design): Rule[] {
  return design.rules.filter((r) => /sag|deflect|load|kg|weight|span|book/i.test(`${r.id} ${r.message} ${r.expr}`));
}

/**
 * Ways a rule was weakened between two versions: deleted, its expression
 * edited, an error made a warning, or a required parameter lowered or
 * deleted. Empty when the rule is as strong as it was.
 */
export function weakenings(before: Design, after: Design, ruleId: string): string[] {
  const r0 = before.rules.find((r) => r.id === ruleId);
  if (!r0) return [];
  const r1 = after.rules.find((r) => r.id === ruleId);
  const out: string[] = [];
  const plain = (s: string) => s.replace(/\s+/g, "");
  if (!r1) out.push(`rule ${ruleId} was deleted`);
  else {
    if (plain(r1.expr) !== plain(r0.expr)) out.push(`rule ${ruleId}'s expression changed`);
    if (r0.severity === "error" && r1.severity !== "error") out.push(`rule ${ruleId} became a warning`);
  }
  for (const name of requiredParams(before, r0.expr)) {
    const v0 = paramValue(before, name)!;
    const v1 = paramValue(after, name);
    if (v1 === undefined) out.push(`${name} was deleted`);
    else if (v1 < v0 - EPS) out.push(`${name} lowered from ${fmt(v0)} to ${fmt(v1)}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Claude's words

/** Millimetres in one of a unit: mm when there's none. */
function unitMm(unit: string | undefined): number {
  const u = (unit ?? "mm").toLowerCase();
  if (u.startsWith("c")) return 10;
  if (u === "m" || u.startsWith("met")) return 1000;
  return 1;
}

/**
 * Every length in a piece of text, in mm: "372 mm", "372mm", "372.0",
 * "37.2 cm" and "2,040" all count. A number with no unit is taken as mm.
 * Numbers inside ids, such as ply15 or part#2, are left out.
 */
export function lengthsIn(text: string): number[] {
  const out: number[] = [];
  const re = /(?<![\w.#])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:\s*(mm|millimet(?:re|er)s?|cm|centimet(?:re|er)s?|m|met(?:re|er)s?)(?![a-z]))?/gi;
  for (const m of text.matchAll(re)) {
    out.push(Number(m[1]!.replace(/,/g, "") + (m[2] ?? "")) * unitMm(m[3]));
  }
  return out;
}

/** Whether the text gives this length, to within tol mm. */
export function mentionsLength(text: string, mm: number, tol = 1): boolean {
  return lengthsIn(text).some((n) => Math.abs(n - mm) <= tol);
}

/** The numbers in a reply, for a failing reason. Numbers only, never words. */
const numbersOf = (text: string) => {
  const ns = lengthsIn(text).map(fmt);
  return ns.length ? `it gives ${list([...new Set(ns)], 6)}` : "it gives no numbers";
};

/**
 * Whether a reply says what changed: a changed parameter by name or new
 * value, a changed part by name, a new material thickness, or the new room
 * inside the first drawer.
 */
export function saysWhatChanged(before: Design, after: Design, reply: string): boolean {
  const lower = reply.toLowerCase();
  if (!lower.trim()) return false;
  const params = after.params.filter((p) => {
    const v0 = paramValue(before, p.name);
    const v1 = paramValue(after, p.name);
    return v1 !== undefined && (v0 === undefined || Math.abs(v1 - v0) > EPS);
  });
  const parts = geometryChanges(before, after).flatMap((c) => {
    const p = derived(after).byId.get(c.split(" ")[0]!) ?? derived(before).byId.get(c.split(" ")[0]!);
    return p ? [p.name.split(",")[0]!.trim(), p.source.replace(/_/g, " ")] : [];
  });
  const words = [...params.flatMap((p) => [p.name, p.name.replace(/_/g, " ")]), ...parts].map((w) => w.toLowerCase()).filter(Boolean);
  const thick = after.materials.filter((m) => before.materials.find((x) => x.id === m.id)?.thickness_mm !== m.thickness_mm).map((m) => m.thickness_mm);
  const exact = [...params.map((p) => paramValue(after, p.name)!), ...thick];
  const inside = drawerInsides(after)[0]?.width_mm;
  return (
    words.some((w) => lower.includes(w)) ||
    exact.some((v) => mentionsLength(reply, v, 0.05)) ||
    (inside != null && inside !== drawerInsides(before)[0]?.width_mm && mentionsLength(reply, inside))
  );
}

// ---------------------------------------------------------------------------
// Finishes

/** CIE lightness of a colour, from 0 for black to 100 for white. */
export function lightness(hex: string): number {
  const [r, g, b] = toLinear(hex);
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : (24389 / 27) * y;
}

/** Hue in degrees and saturation from 0 to 1. */
export function hueOf(hex: string): { hue_deg: number; saturation: number } {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const c = max - min;
  let h = 0;
  if (c > 0) {
    if (max === r) h = ((g - b) / c) % 6;
    else if (max === g) h = (b - r) / c + 2;
    else h = (r - g) / c + 4;
  }
  return { hue_deg: (h * 60 + 360) % 360, saturation: max ? c / max : 0 };
}

/** The darkest a finish can look and still count as light, and the lightest for dark. */
export const LIGHT_MIN = 65;
export const DARK_MAX = 45;
/** Browns run from red to orange-yellow. */
export const BROWN_HUE_MAX = 50;
export const BROWN_SATURATION_MIN = 0.1;

export interface FaceFinish {
  part: string;
  face: Face;
  finish: string | null;
  /** The timber it shows as, which sets the colour. */
  species: string;
}

/** The finish on every face of every real part. */
export function faceFinishes(design: Design): FaceFinish[] {
  const materials = new Map(design.materials.map((m) => [m.id, m]));
  return live(design)
    .filter((p) => !p.unverified)
    .flatMap((p) => FACES.map((face) => ({ part: p.id, face, finish: finishOn(design, p, face) ?? null, species: speciesOf(materials.get(p.material)).id })));
}

/** Every face oiled, in one colour from the cards, dark brown or light as asked. */
export function finishChecks(design: Design, tone: "dark-brown" | "light"): Check[] {
  const faces = faceFinishes(design);
  const bare = faces.filter((f) => !f.finish);
  const ids = [...new Set(faces.flatMap((f) => (f.finish ? [f.finish] : [])))];
  const known = ids.every((id) => lookupFinish(id));
  const out = [
    check(
      "every-face-finished",
      faces.length > 0 && bare.length === 0,
      faces.length ? `${bare.length} of ${faces.length} faces are bare, such as ${bare[0]?.part}.${bare[0]?.face}` : "there are no parts",
    ),
    check("one-finish", ids.length === 1 && known, ids.length ? `${ids.length} finishes: ${list(ids)}${known ? "" : ", not all on the cards"}` : "no finish anywhere"),
  ];
  const looks = [...new Set(faces.flatMap((f) => (f.finish ? [`${f.finish}|${f.species}`] : [])))].map((k) => {
    const [finish, species] = k.split("|") as [string, string];
    const colour = finishedColour(species, finish);
    return { finish, species, l: lightness(colour), ...hueOf(colour) };
  });
  if (!looks.length) return out;
  if (tone === "light") {
    const darkest = looks.reduce((a, b) => (b.l < a.l ? b : a));
    out.push(check("light", darkest.l >= LIGHT_MIN, `${darkest.finish} on ${darkest.species} has lightness ${fmt(darkest.l)}, under ${LIGHT_MIN}`));
  } else {
    const lightest = looks.reduce((a, b) => (b.l > a.l ? b : a));
    out.push(check("dark", lightest.l <= DARK_MAX, `${lightest.finish} on ${lightest.species} has lightness ${fmt(lightest.l)}, over ${DARK_MAX}`));
    const grey = looks.find((x) => x.hue_deg > BROWN_HUE_MAX || x.saturation < BROWN_SATURATION_MIN);
    out.push(check("walnut-brown", !grey, grey ? `${grey.finish} on ${grey.species} isn't a brown (hue ${fmt(grey.hue_deg)} degrees, saturation ${fmt(grey.saturation)})` : ""));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Checks shared by tasks

function noNewErrors(o: Outcome): Check {
  const added = newErrors(o.start, last(o));
  return check("no-new-errors", added.length === 0, `new errors: ${describeIssues(added)}`);
}

function noErrors(design: Design): Check {
  const found = errors(design);
  return check("no-errors", found.length === 0, `errors: ${describeIssues(found)}`);
}

function designUnchanged(o: Outcome): Check {
  const changed = designChanges(o.start, last(o));
  return check("design-unchanged", changed.length === 0, `changed ${list(changed)}`);
}

function drawersKept(o: Outcome): Check {
  const before = drawerFronts(o.start).length;
  const after = drawerFronts(last(o)).length;
  return check("drawers-kept", before === after, `${before} drawers became ${after}`);
}

/** Every drawer takes an LP sleeve across, and standing up. */
function lpsFit(design: Design): Check[] {
  const insides = drawerInsides(design);
  if (!insides.length) return [check("lps-fit-width", false, "no drawer front found"), check("lps-fit-height", false, "no drawer front found")];
  const narrow = insides.find((i) => i.width_mm === null || i.width_mm < LP_SLEEVE_MM - EPS);
  const low = insides.find((i) => i.height_mm === null || i.height_mm < LP_SLEEVE_MM - EPS);
  return [
    check(
      "lps-fit-width",
      !narrow,
      narrow?.width_mm === null ? `can't find both sides of ${narrow.front}` : `${narrow?.front} is ${fmt(narrow?.width_mm ?? 0)} mm inside, under an LP's ${LP_SLEEVE_MM} mm`,
    ),
    check(
      "lps-fit-height",
      !low,
      low?.height_mm === null ? `can't find the bottom of ${low.front}` : `${low?.front} has ${fmt(low?.height_mm ?? 0)} mm above its bottom, under an LP's ${LP_SLEEVE_MM} mm`,
    ),
  ];
}

/** The carcass sides: upright panels named side, not drawer parts. */
function carcassSides(design: Design): DerivedPart[] {
  return live(design).filter((p) => p.thickness_axis === "x" && !isDrawer(p) && named(p, /^(sides?|ends?|gables?|uprights?)$/));
}

/** The parameter a part's height is set by, when its size or top is a bare parameter name. */
function heightParam(design: Design, partId: string): string | undefined {
  const part = design.parts.find((p) => p.id === partId);
  const params = new Set(design.params.map((p) => p.name));
  const y = part?.y;
  const end = y?.end && "at" in y.end ? y.end.at.trim() : undefined;
  return [y?.size?.trim(), end].find((n): n is string => !!n && params.has(n));
}

// ---------------------------------------------------------------------------
// The tasks

/** The record console example, as the bench and the tests start it. */
export function consoleOps(): Op[] {
  return recordConsoleOps().filter((o) => o.op !== "rename_design");
}

const BUILD_TOP_MM = [2040, 520, 30];
const BUILD_PANEL_MM = 30;
const BUILD_HEIGHT_MM: [number, number] = [380, 440];
const BUILD_DRAWERS = 5;
const SHELF = { width_mm: 900, height_mm: 1800, thickness_mm: 18, depth_mm: 300, added: 2 };

export const QUALITY_TASKS: QualityTask[] = [
  {
    name: "height",
    start: "console",
    messages: ["Make the carcass 50 mm taller."],
    usd: [0.1, 0.4],
    checks(o) {
      const after = last(o);
      const rise = 50;
      const sides = carcassSides(o.start);
      const now = new Map(live(after).map((p) => [p.id, p]));
      const wrong = sides.find((p) => !now.has(p.id) || Math.abs(span(now.get(p.id)!, 1) - span(p, 1) - rise) > EPS);
      const e0 = extent(o.start);
      const e1 = extent(after);
      const driver = sides.map((p) => heightParam(o.start, p.source)).find((n) => n);
      const out = [
        check(
          "sides-50-taller",
          sides.length > 0 && !wrong,
          () =>
            !wrong
              ? "the start has no carcass sides"
              : now.has(wrong.id)
                ? `${wrong.id} went from ${fmt(span(wrong, 1))} to ${fmt(span(now.get(wrong.id)!, 1))} mm`
                : `${wrong.id} is gone`,
        ),
        check("overall-50-taller", Math.abs(e1.height_mm - e0.height_mm - rise) <= EPS, `overall height went from ${fmt(e0.height_mm)} to ${fmt(e1.height_mm)} mm`),
      ];
      if (driver) {
        const v0 = paramValue(o.start, driver) ?? NaN;
        const v1 = paramValue(after, driver) ?? NaN;
        out.push(check("height-param-moved", Math.abs(v1 - v0 - rise) <= EPS, `${driver} went from ${fmt(v0)} to ${fmt(v1)}`));
      }
      const footprint = Math.abs(e1.width_mm - e0.width_mm) <= EPS && Math.abs(e1.depth_mm - e0.depth_mm) <= EPS;
      out.push(check("footprint-kept", footprint, `${fmt(e0.width_mm)} x ${fmt(e0.depth_mm)} mm became ${fmt(e1.width_mm)} x ${fmt(e1.depth_mm)} mm`));
      out.push(drawersKept(o));
      const moved = o.start.params.filter((p) => {
        const was = literalValue(p.expr);
        if (p.name === driver || was === null) return false;
        const v = paramValue(after, p.name);
        return v === undefined || Math.abs(v - was) > EPS;
      });
      out.push(check("other-sizes-kept", moved.length === 0, `changed ${list(moved.map((p) => `${p.name} from ${p.expr} to ${paramValue(after, p.name) ?? "deleted"}`))}`));
      out.push(noNewErrors(o));
      return out;
    },
  },
  {
    name: "colour",
    start: "console",
    messages: ["Oil the whole console in a dark walnut colour."],
    usd: [0.1, 0.4],
    checks(o) {
      const after = last(o);
      const moved = geometryChanges(o.start, after);
      const timber = timberChanges(o.start, after);
      return [
        ...finishChecks(after, "dark-brown"),
        check("geometry-kept", moved.length === 0, list(moved)),
        check("timber-kept", timber.length === 0, list(timber)),
        noNewErrors(o),
      ];
    },
  },
  {
    name: "lp-fix",
    start: "console",
    messages: ["The LP check fails. Change the drawers so 12-inch LPs fit, and tell me what you changed."],
    usd: [0.2, 0.6],
    checks(o) {
      const after = last(o);
      const reply = o.replies.join("\n");
      const ruleId = "lp_fit";
      const weak = weakenings(o.start, after, ruleId);
      const rule = after.rules.find((r) => r.id === ruleId);
      const fails = rule ? ruleFailures(after, rule) : [`rule ${ruleId} is gone`];
      const e0 = extent(o.start);
      const e1 = extent(after);
      const widened = Math.abs(e1.width_mm - e0.width_mm) > EPS;
      return [
        check("not-weakened", weak.length === 0, `weakened the requirement: ${list(weak)}`),
        check("lp-fit-passes", fails.length === 0, list(fails)),
        ...lpsFit(after),
        drawersKept(o),
        check(
          "width-kept",
          !widened || mentionsLength(reply, e1.width_mm),
          `overall width went from ${fmt(e0.width_mm)} to ${fmt(e1.width_mm)} mm and the reply doesn't say so`,
        ),
        check("says-what-changed", saysWhatChanged(o.start, after, reply), reply.trim() ? "the reply names nothing that changed" : "no reply"),
        noNewErrors(o),
      ];
    },
  },
  {
    name: "build",
    start: "empty",
    messages: [
      "Build a long, low record console: a 2040 x 520 x 30 mm top, 30 mm carcass panels, about 400 mm tall, and one row of five drawers that hold 12 inch LPs.",
    ],
    usd: [0.5, 1.5],
    checks(o) {
      const after = last(o);
      const parts = live(after).filter((p) => !p.unverified);
      const want = [...BUILD_TOP_MM].sort((a, b) => b - a);
      const dims = (p: DerivedPart) => [span(p, 0), span(p, 1), span(p, 2)].sort((a, b) => b - a);
      const top = parts.find((p) => dims(p).every((v, i) => Math.abs(v - want[i]!) <= 0.5));
      const carcass = parts.filter(
        (p) =>
          p !== top &&
          !isDrawer(p) &&
          named(p, /^(sides?|partitions?|dividers?|bottoms?|base|carcass|uprights?|ends?|gables?)$/) &&
          !named(p, /^(back|plinth|kick|toe|legs?|foot|feet|rails?|stretchers?|cleats?|battens?|runners?|lips?|edg|nos|strips?|fac|tops?|shel)/),
      );
      const thin = carcass.find((p) => Math.abs(p.finished.thickness - BUILD_PANEL_MM) > EPS);
      const height = extent(after).height_mm;
      const fronts = drawerFronts(after);
      const rows = new Set(fronts.map((f) => Math.round(lo(f, 1))));
      const rules = lpRules(after);
      const fails = rules.flatMap((r) => ruleFailures(after, r));
      return [
        check("top-size", !!top, `no part is ${want.join(" x ")} mm`),
        check(
          "carcass-30",
          carcass.length >= 3 && !thin,
          thin ? `${thin.id} is ${fmt(thin.finished.thickness)} mm thick` : `found ${carcass.length} carcass panels: ${list(carcass.map((p) => p.id)) || "none"}`,
        ),
        check("height-in-range", height >= BUILD_HEIGHT_MM[0] - EPS && height <= BUILD_HEIGHT_MM[1] + EPS, `overall height is ${fmt(height)} mm`),
        check("five-drawers", fronts.length === BUILD_DRAWERS, `found ${fronts.length} drawer fronts`),
        check("one-row", fronts.length > 0 && [...rows].every((y) => Math.abs(y - [...rows][0]!) <= 1), `drawer fronts start at ${list([...rows].map(String))} mm`),
        check("lp-rule", rules.length > 0, "no rule holds the LP requirement"),
        check("lp-rule-passes", rules.length > 0 && fails.length === 0, rules.length ? list(fails) : "no LP rule to pass"),
        ...lpsFit(after),
        noErrors(after),
      ];
    },
  },
  {
    name: "question-bay",
    start: "console",
    messages: ["How wide is each drawer opening?"],
    usd: [0.05, 0.2],
    checks(o) {
      const reply = o.replies.join("\n");
      const bay = paramValue(o.start, "bay");
      return [
        check("answer-gives-bay", bay !== undefined && mentionsLength(reply, bay), bay === undefined ? "the start has no bay parameter" : `the reply doesn't give ${fmt(bay)} mm: ${numbersOf(reply)}`),
        designUnchanged(o),
      ];
    },
  },
  {
    name: "question-height",
    start: "console",
    messages: ["How tall is the whole console?"],
    usd: [0.05, 0.2],
    checks(o) {
      const reply = o.replies.join("\n");
      const height = extent(o.start).height_mm;
      return [check("answer-gives-height", mentionsLength(reply, height), `the reply doesn't give ${fmt(height)} mm: ${numbersOf(reply)}`), designUnchanged(o)];
    },
  },
  {
    name: "requirement-kept",
    start: "empty",
    messages: [
      "I want a bookshelf 900 mm wide and 1800 mm tall in 18 mm birch ply, and every shelf must take a 30 kg load of books without visible sag.",
      "Add two more shelves.",
      "Make it 300 deep.",
      "Oil it in a light colour.",
    ],
    usd: [0.8, 2.5],
    checks(o) {
      const after = last(o);
      const e = extent(after);
      const panels = live(after).filter(
        (p) => !p.unverified && named(p, /^(sides?|shel(f|ves)|tops?|bottoms?|dividers?|partitions?|uprights?|ends?|gables?|carcass)$/) && !named(p, /^(back|lips?|edg|nos|strips?|fac|stiffen|rails?|cleats?|battens?|plinth|kick|toe)/),
      );
      const materials = new Map(after.materials.map((m) => [m.id, m]));
      const off = panels.find((p) => Math.abs(p.finished.thickness - SHELF.thickness_mm) > EPS || speciesOf(materials.get(p.material)).id !== "birch_ply");
      const rules = loadRules(after);
      const missing = o.after.findIndex((d) => loadRules(d).length === 0);
      const fails = rules.flatMap((r) => ruleFailures(after, r).map((f) => ({ f, warning: r.severity === "warning" })));
      const flagged = /sag|deflect/i.test(o.replies.join("\n"));
      const shelves = o.after.map(shelfCount);
      const [first, added] = [shelves[0], shelves[1]];
      const end = shelves.at(-1);
      const grew = (k: "named" | "flat") => !!first && !!added && !!end && added[k] - first[k] === SHELF.added && end[k] === added[k];
      return [
        check("width-900", Math.abs(e.width_mm - SHELF.width_mm) <= 0.5, `overall width is ${fmt(e.width_mm)} mm`),
        check("height-1800", Math.abs(e.height_mm - SHELF.height_mm) <= 0.5, `overall height is ${fmt(e.height_mm)} mm`),
        check(
          "birch-ply-18",
          panels.length >= 3 && !off,
          off ? `${off.id} is ${fmt(off.finished.thickness)} mm ${speciesOf(materials.get(off.material)).id}` : `found ${panels.length} carcass panels and shelves`,
        ),
        check("load-rule", rules.length > 0, "no rule holds the 30 kg sag requirement"),
        check("load-rule-every-turn", missing < 0, `no load rule after message ${missing + 1}`),
        check("load-rule-passes", rules.length > 0 && fails.every((x) => x.warning && flagged), rules.length ? list(fails.map((x) => x.f)) : "no load rule to pass"),
        check(
          "two-more-shelves",
          grew("named") || grew("flat"),
          first && added && end ? `shelves went ${first.named} to ${added.named} to ${end.named}, flat panels ${first.flat} to ${added.flat} to ${end.flat}` : "a message is missing",
        ),
        check("depth-300", Math.abs(e.depth_mm - SHELF.depth_mm) <= 0.5, `overall depth is ${fmt(e.depth_mm)} mm`),
        ...finishChecks(after, "light"),
        noErrors(after),
      ];
    },
  },
];

/** A task's checks, with whether every turn finished first. A check that throws fails with its message. */
export function judge(task: QualityTask, o: Outcome): Check[] {
  let checks: Check[];
  try {
    checks = task.checks(o);
  } catch (e) {
    checks = [{ name: "checks-ran", ok: false, reason: `a check stopped: ${(e as Error).message}` }];
  }
  return [check("finished", !o.failed, "a turn ended in an error"), ...checks];
}

// ---------------------------------------------------------------------------
// Running a task against Claude

/** What Claude is told when it stops to ask, plan or suggest, so a task runs to the end. */
export const GO_AHEAD = "Yes, go ahead with what you suggest.";
export const MAX_GO_AHEADS = 3;

/**
 * The woodworker's go-ahead, the way the app's buttons give it: a waiting
 * preview is applied and a waiting plan approved before the reply goes in.
 */
export function goAhead(project: Project): string {
  let text = GO_AHEAD;
  const waiting = project.pending?.waiting ?? [];
  if (waiting.some((w) => w.kind === "preview")) {
    const preview = [...project.chat].reverse().find((c) => c.kind === "preview" && c.status === "proposed");
    if (preview?.kind === "preview") {
      try {
        project.change("claude", preview.title, preview.ops);
        preview.status = "applied";
        text += "\n\n(Applied as one change.)";
      } catch (e) {
        preview.status = "failed";
        preview.error = (e as Error).message;
        text += `\n\n(It couldn't be applied to the design as it is now: ${preview.error})`;
      }
    }
  }
  if (waiting.some((w) => w.kind === "plan") && project.design.plan) {
    project.change("you", "Approve the plan", [{ op: "set_plan_status", status: "approved" }]);
    // The reply itself tells Claude, so this isn't worth a note.
    project.notes.pop();
  }
  return text;
}

/** Claude's words in some chat lines: replies, questions, plans and previews. */
export function wordsIn(items: ChatItem[]): string {
  return items
    .flatMap((c) => {
      if (c.kind === "assistant") return [c.text];
      if (c.kind === "question") return [c.question, ...c.options];
      if (c.kind === "plan") return [c.plan.summary];
      if (c.kind === "preview") return [c.title, c.explanation];
      return [];
    })
    .join("\n");
}

export interface Tokens {
  input: number;
  cached: number;
  written: number;
  output: number;
}

export interface TaskUsage {
  secs: number;
  turns: number;
  rounds: number;
  tool_calls: number;
  /** Edits listed in apply_edits calls, each of which counts as one tool call. */
  edits: number;
  /** The levels the requests ran at, such as "low>high". */
  efforts: string;
  tokens: Tokens;
}

type Render = ConstructorParameters<typeof Turn>[3];

/**
 * Runs one task on a store that's only for it: each message is a turn, and
 * a turn that stops to wait gets a go-ahead, up to MAX_GO_AHEADS times.
 */
export async function runTask(task: QualityTask, store: Store, client: MessagesClient, render: Render): Promise<{ outcome: Outcome; usage: TaskUsage }> {
  const project = store.create(`Bench ${task.name}`, task.start === "console" ? consoleOps() : []);
  const start = structuredClone(project.design);
  const after: Design[] = [];
  const replies: string[] = [];
  const turn = (text: string) => new Turn(store, client, { chat() {}, delta() {}, changed() {} }, render).run({ text, selection: [] });
  for (const message of task.messages) {
    const seen = new Set(project.chat.map((c) => c.id));
    await turn(message);
    for (let i = 0; i < MAX_GO_AHEADS && project.pending?.waiting.length; i++) await turn(goAhead(project));
    after.push(structuredClone(project.design));
    replies.push(wordsIn(project.chat.filter((c) => !seen.has(c.id))));
  }
  const usages = project.chat.filter((c): c is Extract<ChatItem, { kind: "usage" }> => c.kind === "usage");
  const rounds = usages.flatMap((u) => u.rounds ?? []);
  const sum = (k: keyof Tokens) => usages.reduce((s, u) => s + (u[k] ?? 0), 0);
  return {
    outcome: { start, after, replies, failed: project.chat.some((c) => c.kind === "error" && !c.retry) },
    usage: {
      secs: usages.reduce((s, u) => s + (u.ms ?? 0), 0) / 1000,
      turns: usages.length,
      rounds: rounds.length,
      tool_calls: rounds.reduce((s, r) => s + r.calls, 0),
      edits: rounds.reduce((s, r) => s + (r.edits ?? 0), 0),
      efforts: effortPath(rounds.map((r) => r.effort)),
      tokens: { input: sum("input"), cached: sum("cached"), written: sum("written"), output: sum("output") },
    },
  };
}

// ---------------------------------------------------------------------------
// Cost

/**
 * Price per million tokens on Sonnet 5.5, in US dollars. Writing the cache
 * costs twice the input price for an hour's cache, and 1.25 times for five
 * minutes.
 */
export const PRICE = { input: 2, cached: 0.2, written_1h: 4, written_5m: 2.5, output: 10 };
/** The app's model list puts Opus 5.5 at about twice Sonnet 5.5, and Fable 5.1 at about five times. */
export const MODEL_SCALE: Record<string, number> = { "claude-sonnet-5-5": 1, "claude-opus-5-5": 2, "claude-fable-5-1": 5 };

export function costUsd(t: Tokens, model: string, ttl: "1h" | "5m"): number {
  const written = ttl === "1h" ? PRICE.written_1h : PRICE.written_5m;
  return ((t.input * PRICE.input + t.cached * PRICE.cached + t.written * written + t.output * PRICE.output) / 1e6) * (MODEL_SCALE[model] ?? 1);
}

/** The rough range a whole run costs, from each task's own estimate. */
export function estimateUsd(tasks: QualityTask[], repeat: number, configs: number, model: string): [number, number] {
  const scale = (MODEL_SCALE[model] ?? 1) * repeat * configs;
  return [tasks.reduce((s, t) => s + t.usd[0], 0) * scale, tasks.reduce((s, t) => s + t.usd[1], 0) * scale];
}

// ---------------------------------------------------------------------------
// Settings to compare

/** The effort the app runs at when WOODCHUCK_EFFORT is unset or unreadable. agent.ts has the same default. */
const DEFAULT_EFFORT: Effort = "high";

/**
 * The environment a named config changes, with null for a variable it
 * clears. current leaves the environment as it is. routing and no-routing
 * keep your WOODCHUCK_EFFORT. An effort's name runs every turn at that
 * level, and routing-<effort> lets turns pick up to it.
 */
export function configEnv(name: string): Record<string, string | null> | null {
  if (name === "current") return {};
  if (name === "routing") return { WOODCHUCK_EFFORT_ROUTING: null };
  if (name === "no-routing") return { WOODCHUCK_EFFORT_ROUTING: "off" };
  if (isEffort(name)) return { WOODCHUCK_EFFORT: name, WOODCHUCK_EFFORT_ROUTING: "off" };
  const up = /^routing-(.+)$/.exec(name)?.[1];
  if (isEffort(up)) return { WOODCHUCK_EFFORT: up, WOODCHUCK_EFFORT_ROUTING: null };
  return null;
}

/** The environment a config's run gets. */
export function envFor(name: string, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const [k, v] of Object.entries(configEnv(name) ?? {})) {
    if (v === null) delete env[k];
    else env[k] = v;
  }
  return env;
}

/** A config in a few words, such as "up to high, routed" or "medium on every turn". */
export function describeConfig(name: string, base: NodeJS.ProcessEnv): string {
  const env = envFor(name, base);
  const effort = isEffort(env.WOODCHUCK_EFFORT) ? env.WOODCHUCK_EFFORT : DEFAULT_EFFORT;
  return env.WOODCHUCK_EFFORT_ROUTING?.trim().toLowerCase() === "off" ? `${effort} on every turn` : `up to ${effort}, routed`;
}

// ---------------------------------------------------------------------------
// Arguments

export interface BenchArgs {
  live: boolean;
  /** A stand-in plays Claude: no key, no cost, and nothing changes. */
  dry: boolean;
  tasks: QualityTask[];
  repeat: number;
  configs: string[];
  /** Set in the process that runs one config. */
  child: string | null;
  /** Where that process writes its results, one JSON line a run. */
  out: string | null;
}

export const DEFAULT_REPEAT = 2;
export const MAX_REPEAT = 20;

export function parseBenchArgs(argv: string[]): BenchArgs | { error: string } {
  const args: BenchArgs = { live: false, dry: false, tasks: QUALITY_TASKS, repeat: DEFAULT_REPEAT, configs: ["current"], child: null, out: null };
  const names: string[] = [];
  const split = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const [flag, inline] = a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    const value = () => inline ?? argv[++i];
    if (flag === "--live") args.live = true;
    else if (flag === "--dry-run") args.dry = true;
    else if (flag === "--repeat") {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 1 || n > MAX_REPEAT) return { error: `--repeat takes a whole number from 1 to ${MAX_REPEAT}.` };
      args.repeat = n;
    } else if (flag === "--configs") args.configs = split(value() ?? "");
    else if (flag === "--tasks") names.push(...split(value() ?? ""));
    else if (flag === "--child") args.child = value() ?? null;
    else if (flag === "--out") args.out = value() ?? null;
    else if (flag.startsWith("--")) return { error: `There's no option called ${flag}.` };
    else names.push(a);
  }
  if (args.live && args.dry) return { error: "Pick one of --live and --dry-run." };
  const unknown = names.filter((n) => !QUALITY_TASKS.some((t) => t.name === n));
  if (unknown.length) return { error: `There's no task called ${unknown.join(", ")}. The tasks are ${QUALITY_TASKS.map((t) => t.name).join(", ")}.` };
  if (names.length) args.tasks = QUALITY_TASKS.filter((t) => names.includes(t.name));
  if (!args.configs.length) return { error: "--configs needs at least one config." };
  const bad = args.configs.filter((c) => !configEnv(c));
  if (bad.length) return { error: `There's no config called ${bad.join(", ")}. Use current, routing, no-routing, an effort such as medium, or routing-<effort>.` };
  if (new Set(args.configs).size !== args.configs.length) return { error: "Each config can be named once." };
  return args;
}

// ---------------------------------------------------------------------------
// Results

export interface RunResult extends TaskUsage {
  config: string;
  task: string;
  /** 1 for the first repeat. */
  run: number;
  passed: boolean;
  checks: Check[];
  usd: number;
}

export interface SummaryRow {
  config: string;
  task: string;
  runs: number;
  passed: number;
  /** How many runs failed each check. */
  failed: Record<string, number>;
  median_secs: number;
  median_rounds: number;
  median_usd: number;
  total_usd: number;
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** One row per config and task, in the order they first ran. */
export function summarise(runs: RunResult[]): SummaryRow[] {
  const groups = new Map<string, RunResult[]>();
  for (const r of runs) {
    const k = `${r.config}\u0000${r.task}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.values()].map((rs) => {
    const failed: Record<string, number> = {};
    for (const r of rs) for (const c of r.checks) if (!c.ok) failed[c.name] = (failed[c.name] ?? 0) + 1;
    return {
      config: rs[0]!.config,
      task: rs[0]!.task,
      runs: rs.length,
      passed: rs.filter((r) => r.passed).length,
      failed,
      median_secs: median(rs.map((r) => r.secs)),
      median_rounds: median(rs.map((r) => r.rounds)),
      median_usd: median(rs.map((r) => r.usd)),
      total_usd: rs.reduce((s, r) => s + r.usd, 0),
    };
  });
}

/** The table, as lines of text. */
export function formatTable(rows: SummaryRow[]): string[] {
  const header = ["config", "task", "passed", "failed checks", "secs", "rounds", "US$"];
  const cells = rows.map((r) => [
    r.config,
    r.task,
    `${r.passed}/${r.runs}`,
    Object.entries(r.failed)
      .map(([name, n]) => `${name} ${n}`)
      .join(", ") || "-",
    r.median_secs.toFixed(1),
    String(r.median_rounds),
    r.median_usd.toFixed(2),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i]!.length)));
  const line = (c: string[]) => c.map((v, i) => v.padEnd(widths[i]!)).join("  ").trimEnd();
  return [line(header), ...cells.map(line)];
}

/** One line on how a config did. */
export function verdict(config: string, rows: SummaryRow[]): string {
  const mine = rows.filter((r) => r.config === config);
  const runs = mine.reduce((s, r) => s + r.runs, 0);
  const passed = mine.reduce((s, r) => s + r.passed, 0);
  const spent = `US$${mine.reduce((s, r) => s + r.total_usd, 0).toFixed(2)}`;
  if (runs > 0 && passed === runs) return `${config}: all quality checks passed in ${passed}/${runs} runs, ${spent}.`;
  const failing = mine.flatMap((r) => Object.entries(r.failed).map(([name, n]) => `${r.task} ${name} ${n}/${r.runs}`));
  return `${config}: ${passed}/${runs} runs passed, ${spent}. Failed ${failing.join(", ")}.`;
}
