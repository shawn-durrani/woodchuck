// Pulls a piece apart the way it goes together, for the exploded view.
//
// Each joint says which way its two parts slide apart. A tenon, a tongue or
// a screwed part comes straight off the face it meets, a half lap lifts off
// its partner, a part through a slot slides out either end, and a box joint
// opens either way its fingers are open. A drawer slide lets its parts run
// only along its length, so a drawer comes out the front. A part with no
// joint can go any way with nothing in its path.
//
// Solid wood can't pass through solid wood, so nothing here does. Parts
// come off in stages, outside in, and the largest part stays put. A stage
// takes every part that can slide free of everything still there, with
// nothing in its path, as long as no two moves in the stage could cross.
// When a part can't come off alone, it takes along whatever holds it that
// way, such as a table's end frame of two legs and a rail, and that group
// comes apart in later stages. Parts whose joints hold each other every
// way can't come apart in a straight line, so they stay together, and the
// explosion says which they are. Each move goes far enough to clear what's
// around it, now and in every later stage, plus a gap in proportion to
// what is coming apart. Kept free of three.js so the tests can hold it.

import { AXIS_INDEX, type Box, type DerivedHardware, type DerivedJoint, type DerivedPart, type Vec3 } from "./derive.js";
import { AXES, type Axis } from "./types.js";

export interface ExplodeMove {
  /** The parts that move together. */
  parts: string[];
  /** How far they move, in mm. Only one axis is ever set. */
  by_mm: Vec3;
  /** When they move, from 1. Every move in stage 1 happens first. */
  stage: number;
}

export interface Explosion {
  moves: ExplodeMove[];
  /** How many stages it comes apart in. */
  stages: number;
  /** Sets of parts whose joints hold each other every way, so they stay together. */
  locked: string[][];
}

/** One joint pulled apart, with the region the camera frames for it. */
export interface JointExplosion extends Explosion {
  joint: string;
  host: string;
  guest: string;
  /** Other parts the moving one passes through, because they hold it too. */
  passes: string[];
  /** The joint with a little of each part around it, apart. */
  focus: Box;
}

export const NO_EXPLOSION: Explosion = { moves: [], stages: 0, locked: [] };

type ExplodePart = Pick<DerivedPart, "id" | "box" | "nominal" | "broken" | "thickness_axis">;
type ExplodeJoint = Pick<DerivedJoint, "id" | "type" | "family" | "host" | "guest" | "axis" | "side" | "features">;
type ExplodeHardware = Pick<DerivedHardware, "kind" | "connects" | "boxes">;

/** One way out along an axis. */
interface Way {
  axis: Axis;
  sign: 1 | -1;
}

const EPS = 0.01;
const WAYS: readonly Way[] = AXES.flatMap((axis) => [
  { axis, sign: 1 as const },
  { axis, sign: -1 as const },
]);
const wayKey = (w: Way) => `${w.axis}${w.sign > 0 ? "+" : "-"}`;
const at = (a: Axis) => AXIS_INDEX[a];
const span = (b: Box, a: Axis) => b.max[at(a)]! - b.min[at(a)]!;
const mid = (b: Box, a: Axis) => (b.max[at(a)]! + b.min[at(a)]!) / 2;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const longest = (b: Box) => Math.max(...AXES.map((a) => span(b, a)));
const volume = (b: Box) => AXES.reduce((v, a) => v * Math.max(span(b, a), 0), 1);

function along(w: Way, t: number): Vec3 {
  const v: Vec3 = [0, 0, 0];
  v[at(w.axis)] = w.sign * t;
  return v;
}

function shift(b: Box, v: Vec3): Box {
  return { min: b.min.map((x, k) => x + v[k]!) as Vec3, max: b.max.map((x, k) => x + v[k]!) as Vec3 };
}

function hull(boxes: Box[]): Box {
  return {
    min: [0, 1, 2].map((k) => Math.min(...boxes.map((b) => b.min[k]!))) as Vec3,
    max: [0, 1, 2].map((k) => Math.max(...boxes.map((b) => b.max[k]!))) as Vec3,
  };
}

/** True when two boxes share more than a face across every axis but this one. */
function across(a: Box, b: Box, axis: Axis): boolean {
  return AXES.every((x) => x === axis || Math.min(a.max[at(x)]!, b.max[at(x)]!) - Math.max(a.min[at(x)]!, b.min[at(x)]!) > EPS);
}

