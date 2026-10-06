// Wooden drawer runners. A part tagged runner is one a drawer slides on: a
// timber strip fixed to the carcass side, or a shelf. It's an ordinary part,
// so it's on the cut list as timber, and a drawer on runners needs no
// hardware.
//
// A part rides a runner when it rests on the runner's top with no joint
// between them, or when a housing in it, such as a groove in a drawer side,
// holds the runner. A part joined to what it rests on is fixed there, which
// is right for a partition on a shelf. A runner with only fixed parts on it
// is an error, since its drawer can't open. The parts joined to a rider,
// through any joint that doesn't go through a runner, are its drawer. A
// drawer slides front to back, so it needs running clearance across that,
// beside it and over and under it, from every part but the runners it rides.
// With no part tagged runner, nothing here runs.

import type { DeriveIssue, DeriveResult, DerivedPart } from "./derive.js";
import { fmt } from "./expr.js";
import { prismGap, type Prism } from "./shape.js";

export const RUNNER_TAG = "runner";
/** The least clear space a drawer on runners needs, and the least a runner's groove is wider than the runner. */
export const RUNNING_CLEARANCE_MM = 0.5;

const EPS = 0.01;
const TOUCH = 0.05;
/** The axes across a drawer's travel, which runs along z. */
const ACROSS = ["x", "y"] as const;
const INDEX = { x: 0, y: 1, z: 2 } as const;

export const isRunner = (p: { tags: string[] }) => p.tags.includes(RUNNER_TAG);

/** "a", "a and b", "a, b and c". */
function listed(ids: string[]): string {
  return ids.length < 2 ? (ids[0] ?? "") : `${ids.slice(0, -1).join(", ")} and ${ids[ids.length - 1]}`;
}

/**
 * The clear space between two parts along an axis, where they line up across
 * it. Negative is an overlap, and null means they don't line up.
 */
function gapAlong(a: DerivedPart, b: DerivedPart, axis: "x" | "y", solidOf: (p: DerivedPart) => Prism): number | null {
  if (a.profile || b.profile) return prismGap(solidOf(a), solidOf(b), axis, EPS);
  const i = INDEX[axis];
  for (const j of [0, 1, 2]) {
    if (j === i) continue;
    if (Math.min(a.box.max[j]!, b.box.max[j]!) - Math.max(a.box.min[j]!, b.box.min[j]!) <= EPS) return null;
  }
  return Math.max(b.box.min[i]! - a.box.max[i]!, a.box.min[i]! - b.box.max[i]!);
}

const middle = (p: DerivedPart) => (p.box.min[1] + p.box.max[1]) / 2;

/**
 * What the checks say about runners: one that nothing slides on, a groove
 * that holds its runner tight, and a drawer short of running clearance.
 */
export function runnerChecks(d: DeriveResult, solidOf: (p: DerivedPart) => Prism): DeriveIssue[] {
  const live = d.parts.filter((p) => !p.broken && !p.decor);
  const runners = live.filter(isRunner);
  if (!runners.length) return [];
  const out: DeriveIssue[] = [];

  // Each drawer is the parts its joints hold together, apart from runners.
  const parent = new Map(live.filter((p) => !isRunner(p)).map((p) => [p.id, p.id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const j of d.joints) if (parent.has(j.host) && parent.has(j.guest)) parent.set(find(j.host), find(j.guest));
  const joined = (a: string, b: string) => d.joints.filter((j) => (j.host === a && j.guest === b) || (j.host === b && j.guest === a));

  // The runners each drawer rides, by the drawer's root part.
  const rides = new Map<string, Set<string>>();
  for (const r of runners) {
    const riders = new Set<string>();
    for (const j of d.joints) {
      if (j.guest !== r.id || j.family !== "housing" || !parent.has(j.host)) continue;
      riders.add(j.host);
      const fit = j.params.fit ?? 0;
      if (fit < RUNNING_CLEARANCE_MM - EPS) {
        out.push({
          severity: "warning",
          code: "runner_fit",
          message: `The ${j.type} for runner ${r.id} in ${j.host} (${j.id}) is only ${fmt(fit)} mm wider than the runner, so the drawer will bind. Give it a fit of 0.5 to 1 mm`,
          parts: [j.host, r.id],
        });
      }
    }
    // What rests on it with a joint is fixed there. On a shelf that's a partition, and on a strip it's a mistake.
    const fixed: { id: string; joints: string[] }[] = [];
    for (const p of live) {
      if (!parent.has(p.id) || riders.has(p.id) || middle(p) <= middle(r)) continue;
      const g = gapAlong(r, p, "y", solidOf);
      if (g === null || Math.abs(g) >= TOUCH) continue;
      const fixings = joined(p.id, r.id).map((j) => j.id);
      if (fixings.length) fixed.push({ id: p.id, joints: fixings });
      else riders.add(p.id);
    }
    if (!riders.size) {
      const [first] = fixed;
      out.push(
        first
          ? {
              severity: "error",
              code: "runner_fixed",
              message: `${first.id} is joined to runner ${r.id} by ${listed(first.joints)}, so it can't slide on it. A drawer rests on its runner with no joint, so take the joint off`,
              parts: [first.id, r.id],
            }
          : {
              severity: "warning",
              code: "runner_idle",
              message: `Nothing slides on runner ${r.id}. Rest a drawer side's bottom edge on its top, or hold the runner in a groove in the drawer side`,
              parts: [r.id],
            },
      );
      continue;
    }
    for (const id of riders) {
      const root = find(id);
      rides.set(root, (rides.get(root) ?? new Set()).add(r.id));
    }
  }

  // Each drawer needs running clearance from every part it doesn't ride.
  for (const [root, on] of rides) {
    const drawer = live.filter((p) => parent.has(p.id) && find(p.id) === root);
    const ids = new Set(drawer.map((p) => p.id));
    const runnersOf = listed([...on].sort());
    for (const m of drawer) {
      for (const f of live) {
        if (ids.has(f.id) || on.has(f.id)) continue;
        for (const axis of ACROSS) {
          const g = gapAlong(m, f, axis, solidOf);
          // An overlap is the overlap check's to report.
          if (g === null || g < -EPS || g >= RUNNING_CLEARANCE_MM - EPS) continue;
          const where = axis === "x" ? "beside it" : middle(f) > middle(m) ? "over it" : "under it";
          out.push(
            g < TOUCH
              ? {
                  severity: "error",
                  code: "runner_clearance",
                  message: `${m.id} touches ${f.id} ${where}, so the drawer on ${runnersOf} can't slide. Leave 0.5 to 1 mm running clearance`,
                  parts: [m.id, f.id],
                }
              : {
                  severity: "warning",
                  code: "runner_clearance",
                  message: `${m.id} has ${fmt(Math.round(g * 100) / 100)} mm running clearance to ${f.id} ${where}, so the drawer on ${runnersOf} will bind when the timber swells. Leave 0.5 to 1 mm`,
                  parts: [m.id, f.id],
                },
          );
        }
      }
    }
  }
  return out;
}
