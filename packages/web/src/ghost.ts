// A change Claude suggests, drawn on the model itself. The change is worked
// out against the design as it is now. While Claude waits on it, the main
// model shows it as a ghost: the parts it moves fade where they are, their
// new places show in see-through pink with an outline, and each move carries
// its size, such as "+40 mm". "With the change" flips the model to the
// design as it would be, with the changed parts outlined. Nothing is applied
// until you click Apply. The phone layout draws the same ghost. Kept free of
// React and three.js so the tests can hold it.

import { applyOps, derive, diffDesigns, fmt, runChecks, type Box, type CheckReport, type Derived, type DerivedPart, type Design, type Op } from "@woodchuck/core";
import type { ChatItem, ServerState } from "./api";
import { waitingMoments } from "./waiting";

export type PreviewItem = Extract<ChatItem, { kind: "preview" }>;

/** A suggested change, worked out against the design as it is now. */
export interface PreviewResult {
  proposed: Design;
  after: Derived;
  report: CheckReport;
  /** In names, such as "Book shelf height from 100 to 140 mm". */
  changes: string[];
  /** Parts in both designs whose box moves or changes size. */
  changed: string[];
  /** Parts only the change has. */
  added: string[];
  /** Parts the change takes away. */
  removed: string[];
  /** Problems the change brings, and the ones it fixes. */
  newProblems: string[];
  fixes: string[];
  /** A change of colour or timber, which only shows in the Finished look. */
  aboutFinish: boolean;
}

/** Boxes this close, in millimetres, are the same box. */
const SAME_MM = 0.05;

const sameBox = (a: Box, b: Box) => [0, 1, 2].every((i) => Math.abs(a.min[i]! - b.min[i]!) < SAME_MM && Math.abs(a.max[i]! - b.max[i]!) < SAME_MM);

const drawn = (parts: DerivedPart[]) => parts.filter((p) => !p.broken);