/** Everything a box could ever pass through going this way. */
function sweep(b: Box, w: Way): Box {
  const out: Box = { min: [...b.min] as Vec3, max: [...b.max] as Vec3 };
  if (w.sign > 0) out.max[at(w.axis)] = Infinity;
  else out.min[at(w.axis)] = -Infinity;
  return out;
}

const overlaps = (a: Box, b: Box) => AXES.every((x) => Math.min(a.max[at(x)]!, b.max[at(x)]!) - Math.max(a.min[at(x)]!, b.min[at(x)]!) > EPS);

/** True when b stands in a's path going this way. Boxes that already overlap don't count, since a joint or a mistake put them there. */
function inPath(a: Box, b: Box, w: Way): boolean {
  const k = at(w.axis);
  const ahead = w.sign > 0 ? b.min[k]! >= a.max[k]! - EPS : b.max[k]! <= a.min[k]! + EPS;
  return ahead && across(a, b, w.axis);
}

/**
 * The ways a joint's guest can slide off its host, best first, or null when
 * the joint isn't placed and so holds nothing.
 */
function guestWays(j: ExplodeJoint, host: ExplodePart, guest: ExplodePart): Way[] | null {
  const away = (a: Axis): 1 | -1 => (mid(guest.nominal, a) >= mid(host.nominal, a) ? 1 : -1);
  if (j.family === "interlock") {
    const o: Box = {
      min: [0, 1, 2].map((k) => Math.max(guest.nominal.min[k]!, host.nominal.min[k]!)) as Vec3,
      max: [0, 1, 2].map((k) => Math.min(guest.nominal.max[k]!, host.nominal.max[k]!)) as Vec3,
    };
    if (AXES.some((a) => span(o, a) <= EPS)) return null;
    if (j.type === "half_lap") {
      // The host keeps the lower half where they cross, so the guest lifts off it.
      const t = AXES.find((a) => Math.abs(span(o, a) - span(host.nominal, a)) < EPS && Math.abs(span(o, a) - span(guest.nominal, a)) < EPS);
      return t ? [{ axis: t, sign: 1 }] : null;
    }
    // A box joint's slots are open along both boards' thicknesses at the corner, across the way its fingers run.
    if (host.thickness_axis === guest.thickness_axis) return null;
    const ways = [guest.thickness_axis, host.thickness_axis].filter((a) => Math.abs(mid(guest.nominal, a) - mid(host.nominal, a)) > EPS).map((a) => ({ axis: a, sign: away(a) }));
    return ways.length ? ways : null;
  }
  if (!j.axis) return null;
  if (j.family === "through") {
    const first = away(j.axis);
    return [
      { axis: j.axis, sign: first },
      { axis: j.axis, sign: first > 0 ? -1 : 1 },
    ];
  }
  return [{ axis: j.axis, sign: j.side === "end" ? -1 : 1 }];
}

/** For each part, each part it's joined to and the ways it can slide off that one. Two joints on one pair must both allow a way. */
function jointRules(parts: Map<string, ExplodePart>, joints: readonly ExplodeJoint[], hardware: readonly ExplodeHardware[]): Map<string, Map<string, Set<string>>> {
  const rules = new Map<string, Map<string, Set<string>>>();
  const add = (p: string, q: string, ways: Way[]) => {
    const mine = rules.get(p) ?? new Map<string, Set<string>>();
    rules.set(p, mine);
    const keys = new Set(ways.map(wayKey));
    const had = mine.get(q);
    mine.set(q, had ? new Set([...had].filter((k) => keys.has(k))) : keys);
  };
  for (const j of joints) {
    const host = parts.get(j.host);
    const guest = parts.get(j.guest);
    if (!host || !guest || host === guest) continue;
    const ways = guestWays(j, host, guest);
    if (!ways) continue;
    add(guest.id, host.id, ways);
    add(
      host.id,
      guest.id,
      ways.map((w) => ({ axis: w.axis, sign: w.sign > 0 ? -1 : 1 })),
    );
  }
  // A slide runs along its length, which is front to back unless its model says otherwise.
  for (const h of hardware) {
    if (h.kind !== "drawer_slide") continue;
    const model = h.boxes.length ? hull(h.boxes) : null;
    const axis = model ? AXES.reduce((a, b) => (span(model, b) > span(model, a) ? b : a)) : "z";
    const joined = h.connects.map((id) => parts.get(id)).filter((p): p is ExplodePart => !!p);
    for (const p of joined) {
      for (const q of joined) {
        if (p === q) continue;
        // The part further out is the drawer, which runs out. Parts level with each other, such as a drawer's two sides, aren't held by it.
        const d = mid(p.nominal, axis) - mid(q.nominal, axis);
        if (Math.abs(d) > EPS) add(p.id, q.id, [{ axis, sign: d > 0 ? 1 : -1 }]);
      }
    }
  }
  return rules;
}

