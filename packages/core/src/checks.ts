// Checks that run after every change. Each one is a woodworking rule or a
// rule from the design itself, and each problem names the parts involved.
//
// A part with cuts is checked as its true solid: its outline and holes
// carried through its thickness, with each housing's tongue. Every other
// part is its box, and the box checks run first, so a design with no cuts
// is checked exactly as a set of boxes.

import { AXIS_INDEX, type Box, type DeriveResult, type DeriveIssue, type DerivedPart } from "./derive.js";
import { roundCut } from "./cutlist.js";
import { fmt, gapPartsOf, refsOf } from "./expr.js";
import { fitsLengths, fitsSheet, materialStock, stockSettings } from "./layout.js";
import { JOINT_LIBRARY } from "./joints.js";
import { partPrism } from "./profile.js";
import { prismGap, prismsOverlap, rectLoop, uncutStretches, type Prism } from "./shape.js";
import { AXES, FACE_AXIS, FACE_IS_MAX, FACES, type Design, type Face } from "./types.js";
import { parseFinishTarget } from "./finishes.js";

export interface Issue extends DeriveIssue {
  /** Stable key, so a change can report which problems it fixed or caused. */
  key: string;
}

export interface CheckReport {
  issues: Issue[];
  errors: number;
  warnings: number;
  /** No errors and no unverified parts. */
  ready_to_cut: boolean;
}

const EPS = 0.01;
const TOUCH = 0.05;

function overlapLen(a: Box, b: Box, i: number): number {
  return Math.min(a.max[i]!, b.max[i]!) - Math.max(a.min[i]!, b.min[i]!);
}

function boxesOverlap(a: Box, b: Box): boolean {
  return [0, 1, 2].every((i) => overlapLen(a, b, i) > EPS);
}

function boxesTouch(a: Box, b: Box): boolean {
  for (let i = 0; i < 3; i++) {
    const others = [0, 1, 2].filter((j) => j !== i);
    if (!others.every((j) => overlapLen(a, b, j) > EPS)) continue;
    if (Math.abs(a.max[i]! - b.min[i]!) < TOUCH || Math.abs(a.min[i]! - b.max[i]!) < TOUCH) return true;
  }
  return false;
}

function within(inner: Box, outer: Box): boolean {
  return [0, 1, 2].every((i) => inner.min[i]! >= outer.min[i]! - EPS && inner.max[i]! <= outer.max[i]! + EPS);
}

function intersect(a: Box, b: Box): Box {
  return {
    min: [0, 1, 2].map((i) => Math.max(a.min[i]!, b.min[i]!)) as Box["min"],
    max: [0, 1, 2].map((i) => Math.min(a.max[i]!, b.max[i]!)) as Box["max"],
  };
}

/** Problems that can come more than once for the same parts, so their words tell them apart. */
const KEYED_BY_MESSAGE = new Set(["rule_failed", "rule_error", "rule_reads_cut_face"]);

function keyOf(i: DeriveIssue): string {
  return `${i.code}:${[...i.parts].sort().join(",")}:${KEYED_BY_MESSAGE.has(i.code) ? i.message : ""}`;
}

/** A hardware model's box as a solid, for comparing with a part's. */
const boxPrism = (b: Box): Prism => ({ u: "x", v: "y", loops: [rectLoop([b.min[0], b.min[1]], [b.max[0], b.max[1]])], t_mm: [b.min[2], b.max[2]] });

/** How far two overlapping solids run into each other along each axis, at most, as "a × b × c". */
const overlapSize = (a: Prism, b: Prism) => AXES.map((x) => fmt(-(prismGap(a, b, x) ?? 0))).join(" × ");

/** A face as the blank reads it, for a rule's warning. */
const BLANK_FACE: Record<Face, string> = {
  top: "its highest point",
  bottom: "its lowest point",
  left: "its leftmost point",
  right: "its rightmost point",
  back: "the point furthest back",
  front: "the point furthest forward",
};