/** The change worked out on a copy of the design, or why it no longer fits. */
export function previewChange(now: Pick<ServerState, "design" | "derived" | "report">, ops: Op[]): PreviewResult | { error: string } {
  try {
    const proposed = applyOps(now.design, ops);
    const after = derive(proposed);
    const report = runChecks(proposed, after);
    const before = new Map(drawn(now.derived.parts).map((p) => [p.id, p]));
    const later = new Set(after.parts.filter((p) => !p.broken).map((p) => p.id));
    const oldKeys = new Set(now.report.issues.map((i) => i.key));
    const newKeys = new Set(report.issues.map((i) => i.key));
    const changed: string[] = [];
    const added: string[] = [];
    for (const p of drawn(after.parts)) {
      const was = before.get(p.id);
      if (!was) added.push(p.id);
      else if (!sameBox(was.nominal, p.nominal)) changed.push(p.id);
    }
    return {
      proposed,
      after,
      report,
      changes: diffDesigns(now.design, proposed, { names: true }),
      changed,
      added,
      removed: [...before.keys()].filter((id) => !later.has(id)),
      newProblems: report.issues.filter((i) => !oldKeys.has(i.key)).map((i) => i.message),
      fixes: now.report.issues.filter((i) => !newKeys.has(i.key)).map((i) => i.message),
      aboutFinish: ops.some((o) => o.op === "set_finish" || (o.op === "define_material" && "species" in o && o.species !== undefined)),
    };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export type Vec = [number, number, number];

/** A part's place with the change, drawn see-through over the model. */
export interface GhostPart {
  id: string;
  box: Box;
  /** A part the change adds, rather than one it moves. */
  added: boolean;
}

/** A dimension on the ghost: how far a group of parts moves, or how much it grows, along one axis. */
export interface MoveMark {
  axis: 0 | 1 | 2;
  kind: "move" | "size";
  /** Signed, in millimetres. */
  amount: number;
  /** The words on the model, such as "+40 mm". */
  label: string;
  /** In a sentence, for the tooltip, such as "14 parts move up 40 mm". */
  words: string;
  /** The dimension line, from the old edge to the new one, set a little off the parts. */
  from: Vec;
  to: Vec;
  /** Half a tick at each end of the line, across it. */
  tick: Vec;
  parts: string[];
}

export interface Ghost {
  parts: GhostPart[];
  /** Parts of the model as it is that the change moves or takes away, drawn faded. */
  faded: string[];
  marks: MoveMark[];
}

/** No more dimensions than this on one ghost, so the model stays readable. */
export const MAX_MARKS = 6;

const DIRECTION: Record<0 | 1 | 2, [string, string]> = { 0: ["right", "left"], 1: ["up", "down"], 2: ["forward", "back"] };

/** A length with its sign, such as "+40 mm" or "−12.5 mm". */
export const signed = (mm: number) => `${mm > 0 ? "+" : "−"}${fmt(Math.abs(mm))} mm`;

const r = (v: number) => Math.round(v * 10) / 10;

function union(boxes: Box[]): Box {
  return {
    min: [0, 1, 2].map((i) => Math.min(...boxes.map((b) => b.min[i]!))) as Vec,
    max: [0, 1, 2].map((i) => Math.max(...boxes.map((b) => b.max[i]!))) as Vec,
  };
}

/**
 * The ghost of a change: where each changed or new part goes, which parts
 * of the model fade, and a dimension for each group of parts that moves or
 * grows by the same amount. names reads a part's name for the tooltips.
 */
export function ghostOf(before: DerivedPart[], after: DerivedPart[], names: (id: string) => string = (id) => id): Ghost {
  const old = new Map(drawn(before).map((p) => [p.id, p]));
  const later = drawn(after);
  const now = new Set(later.map((p) => p.id));
  const parts: GhostPart[] = [];
  const pairs: [DerivedPart, DerivedPart][] = [];
  for (const p of later) {
    const was = old.get(p.id);
    if (!was) parts.push({ id: p.id, box: p.nominal, added: true });
    else if (!sameBox(was.nominal, p.nominal)) {
      parts.push({ id: p.id, box: p.nominal, added: false });
      pairs.push([was, p]);
    }
  }
  const faded = [...pairs.map(([, p]) => p.id), ...[...old.keys()].filter((id) => !now.has(id))];

  // Group the parts that move or grow by the same amount along an axis.
  const groups = new Map<string, { axis: 0 | 1 | 2; dmin: number; dmax: number; pairs: [DerivedPart, DerivedPart][] }>();
  for (const [was, p] of pairs) {
    for (const axis of [0, 1, 2] as const) {
      const dmin = p.nominal.min[axis]! - was.nominal.min[axis]!;
      const dmax = p.nominal.max[axis]! - was.nominal.max[axis]!;
      if (Math.abs(dmin) < SAME_MM && Math.abs(dmax) < SAME_MM) continue;
      const key = `${axis}:${r(dmin)}:${r(dmax)}`;
      const g = groups.get(key) ?? { axis, dmin, dmax, pairs: [] };
      g.pairs.push([was, p]);
      groups.set(key, g);
    }
  }
  const all = later.length ? union(later.map((p) => p.nominal)) : null;
  const diagonal = all ? Math.hypot(...[0, 1, 2].map((i) => all.max[i]! - all.min[i]!)) : 0;
  const off = Math.max(15, diagonal * 0.04);

  const marks: MoveMark[] = [];
  for (const g of [...groups.values()].sort((a, b) => b.pairs.length - a.pairs.length)) {
    const { axis, dmin, dmax } = g;
    const move = Math.abs(dmin - dmax) < SAME_MM;
    const amount = move ? dmin : dmax - dmin;
    if (Math.abs(amount) < SAME_MM) continue;
    const was = union(g.pairs.map(([w]) => w.nominal));
    const is = union(g.pairs.map(([, p]) => p.nominal));
    // A move's line runs between the old and new near edges. A size change's runs along the edge that moved most.
    const edge: "min" | "max" = move ? "min" : Math.abs(dmax) >= Math.abs(dmin) ? "max" : "min";
    // The line stands off to the right of the parts, or above them for a move across.
    const across: 0 | 1 | 2 = axis === 0 ? 1 : 0;
    const depth: 0 | 1 | 2 = ([0, 1, 2] as const).find((i) => i !== axis && i !== across)!;
    const from = [0, 0, 0] as Vec;
    const to = [0, 0, 0] as Vec;
    from[axis] = was[edge][axis]!;
    to[axis] = is[edge][axis]!;
    from[across] = to[across] = Math.max(was.max[across]!, is.max[across]!) + off;
    from[depth] = to[depth] = Math.max(was.max[depth]!, is.max[depth]!);
    const tick = [0, 0, 0] as Vec;
    tick[across] = off * 0.4;
    const count = g.pairs.length;
    const who = count === 1 ? names(g.pairs[0]![1].id) : `${count} parts`;
    const [up, down] = DIRECTION[axis];
    const words = move
      ? `${who} move${count === 1 ? "s" : ""} ${amount > 0 ? up : down} ${fmt(Math.abs(amount))} mm`
      : `${who} ${amount > 0 ? (count === 1 ? "grows" : "grow") : count === 1 ? "shrinks" : "shrink"} ${fmt(Math.abs(amount))} mm`;
    marks.push({ axis, kind: move ? "move" : "size", amount, label: signed(amount), words, from, to, tick, parts: g.pairs.map(([, p]) => p.id) });
    if (marks.length >= MAX_MARKS) break;
  }
  return { parts, faded, marks };
}

/** Which side of a suggested change the model shows. */
export type Side = "now" | "after";

/** How you've left the ghost of the waiting change: which side, or put away. */
export interface GhostPref {
  id: string;
  side: Side;
  hidden: boolean;
}

/** The suggested change Claude is waiting on now, if any. None while Claude works. */
export function livePreview(state: Pick<ServerState, "chat" | "waiting" | "busy">): PreviewItem | null {
  const m = waitingMoments(state).find((x) => x.kind === "preview");
  const item = m && state.chat.find((c) => c.id === m.id);
  return item?.kind === "preview" ? item : null;
}

/** What the model shows of the waiting change: a new one shows by itself, as a ghost on the model as it is. */
export function ghostShown(liveId: string | null, pref: GhostPref | null): { id: string; side: Side } | null {
  if (!liveId) return null;
  if (pref?.id !== liveId) return { id: liveId, side: "now" };
  return pref.hidden ? null : { id: liveId, side: pref.side };
}

/** See it in the waiting bar: flips the model to the change and back, and brings a put-away ghost back. */
export function seeIt(liveId: string, pref: GhostPref | null): GhostPref {
  const shown = ghostShown(liveId, pref);
  return { id: liveId, side: shown?.side === "after" ? "now" : "after", hidden: false };
}

/** Shows the ghost, on one side or the side it was on. */
export function showGhost(liveId: string, pref: GhostPref | null, side?: Side): GhostPref {
  return { id: liveId, side: side ?? (pref?.id === liveId ? pref.side : "now"), hidden: false };
}

/** Puts the ghost away. The model shows the design as it is, and the waiting bar still offers the change. */
export function hideGhost(liveId: string, pref: GhostPref | null): GhostPref {
  return { id: liveId, side: pref?.id === liveId ? pref.side : "now", hidden: true };
}

/** What the main model draws: the design as it is with the ghost over it, or the design with the change and its parts outlined. */
export interface ModelView {
  design: Design;
  parts: DerivedPart[];
  joints: Derived["joints"];
  hardware: Derived["hardware"];
  ghost: Ghost | null;
  /** Parts outlined in the ghost's colour. */
  outline: string[];
}

export function modelView(now: Pick<ServerState, "design" | "derived">, result: PreviewResult | null, side: Side | null, names?: (id: string) => string): ModelView {
  const plain: ModelView = { design: now.design, parts: now.derived.parts, joints: now.derived.joints, hardware: now.derived.hardware, ghost: null, outline: [] };
  if (!result || !side) return plain;
  if (side === "after") {
    return { design: result.proposed, parts: result.after.parts, joints: result.after.joints, hardware: result.after.hardware, ghost: null, outline: [...result.changed, ...result.added] };
  }
  return { ...plain, ghost: ghostOf(now.derived.parts, result.after.parts, names) };
}