/** One group's way off at one level of the plan, and how far, once worked out. */
interface Move {
  set: string[];
  way: Way;
  round: number;
  child?: Level;
  t?: number;
}

/** A group coming apart: what stays put, every move off it in order, and what can't come off it. */
interface Level {
  root: string;
  members: string[];
  moves: Move[];
  rounds: number;
  locked: string[];
}

/**
 * Works out how one group comes apart, outside in. blocks says which parts
 * stop a part going a way: a joint that doesn't open that way, or an
 * unjoined part in its path.
 */
function planLevel(members: string[], parts: Map<string, ExplodePart>, blocks: (id: string, w: Way) => string[]): Level {
  const sorted = [...members].sort();
  const root = sorted.reduce((best, id) => (volume(parts.get(id)!.nominal) > volume(parts.get(best)!.nominal) + EPS ? id : best), sorted[0]!);
  const remaining = new Set(sorted);
  const moves: Move[] = [];
  let round = 0;
  /** Everything that has to go along with id to move it this way, or null when that takes the part that stays. */
  const closure = (id: string, w: Way): Set<string> | null => {
    const set = new Set([id]);
    const todo = [id];
    while (todo.length) {
      for (const q of blocks(todo.pop()!, w)) {
        if (!remaining.has(q) || set.has(q)) continue;
        if (q === root) return null;
        set.add(q);
        todo.push(q);
      }
    }
    return set;
  };
  while (remaining.size > 1) {
    round++;
    const left = hull([...remaining].map((id) => parts.get(id)!.box));
    /** How much a way leads out of what's left rather than into it, from -1 to 1, with up winning a tie. */
    const outward = (set: Iterable<string>, w: Way) => {
      const b = hull([...set].map((id) => parts.get(id)!.box));
      return (w.sign * (mid(b, w.axis) - mid(left, w.axis))) / Math.max(span(left, w.axis), 1) + (w.axis === "y" && w.sign > 0 ? 1e-6 : 0);
    };
    const options: { set: Set<string>; way: Way; score: number }[] = [];
    for (const id of remaining) {
      if (id === root) continue;
      for (const w of WAYS) {
        const set = closure(id, w);
        if (set) options.push({ set, way: w, score: outward(set, w) });
      }
    }
    // Single parts first, then the smallest groups, each the way that leads furthest out.
    options.sort((a, b) => a.set.size - b.set.size || b.score - a.score);
    const taken = new Set<string>();
    const now: (Move & { box: Box })[] = [];
    for (const o of options) {
      if ([...o.set].some((id) => taken.has(id))) continue;
      // Two moves in one stage go at once, so they go the same way, or along paths that never meet.
      const box = hull([...o.set].map((id) => parts.get(id)!.box));
      if (now.some((m) => wayKey(m.way) !== wayKey(o.way) && overlaps(sweep(m.box, m.way), sweep(box, o.way)))) continue;
      for (const id of o.set) taken.add(id);
      now.push({ set: [...o.set].sort(), way: o.way, round, box });
    }
    // Everything left holds everything else, so it stays together.
    if (!now.length) {
      round--;
      break;
    }
    for (const m of now) {
      for (const id of m.set) remaining.delete(id);
      moves.push({ set: m.set, way: m.way, round });
    }
  }
  for (const m of moves) if (m.set.length > 1) m.child = planLevel(m.set, parts, blocks);
  return { root, members: sorted, moves, rounds: round, locked: remaining.size > 1 ? [...remaining].sort() : [] };
}

/** The distances along a way at which a moving box would stand within the gap of an obstacle. */
function blocked(b: Box, w: Way, obstacles: Box[], gap: number): [number, number][] {
  const k = at(w.axis);
  return obstacles
    .filter((o) => across(b, o, w.axis))
    .map((o) => (w.sign > 0 ? [o.min[k]! - gap - b.max[k]!, o.max[k]! + gap - b.min[k]!] : [b.min[k]! - o.max[k]! - gap, b.max[k]! - o.min[k]! + gap]));
}