export function runChecks(design: Design, d: DeriveResult): CheckReport {
  const out: DeriveIssue[] = [...d.issues];
  const live = d.parts.filter((p) => !p.broken);

  // Each joint's own checks, from the joint library.
  for (const j of d.joints) {
    for (const prob of j.problems) {
      out.push({
        severity: prob.severity,
        code: "joint_check",
        message: `${j.id} (${JOINT_LIBRARY[j.type].name.toLowerCase()} joining ${j.guest} to ${j.host}): ${prob.message}`,
        parts: [j.host, j.guest],
      });
    }
  }

  // Overlaps that no joint explains.
  const explained = new Map<string, Box[]>();
  for (const j of d.joints) {
    if (!j.allowed) continue;
    const k = [j.host, j.guest].sort().join("|");
    explained.set(k, [...(explained.get(k) ?? []), j.allowed]);
  }
  // A part with cuts is its solid as you cut it, so the checks below see the wood that's really there.
  const solids = new Map<string, Prism>();
  const solidOf = (p: DerivedPart) => {
    let s = solids.get(p.id);
    if (!s) solids.set(p.id, (s = partPrism(p, "cut")));
    return s;
  };
  for (let a = 0; a < live.length; a++) {
    for (let b = a + 1; b < live.length; b++) {
      const pa = live[a]!;
      const pb = live[b]!;
      if (!boxesOverlap(pa.box, pb.box)) continue;
      const overlap = intersect(pa.box, pb.box);
      const regions = explained.get([pa.id, pb.id].sort().join("|")) ?? [];
      if (regions.some((r) => within(overlap, r))) continue;
      let size = [0, 1, 2].map((i) => fmt(overlap.max[i]! - overlap.min[i]!)).join(" × ");
      let by = "by";
      if (pa.profile || pb.profile) {
        if (!prismsOverlap(solidOf(pa), solidOf(pb), EPS)) continue;
        size = overlapSize(solidOf(pa), solidOf(pb));
        by = "by up to";
      }
      out.push({
        severity: pa.decor || pb.decor ? "warning" : "error",
        code: "overlap",
        message: `${pa.id} and ${pb.id} overlap ${by} ${size} mm and no joint explains it`,
        parts: [pa.id, pb.id],
      });
    }
  }

  // Hardware models must fit the space left for them.
  for (const h of d.hardware) {
    for (const hb of h.boxes) {
      for (const p of live) {
        if (p.decor || !boxesOverlap(hb, p.box)) continue;
        const overlap = intersect(hb, p.box);
        let size = [0, 1, 2].map((i) => fmt(overlap.max[i]! - overlap.min[i]!)).join(" × ");
        let by = "by";
        if (p.profile) {
          if (!prismsOverlap(boxPrism(hb), solidOf(p), EPS)) continue;
          size = overlapSize(boxPrism(hb), solidOf(p));
          by = "by up to";
        }
        out.push({
          severity: "error",
          code: "hardware_overlap",
          message: `${h.name} (${h.id}) runs into ${p.id} ${by} ${size} mm. Check the gap left for it`,
          parts: [p.id],
        });
      }
    }
  }

  // Every part must be held up by something that reaches the floor.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const union = (x: string, y: string) => {
    if (!parent.has(x) || !parent.has(y)) return;
    parent.set(find(x), find(y));
  };
  for (const p of live) parent.set(p.id, p.id);
  // Two solids touch or overlap when, along some axis, they come within TOUCH of each other where they line up.
  const solidsMeet = (pa: DerivedPart, pb: DerivedPart) =>
    AXES.some((x) => {
      const g = prismGap(solidOf(pa), solidOf(pb), x, EPS);
      return g !== null && g < TOUCH;
    });
  for (let a = 0; a < live.length; a++) {
    for (let b = a + 1; b < live.length; b++) {
      const [pa, pb] = [live[a]!, live[b]!];
      if (!(boxesTouch(pa.box, pb.box) || boxesOverlap(pa.box, pb.box))) continue;
      if ((pa.profile || pb.profile) && !solidsMeet(pa, pb)) continue;
      union(pa.id, pb.id);
    }
  }
  for (const j of d.joints) union(j.host, j.guest);
  for (const h of d.hardware) for (let i = 1; i < h.connects.length; i++) union(h.connects[0]!, h.connects[i]!);
  const grounded = new Set<string>();
  // The lowest point of a part with cuts is the lowest its shape reaches.
  const lowest = (p: DerivedPart) => {
    if (!p.profile) return p.box.min[1];
    const s = solidOf(p);
    if (s.u !== "y" && s.v !== "y") return s.t_mm[0];
    const i = s.u === "y" ? 0 : 1;
    return Math.min(...s.loops.flatMap((l) => l.map((q) => q[i])));
  };
  for (const p of live) {
    if (lowest(p) <= TOUCH || p.tags.includes("wall_mounted") || p.tags.includes("fixed")) grounded.add(find(p.id));
  }
  // Castors, levellers and feet stand on the floor for the parts they hold.
  for (const h of d.hardware) {
    const onFloor = h.on_floor || h.boxes.some((b) => b.min[1] <= TOUCH);
    if (onFloor && h.connects[0] && parent.has(h.connects[0])) grounded.add(find(h.connects[0]));
  }
  const floating = new Map<string, DerivedPart[]>();
  for (const p of live) {
    const root = find(p.id);
    if (grounded.has(root)) continue;
    floating.set(root, [...(floating.get(root) ?? []), p]);
  }
  for (const group of floating.values()) {
    const ids = group.map((p) => p.id);
    const shown = ids.slice(0, 8).join(", ") + (ids.length > 8 ? ` and ${ids.length - 8} more` : "");
    out.push({
      severity: "warning",
      code: "floating",
      message: `Nothing holds up ${shown}. Join ${ids.length === 1 ? "it" : "them"} to the rest with a joint or hardware, or tag a part wall_mounted`,
      parts: ids,
    });
  }

  // Stock sizes. A part the cutting layout can't place is flagged here, using
  // the stock the layout uses: the design's own sheet sizes and lengths, then
  // the material's, then the defaults.
  const materials = new Map(design.materials.map((m) => [m.id, m]));
  const { trim_mm } = stockSettings(design);
  for (const p of live) {
    if (p.decor || p.unverified) continue;
    const m = materials.get(p.material);
    if (!m) continue;
    // The cut list rounds to 0.1 mm, and the layout works from its rows.
    const L = roundCut(p.cut.length);
    const W = roundCut(p.cut.width);
    const stock = materialStock(design, m);
    if (stock.sheet_mm && !fitsSheet(m.grained, L, W, stock.sheet_mm, trim_mm)) {
      const [sl, sw] = stock.sheet_mm;
      out.push({
        severity: "warning",
        code: "stock_too_small",
        message: `${p.id} (${fmt(L)} × ${fmt(W)} mm) doesn't fit a ${fmt(sl)} × ${fmt(sw)} mm ${m.name} sheet inside its ${fmt(trim_mm)} mm trim${m.grained ? " with the grain running along its length" : ""}`,
        parts: [p.id],
      });
    }
    if (stock.lengths_mm && !fitsLengths(L, stock.lengths_mm)) {
      const longest = Math.max(...stock.lengths_mm);
      out.push({
        severity: "warning",
        code: "stock_too_small",
        message: `${p.id} is ${fmt(L)} mm long, but the longest ${m.name} length is ${fmt(longest)} mm. Join two lengths, or add a longer stock length`,
        parts: [p.id],
      });
    }
    if (m.board_max_width_mm !== undefined && W > m.board_max_width_mm + EPS) {
      out.push({
        severity: "warning",
        code: "stock_too_small",
        message: `${p.id} is ${fmt(W)} mm wide, but the widest ${m.name} board is ${fmt(m.board_max_width_mm)} mm. It needs a glue-up`,
        parts: [p.id],
      });
    }
  }

  // A finish on an array copy that no longer exists does nothing.
  const ids = new Set(d.parts.map((p) => p.id));
  for (const target of Object.keys(design.finishes ?? {})) {
    const t = parseFinishTarget(target);
    if (!t || t.kind === "material" || ids.has(t.part) || ids.has(t.part.replace(/#1$/, ""))) continue;
    out.push({
      severity: "warning",
      code: "finish_target",
      message: `The finish on ${target} has nothing to go on, because there's no ${t.part} any more. Clear it or set it again`,
      parts: [],
    });
  }

  // The design's own rules.
  for (const rule of design.rules) {
    try {
      const r = d.evaluate(rule.expr);
      if (typeof r.value !== "boolean") {
        out.push({ severity: "error", code: "rule_error", message: `Rule ${rule.id} must be true or false, but it gives a number`, parts: [], trace: r.text });
      } else if (!r.value) {
        out.push({
          severity: rule.severity,
          code: "rule_failed",
          // Plain words first. The rule's id comes after, for finding it again.
          message: `${rule.message} (rule ${rule.id})`,
          parts: partsIn(rule.expr),
          trace: r.text,
        });
      }
    } catch (e) {
      out.push({ severity: "error", code: "rule_error", message: `Rule ${rule.id}: ${(e as Error).message}`, parts: [] });
    }
    out.push(...cutFacesRead(d, rule.id, rule.expr));
  }

  const unverified = live.filter((p) => p.unverified);
  if (unverified.length) {
    out.push({
      severity: "warning",
      code: "unverified_present",
      message: `${unverified.length} unverified part${unverified.length === 1 ? "" : "s"} (${unverified.map((p) => p.id).join(", ")}). Replace them with real parts before cutting`,
      parts: unverified.map((p) => p.id),
    });
  }

  const issues: Issue[] = [];
  const seen = new Set<string>();
  for (const i of out) {
    const key = keyOf(i);
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push({ ...i, key });
  }
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.length - errors;
  const cuttable = live.some((p) => !p.decor && !p.unverified);
  return { issues, errors, warnings, ready_to_cut: cuttable && errors === 0 && unverified.length === 0 };
}

function partsIn(expr: string): string[] {
  const out = new Set<string>();
  for (const m of expr.matchAll(/([a-z][a-z0-9_]*(?:#\d+)?)\.[a-z_]+/g)) out.add(m[1]!);
  try {
    for (const p of gapPartsOf(expr)) out.add(p);
  } catch {
    // A rule that doesn't parse names no parts to measure between.
  }
  return [...out];
}

/**
 * A warning for each face a rule reads that a cut has taken wood from. The
 * face still means the blank's, so on a sloped top it reads the highest
 * point, and the rule may not see the wood the cut took.
 */
function cutFacesRead(d: DeriveResult, ruleId: string, expr: string): DeriveIssue[] {
  let refs: string[];
  try {
    refs = refsOf(expr);
  } catch {
    return [];
  }
  const out: DeriveIssue[] = [];
  for (const ref of refs) {
    const dot = ref.lastIndexOf(".");
    if (dot < 0) continue;
    const id = ref.slice(0, dot);
    const face = ref.slice(dot + 1) as Face;
    if (!(FACES as readonly string[]).includes(face)) continue;
    const p = d.byId.get(id);
    const pr = p?.profile;
    if (!p || !pr || FACE_AXIS[face] === p.thickness_axis) continue;
    // The face's line on the blank, and how much of it the outline still runs along.
    const i: 0 | 1 = FACE_AXIS[face] === pr.u ? 0 : 1;
    const size = (a: typeof pr.u) => p.nominal.max[AXIS_INDEX[a]] - p.nominal.min[AXIS_INDEX[a]];
    const along = size(i === 0 ? pr.v : pr.u);
    const kept = uncutStretches([pr.outline_mm], i, FACE_IS_MAX[face] ? size(FACE_AXIS[face]) : 0, 0, along).reduce((n, [a, b]) => n + b - a, 0);
    if (kept >= along - EPS) continue;
    const cuts = pr.cuts.filter((c) => c.faces?.includes(face)).map((c) => c.id);
    const who = cuts.length > 1 ? `cuts ${cuts.slice(0, -1).join(", ")} and ${cuts[cuts.length - 1]} take` : cuts.length ? `cut ${cuts[0]} takes` : "a cut takes";
    const edge = FACE_AXIS[face] === p.grain_axis ? "end" : "edge";
    out.push({
      severity: "warning",
      code: "rule_reads_cut_face",
      message: `Rule ${ruleId} reads ${ref}, and ${who} wood off that ${edge}. ${ref} still means the blank's ${face}, ${BLANK_FACE[face]} before any cut, so the rule may not see what the cut took. To measure to the shape, use gap_${FACE_AXIS[face]}`,
      parts: [id],
    });
  }
  return out;
}