/** The shortest distance, at least the gap, outside every blocked span. A span it would stop inside pushes it on past. */
function firstFree(spans: [number, number][], gap: number): number {
  let t = gap;
  for (let pushed = true; pushed; ) {
    pushed = false;
    for (const [lo, hi] of spans) {
      if (t > lo + EPS && t < hi - EPS) {
        t = hi;
        pushed = true;
      }
    }
  }
  return Math.round(t * 10) / 10;
}

/** The gap between parts apart: a tenth of the group's longest side, from 20 to 150 mm. */
const gapFor = (b: Box) => clamp(0.1 * longest(b), 20, 150);

/** A move once placed: where its parts start and end together, the path between, and the room they take apart. */
interface Placed {
  move: Move;
  start: Box;
  end: Box;
  path: Box;
  room: Box;
}

/**
 * Sets how far each move at a level goes, inner groups first, and returns
 * the room the level takes up together and apart. A group's own parts come
 * apart only once every move at its level is done. So a group must stop
 * clear of the path of every later move and of the part that stays, and
 * once apart it must stand clear of every other group apart. Two groups in
 * one stage going the same way side by side only need to end clear of each
 * other.
 */
function placeLevel(level: Level, parts: Map<string, ExplodePart>): Box {
  const own = (id: string) => parts.get(id)!.box;
  const gap = gapFor(hull(level.members.map(own)));
  const still = own(level.root);
  const placed: Placed[] = [];
  for (const m of [...level.moves].sort((a, b) => b.round - a.round)) {
    const start = hull(m.set.map(own));
    const room = m.child ? hull([start, placeLevel(m.child, parts)]) : start;
    const solid: Box[] = [still];
    const apart: Box[] = [still];
    for (const n of placed) {
      const alongside = n.move.round === m.round && wayKey(n.move.way) === wayKey(m.way) && !across(start, n.start, m.way.axis);
      solid.push(alongside ? n.end : n.path);
      apart.push(n.room);
    }
    m.t = firstFree([...blocked(start, m.way, solid, gap), ...blocked(room, m.way, apart, gap)], gap);
    const by = along(m.way, m.t);
    placed.push({ move: m, start, end: shift(start, by), path: hull([start, shift(start, by)]), room: shift(room, by) });
  }
  return hull([still, ...placed.flatMap((p) => [p.path, p.room])]);
}

/** Numbers each level's stages: a group comes apart once every move at the level above it is done. */
function flatten(level: Level, start: number, out: ExplodeMove[], locked: string[][]): number {
  let last = start + level.rounds - 1;
  if (level.locked.length) locked.push(level.locked);
  for (const m of level.moves) {
    out.push({ parts: m.set, by_mm: along(m.way, m.t ?? 0), stage: start + m.round - 1 });
    if (m.child) last = Math.max(last, flatten(m.child, start + level.rounds, out, locked));
  }
  return last;
}

/** The whole piece apart, stage by stage. Broken parts stay out of it. */
export function explodePiece(parts: readonly ExplodePart[], joints: readonly ExplodeJoint[], hardware: readonly ExplodeHardware[] = []): Explosion {
  const live = new Map(parts.filter((p) => !p.broken).map((p) => [p.id, p]));
  if (live.size < 2) return NO_EXPLOSION;
  const rules = jointRules(live, joints, hardware);
  const ids = [...live.keys()];
  // Who stops whom, each way, worked out once.
  const blocking = new Map<string, string[]>();
  for (const id of ids) {
    const p = live.get(id)!;
    const joined = rules.get(id);
    for (const w of WAYS) {
      const key = wayKey(w);
      blocking.set(
        `${id}|${key}`,
        ids.filter((q) => {
          if (q === id) return false;
          const opens = joined?.get(q);
          return opens ? !opens.has(key) : inPath(p.box, live.get(q)!.box, w);
        }),
      );
    }
  }
  const level = planLevel(ids, live, (id, w) => blocking.get(`${id}|${wayKey(w)}`) ?? []);
  placeLevel(level, live);
  const moves: ExplodeMove[] = [];
  const locked: string[][] = [];
  const stages = flatten(level, 1, moves, locked);
  return { moves, stages: moves.length ? stages : 0, locked };
}

/**
 * One joint apart, with nothing else moving. Its guest slides off its host,
 * or its host off its guest, whichever has a clear path, the shortest way
 * the joint allows. When neither has, the guest goes anyway, and passes
 * says what it goes through: the parts that hold it too, which the view
 * fades. Null for a joint that isn't there.
 */
export function explodeJoint(parts: readonly ExplodePart[], joints: readonly ExplodeJoint[], id: string): JointExplosion | null {
  const j = joints.find((x) => x.id === id);
  const host = j && parts.find((p) => p.id === j.host && !p.broken);
  const guest = j && parts.find((p) => p.id === j.guest && !p.broken);
  if (!j || !host || !guest) return null;
  // The joint itself: its tongues, cut-outs and fixings, or where the parts meet.
  const bits = j.features.flatMap((f): Box[] =>
    f.box ? [f.box] : f.from && f.to ? [{ min: f.from.map((v, k) => Math.min(v, f.to![k]!)) as Vec3, max: f.from.map((v, k) => Math.max(v, f.to![k]!)) as Vec3 }] : [],
  );
  const meet: Box = {
    min: [0, 1, 2].map((k) => Math.max(guest.box.min[k]!, host.box.min[k]!)) as Vec3,
    max: [0, 1, 2].map((k) => Math.min(guest.box.max[k]!, host.box.max[k]!)) as Vec3,
  };
  const region = bits.length ? hull(bits) : AXES.every((a) => span(meet, a) >= -EPS) ? meet : hull([guest.box, host.box]);
  const gap = clamp(0.6 * longest(region), 20, 120);
  const found = guestWays(j, host, guest) ?? WAYS.filter((w) => w.sign * (mid(guest.box, w.axis) - mid(host.box, w.axis)) > EPS);
  const ways = found.length ? found : [WAYS[2]!];
  const others = parts.filter((p) => p !== host && p !== guest && !p.broken);
  const choices = [
    ...ways.map((w) => ({ mover: guest, w })),
    ...ways.map((w) => ({ mover: host, w: { axis: w.axis, sign: w.sign > 0 ? -1 : 1 } as Way })),
  ].map((c) => {
    const still = c.mover === guest ? host : guest;
    const t = firstFree(blocked(c.mover.box, c.w, [still.box], gap), gap);
    const path = hull([c.mover.box, shift(c.mover.box, along(c.w, t))]);
    return { ...c, t, passes: others.filter((o) => overlaps(path, o.box)).map((o) => o.id) };
  });
  const shortest = (list: typeof choices) => list.reduce((a, b) => (b.t < a.t - EPS ? b : a));
  const clear = choices.filter((c) => !c.passes.length);
  const best = clear.length ? shortest(clear) : shortest(choices.filter((c) => c.mover === guest));
  const by = along(best.w, best.t);
  const margin = clamp(0.5 * longest(region), 40, 150);
  const near = hull([region, shift(region, by)]);
  const grown: Box = { min: near.min.map((v) => v - margin) as Vec3, max: near.max.map((v) => v + margin) as Vec3 };
  const all = hull([host.box, guest.box, shift(best.mover.box, by)]);
  const focus: Box = {
    min: [0, 1, 2].map((k) => Math.max(grown.min[k]!, all.min[k]!)) as Vec3,
    max: [0, 1, 2].map((k) => Math.min(grown.max[k]!, all.max[k]!)) as Vec3,
  };
  return { moves: [{ parts: [best.mover.id], by_mm: by, stage: 1 }], stages: 1, locked: [], joint: j.id, host: host.id, guest: guest.id, passes: best.passes, focus };
}

/**
 * Where each moving part sits at an amount from 0, together, to 1, fully
 * apart. The stages take turns along the way, each easing in and out.
 */
export function explodeOffsets(e: Explosion, amount: number): Map<string, Vec3> {
  const out = new Map<string, Vec3>();
  if (!e.stages || amount <= 0) return out;
  for (const m of e.moves) {
    const k = clamp(amount * e.stages - (m.stage - 1), 0, 1);
    if (!k) continue;
    const s = k * k * (3 - 2 * k);
    for (const id of m.parts) {
      const o = out.get(id) ?? [0, 0, 0];
      out.set(id, [o[0] + m.by_mm[0] * s, o[1] + m.by_mm[1] * s, o[2] + m.by_mm[2] * s]);
    }
  }
  return out;
}

/** A piece of hardware sits between the parts it joins, so a hinge hangs between a door and its side. */
export function hardwareOffset(connects: readonly string[], offsets: Map<string, Vec3>): Vec3 {
  const o: Vec3 = [0, 0, 0];
  for (const id of connects) {
    const v = offsets.get(id);
    if (v) for (const k of [0, 1, 2] as const) o[k] += v[k] / connects.length;
  }
  return o;
}
