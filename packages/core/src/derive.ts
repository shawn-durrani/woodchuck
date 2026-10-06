// Turns a design's intent into geometry. Every number here is calculated
// from the design file, and each one keeps a trace of how it was worked
// out, so "why is this 1946?" always has an answer.
//
// Parts are worked out in two passes. The nominal box is what you see:
// where each part starts and ends. Housing joints then lengthen the guest
// part into its host, which gives the box you cut. A part with cuts gets its
// shape once every nominal box is known (see profile.ts). Joints are placed
// on the wood its cuts leave, and its profile follows its housings.

import { evaluate, evaluateNumber, ExprError, fmt, refsOf, type GapResolver, type Traced } from "./expr.js";
import { canStop, DOMINO_WALL_MM, dominoGuestDepth, dominoSize, housingWord, JOINT_LIBRARY, slotShape, type JointCheck, type JointContext, type JointParam, type SlotWall } from "./joints.js";
import { contactWood, cutsInBox, fastenerStretches, slotWallsOnShape, spreadOver, type CutInBox } from "./jointShape.js";
import { placeBox } from "./library.js";
import { partPrism, profileFor, solveFace, type CutValues, type PartProfile, type SolvedFace } from "./profile.js";
import { prismGap, prismsOverlap, type Loop } from "./shape.js";
import {
  AXES,
  AXIS_FACES,
  FACE_AXIS,
  FACE_IS_MAX,
  FACES,
  JOINT_FAMILY,
  type ArrayPattern,
  type Axis,
  type AxisSpec,
  type Bound,
  type Design,
  type Face,
  type Hardware,
  type Joint,
  type JointFamily,
  type JointType,
  type Material,
  type Panel,
  type Severity,
} from "./types.js";

export type Vec3 = [number, number, number];
export interface Box {
  min: Vec3;
  max: Vec3;
}

export const AXIS_INDEX: Record<Axis, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };

export interface Step {
  value: number;
  text: string;
}

export interface AxisTrace {
  start: Step;
  end: Step;
  size: Step;
}

export interface Extension {
  joint: string;
  host: string;
  axis: Axis;
  side: "start" | "end";
  depth_mm: number;
  /**
   * A stopped housing: how much of the end it leaves out, from the start
   * and from the end of the end's run. The guest is notched away there.
   */
  notch_mm?: [number, number];
}

export interface Machining {
  joint: string;
  type: JointType;
  /** What's cut, in workshop words: dado, mortise, tenon, lap, fingers, pocket holes. */
  label: string;
  /** The other part in the joint. */
  with: string;
  /** The face of this part the work is on. */
  face: Face;
  /** Open slots: the end of this part the slot opens out of. */
  open_end?: Face;
  /** A tongue a rabbet leaves: the face of this part it's flush with. */
  flush?: Face;
  /** A stopped housing: how far short of each edge of this part it stops. */
  stop_mm?: Partial<Record<Face, number>>;
  /** A notch for a stopped housing: the edge whose corner it comes out of, such as front. */
  corner?: Face;
  depth_mm: number;
  width_mm: number;
  length_mm: number;
  count?: number;
  diameter_mm?: number;
  /** A Domino mortise cut wider than its tenon, on the joiner's wider setting: how much longer it is along the joint. */
  play_mm?: number;
  region: Box;
  /** Its joint names one array copy, so the cut list keeps the other part's copy number. */
  on_copy?: true;
}

/** Joint detail for the see-through view and Claude's drawings. */
export interface JointFeature {
  /** tongue: material going into another part. removed: material cut away. fastener: a screw or dowel. */
  kind: "tongue" | "removed" | "fastener";
  part: string;
  box?: Box;
  from?: Vec3;
  to?: Vec3;
  diameter_mm?: number;
}

export interface Dims {
  length: number;
  width: number;
  thickness: number;
}

export interface DerivedPart {
  id: string;
  /** The design part this came from. Same as id unless it's an array copy. */
  source: string;
  /** 1 for the original, 2 and up for array copies. */
  copy: number;
  name: string;
  material: string;
  thickness_axis: Axis;
  grain_axis: Axis;
  width_axis: Axis;
  tags: string[];
  decor: boolean;
  unverified: boolean;
  /** True when its geometry couldn't be worked out. */
  broken: boolean;
  nominal: Box;
  box: Box;
  axes: Record<Axis, AxisTrace>;
  extensions: Extension[];
  machining: Machining[];
  finished: Dims;
  cut: Dims;
  /** The shape its cuts leave on its broad face. Only a part with cuts that take wood has one. */
  profile?: PartProfile;
}

export interface DerivedJoint {
  id: string;
  source: string;
  type: JointType;
  family: JointFamily;
  host: string;
  guest: string;
  axis?: Axis;
  side?: "start" | "end";
  depth_mm?: number;
  count?: number;
  /** Every parameter, with library defaults filled in. */
  params: Partial<Record<JointParam, number>>;
  /** A stopped housing's stops as given, worked out: how far short of each edge of the host. */
  stop_mm?: Partial<Record<Face, number>>;
  /** Which parameters came from the library rather than the design. */
  defaulted: JointParam[];
  features: JointFeature[];
  /** The overlap this joint explains, if any. */
  allowed?: Box;
  problems: JointCheck[];
  /** It names one array copy, such as shelf#2, so it's placed once and never repeats. */
  on_copy?: true;
}

export interface DerivedHardware {
  id: string;
  source: string;
  kind: string;
  name: string;
  connects: string[];
  qty: number;
  spec: Record<string, number | string>;
  library_part?: string;
  /** The placed model in world coordinates, when it has one. */
  boxes: Box[];
  /** The parts it connects count as standing on the floor. */
  on_floor: boolean;
}

export interface DeriveIssue {
  severity: Severity;
  code: string;
  message: string;
  parts: string[];
  trace?: string;
}

export interface Derived {
  params: Record<string, { value: number; text: string } | { error: string }>;
  parts: DerivedPart[];
  joints: DerivedJoint[];
  hardware: DerivedHardware[];
  issues: DeriveIssue[];
}

export interface DeriveResult extends Derived {
  byId: Map<string, DerivedPart>;
  /** The box around the whole piece, which overall.width and the like read, or why there's none. */
  overall: WholePiece | { error: string };
  /** Evaluates any expression against this design. */
  evaluate: (expr: string) => Traced;
}

/**
 * The whole piece, as a rule reads it: overall.width, overall.height and
 * overall.depth, the same sizes as overall.size_x, size_y and size_z, and
 * its faces, such as overall.top. It's the box around every part, stand-ins
 * included, with no props and no hardware. It's worked out after every
 * size, like a gap, so a part or a parameter can't use it.
 */
export const OVERALL = "overall";
export const OVERALL_SIZES: Record<string, Axis> = { width: "x", height: "y", depth: "z", size_x: "x", size_y: "y", size_z: "z" };
/** Everything after "overall." that an expression can read. */
export const OVERALL_NAMES: readonly string[] = [...Object.keys(OVERALL_SIZES), ...FACES];

export interface WholePiece {
  box: Box;
  /** The part at each end of each axis, the start's then the end's. */
  ends: Record<Axis, [string, string]>;
}

const EPS = 0.01;

const emptyStep: Step = { value: 0, text: "unknown" };
const zeroBox = (): Box => ({ min: [0, 0, 0], max: [0, 0, 0] });

export function partRefParts(ref: string): { source: string; copy: number } {
  const at = ref.indexOf("#");
  if (at < 0) return { source: ref, copy: 1 };
  return { source: ref.slice(0, at), copy: Number(ref.slice(at + 1)) };
}

/**
 * Whether a joint's host or guest names one item of an array, such as
 * shelf#2, or shelf#1 for the original alone. A joint that does joins the
 * two parts it names, once, while one on an original repeats on every copy.
 */
export function namesCopy(ref: string): boolean {
  return ref.includes("#");
}

/** The derived part a joint's end names. shelf#1 is the original, which is called shelf. */
export function jointPartId(ref: string): string {
  const { source, copy } = partRefParts(ref);
  return copy === 1 ? source : ref;
}

export function faceOf(axis: Axis, max: boolean): Face {
  return AXIS_FACES[axis][max ? 1 : 0];
}

export function otherAxis(a: Axis, b: Axis): Axis {
  return AXES.find((x) => x !== a && x !== b)!;
}

function dimsOf(box: Box, grain: Axis, width: Axis, thick: Axis): Dims {
  const size = (a: Axis) => box.max[AXIS_INDEX[a]] - box.min[AXIS_INDEX[a]];
  return { length: size(grain), width: size(width), thickness: size(thick) };
}

class CycleError extends ExprError {}

/** Works out names lazily, with memoisation and cycle detection. */
class Resolver {
  private parts = new Map<string, Panel>();
  private materials = new Map<string, Material>();
  private params = new Map<string, string>();
  private arrayOfPart = new Map<string, ArrayPattern>();
  private paramCache = new Map<string, Traced & { value: number }>();
  private axisCache = new Map<string, AxisTrace>();
  private arrayCache = new Map<string, { count: number; pitch: number }>();
  private visiting: string[] = [];

  constructor(private design: Design) {
    for (const p of design.parts) this.parts.set(p.id, p);
    for (const m of design.materials) this.materials.set(m.id, m);
    for (const p of design.params) this.params.set(p.name, p.expr);
    for (const a of design.arrays) for (const id of a.parts) this.arrayOfPart.set(id, a);
  }

  arrayOf(id: string): ArrayPattern | undefined {
    return this.arrayOfPart.get(id);
  }

  private guard<T>(key: string, fn: () => T): T {
    if (this.visiting.includes(key)) {
      const loop = [...this.visiting.slice(this.visiting.indexOf(key)), key].join(" → ");
      throw new CycleError(`Circular reference: ${loop}`);
    }
    this.visiting.push(key);
    try {
      return fn();
    } finally {
      this.visiting.pop();
    }
  }

  param(name: string): Traced & { value: number } {
    const hit = this.paramCache.get(name);
    if (hit) return hit;
    const src = this.params.get(name);
    if (src === undefined) throw new ExprError(`Unknown parameter "${name}"`);
    const r = this.guard(`param ${name}`, () => evaluateNumber(src, (n) => this.value(n)));
    this.paramCache.set(name, r);
    return r;
  }

  arrayInfo(a: ArrayPattern): { count: number; pitch: number } {
    const hit = this.arrayCache.get(a.id);
    if (hit) return hit;
    const r = this.guard(`array ${a.id}`, () => {
      const count = evaluateNumber(a.count, (n) => this.value(n)).value;
      if (!Number.isInteger(count) || count < 1) {
        throw new ExprError(`Array "${a.id}" count must be a whole number of 1 or more, not ${fmt(count)}`);
      }
      const pitch = evaluateNumber(a.pitch, (n) => this.value(n)).value;
      return { count, pitch };
    });
    this.arrayCache.set(a.id, r);
    return r;
  }

  /** The value of a name used in an expression. */
  value = (name: string): number => {
    const dot = name.indexOf(".");
    if (dot < 0) return this.param(name).value;
    const ref = name.slice(0, dot);
    const prop = name.slice(dot + 1);
    if (ref === OVERALL && !this.parts.has(OVERALL)) {
      throw new ExprError(`${name} measures the whole piece, which is worked out after every size, so only a rule or a plan's key size can use it`);
    }
    if ((FACES as readonly string[]).includes(prop)) return this.face(ref, prop as Face);
    const part = this.partFor(ref);
    const sizeOf = (a: Axis) => this.size(ref, a);
    switch (prop) {
      case "size_x":
        return sizeOf("x");
      case "size_y":
        return sizeOf("y");
      case "size_z":
        return sizeOf("z");
      case "length":
        return sizeOf(part.grain_axis);
      case "thickness":
        return sizeOf(part.thickness_axis);
      case "width":
        return sizeOf(otherAxis(part.grain_axis, part.thickness_axis));
    }
    throw new ExprError(
      `"${name}" isn't something a part has. Use a face (${FACES.join(", ")}), length, width, thickness or size_x/size_y/size_z`,
    );
  };

  partFor(ref: string): Panel {
    const { source, copy } = partRefParts(ref);
    const part = this.parts.get(source);
    if (!part) {
      const known = [...this.parts.keys()].slice(0, 30).join(", ");
      throw new ExprError(`Unknown part "${source}". Parts: ${known || "none yet"}`);
    }
    if (copy !== 1) {
      const arr = this.arrayOf(source);
      if (!arr) throw new ExprError(`"${ref}" names a copy, but "${source}" isn't in an array`);
      const { count } = this.arrayInfo(arr);
      if (copy < 1 || copy > count) {
        throw new ExprError(`"${ref}" doesn't exist: array "${arr.id}" has ${count} items`);
      }
    }
    return part;
  }

  /**
   * A part's size on one axis. Thickness and set sizes don't depend on where
   * the part sits, so they're worked out on their own. That lets a part's
   * position refer to its own thickness without a loop.
   */
  size(ref: string, a: Axis): number {
    const part = this.partFor(ref);
    if (part.thickness_axis === a) return this.material(part.material).thickness_mm;
    const spec = part[a];
    if (spec.size !== undefined && !(spec.start && spec.end)) {
      return this.guard(`${part.id}.${a}.size`, () => evaluateNumber(spec.size!, this.value).value);
    }
    return this.axis(ref, a).size.value;
  }

  face(ref: string, face: Face): number {
    const t = this.axis(ref, FACE_AXIS[face]);
    return FACE_IS_MAX[face] ? t.end.value : t.start.value;
  }

  material(id: string): Material {
    const m = this.materials.get(id);
    if (!m) throw new ExprError(`Unknown material "${id}"`);
    return m;
  }

  /** How a part spans one axis, before any joinery. */
  axis(ref: string, a: Axis): AxisTrace {
    const key = `${ref}:${a}`;
    const hit = this.axisCache.get(key);
    if (hit) return hit;
    const part = this.partFor(ref);
    const { copy } = partRefParts(ref);
    let r: AxisTrace;
    if (copy !== 1) {
      const arr = this.arrayOf(part.id)!;
      const base = this.axis(part.id, a);
      if (arr.axis !== a) {
        r = base;
      } else {
        const shift = this.arrayInfo(arr).pitch * (copy - 1);
        const note = ` + ${copy - 1} × pitch of ${arr.id} (${fmt(this.arrayInfo(arr).pitch)})`;
        r = {
          start: { value: base.start.value + shift, text: `${part.id} start ${fmt(base.start.value)}${note}` },
          end: { value: base.end.value + shift, text: `${part.id} end ${fmt(base.end.value)}${note}` },
          size: base.size,
        };
      }
    } else {
      r = this.guard(`${ref}.${a}`, () => this.ownAxis(part, a));
    }
    this.axisCache.set(key, r);
    return r;
  }

  /**
   * Where a part's cuts sit and how big they are, worked out like its own
   * bounds. A cut may use its own part's faces, since nothing reads a
   * profile back.
   */
  cutValues(part: Panel): CutValues {
    return {
      bound: (a, b) => this.bound(part, a, b),
      span: (a, spec, who) => this.span(part, a, spec, who),
      number: (src) => {
        const r = evaluateNumber(src, this.value);
        return { value: r.value, text: r.text };
      },
    };
  }

  private bound(part: Panel, a: Axis, b: Bound): Step {
    if ("at" in b) {
      const r = evaluateNumber(b.at, this.value);
      return { value: r.value, text: r.text };
    }
    const dot = b.face.lastIndexOf(".");
    const ref = b.face.slice(0, dot);
    const face = b.face.slice(dot + 1) as Face;
    if (dot < 0 || !(FACES as readonly string[]).includes(face)) {
      throw new ExprError(`"${b.face}" isn't a face. Write it as part.face, with a face from ${FACES.join(", ")}`);
    }
    if (FACE_AXIS[face] !== a) {
      throw new ExprError(
        `${part.id}'s ${a} bound uses "${b.face}", but ${face} is on the ${FACE_AXIS[face]} axis. On ${a} use ${AXIS_FACES[a].join(" or ")}`,
      );
    }
    const at = this.face(ref, face);
    let value = at;
    let text = `${b.face} (${fmt(at)})`;
    if (b.offset !== undefined && b.offset.trim() !== "") {
      const off = evaluateNumber(b.offset, this.value);
      value += off.value;
      text += off.value < 0 ? ` - ${fmt(-off.value)}` : ` + ${off.text}`;
    }
    return { value, text };
  }

  private ownAxis(part: Panel, a: Axis): AxisTrace {
    const spec = part[a];
    if (part.thickness_axis === a) {
      const m = this.material(part.material);
      const size: Step = { value: m.thickness_mm, text: `${m.id} thickness (${fmt(m.thickness_mm)})` };
      if (spec.start) {
        const start = this.bound(part, a, spec.start);
        return { start, size, end: { value: start.value + size.value, text: `${start.text} + ${size.text}` } };
      }
      if (spec.end) {
        const end = this.bound(part, a, spec.end);
        return { end, size, start: { value: end.value - size.value, text: `${end.text} - ${size.text}` } };
      }
      throw new ExprError(`${part.id} needs a start or end on ${a}, its thickness axis`);
    }
    return this.span(part, a, spec, part.id);
  }

  /** A span from two of start, end and size, for a part's own axis or a cutout's. */
  private span(part: Panel, a: Axis, spec: AxisSpec, who: string): AxisTrace {
    const start = spec.start ? this.bound(part, a, spec.start) : undefined;
    const end = spec.end ? this.bound(part, a, spec.end) : undefined;
    const size = spec.size !== undefined ? evaluateNumber(spec.size, this.value) : undefined;
    if (start && end) {
      return { start, end, size: { value: end.value - start.value, text: `${end.text} - (${start.text})` } };
    }
    if (start && size) {
      return { start, size, end: { value: start.value + size.value, text: `${start.text} + ${size.text}` } };
    }
    if (end && size) {
      return { end, size, start: { value: end.value - size.value, text: `${end.text} - ${size.text}` } };
    }
    throw new ExprError(`${who} needs two of start, end and size on ${a}`);
  }
}

function overlapLen(a: Box, b: Box, i: number): number {
  return Math.min(a.max[i]!, b.max[i]!) - Math.max(a.min[i]!, b.min[i]!);
}

/** Where two boxes touch face to face, as seen from the guest. */
function touching(guest: Box, host: Box): { axis: Axis; side: "start" | "end" } | null {
  for (const a of AXES) {
    const i = AXIS_INDEX[a];
    const others = [0, 1, 2].filter((j) => j !== i);
    if (!others.every((j) => overlapLen(guest, host, j) > EPS)) continue;
    if (Math.abs(guest.max[i]! - host.min[i]!) < EPS) return { axis: a, side: "end" };
    if (Math.abs(guest.min[i]! - host.max[i]!) < EPS) return { axis: a, side: "start" };
  }
  return null;
}

function intersect(a: Box, b: Box): Box {
  return {
    min: [0, 1, 2].map((i) => Math.max(a.min[i]!, b.min[i]!)) as Vec3,
    max: [0, 1, 2].map((i) => Math.min(a.max[i]!, b.max[i]!)) as Vec3,
  };
}

function cloneBox(b: Box): Box {
  return { min: [...b.min] as Vec3, max: [...b.max] as Vec3 };
}

function boxesOverlap(a: Box, b: Box): boolean {
  return [0, 1, 2].every((i) => overlapLen(a, b, i) > EPS);
}

/** Across the joint (tAxis) and along the edge that meets the host (lAxis). */
function jointAxes(guest: DerivedPart, axis: Axis): { tAxis: Axis; lAxis: Axis } {
  const tAxis = guest.thickness_axis === axis ? guest.width_axis : guest.thickness_axis;
  return { tAxis, lAxis: otherAxis(axis, tAxis) };
}

const PARAM_FIELDS: JointParam[] = ["depth", "fit", "thickness", "shoulder", "diameter", "length", "finger", "width"];

/** Fills a joint's parameters from the design, then the library's defaults. */
function resolveJointParams(j: Joint, dj: DerivedJoint, ctx: JointContext, r: Resolver, issues: DeriveIssue[]): boolean {
  const entry = JOINT_LIBRARY[j.type];
  const defaults = entry.defaults(ctx);
  try {
    for (const f of PARAM_FIELDS) {
      const src = j[f];
      if (src !== undefined && String(src).trim() !== "") {
        dj.params[f] = evaluateNumber(String(src), r.value).value;
      } else if (defaults[f] !== undefined) {
        dj.params[f] = defaults[f];
        dj.defaulted.push(f);
      }
    }
  } catch (e) {
    issues.push({ severity: "error", code: "joint_error", message: `Joint ${dj.id}: ${(e as Error).message}`, parts: [dj.host, dj.guest] });
    return false;
  }
  if (j.count !== undefined) dj.params.count = j.count;
  else if (defaults.count !== undefined) {
    dj.params.count = defaults.count;
    dj.defaulted.push("count");
  }
  if (dj.params.count !== undefined) dj.count = dj.params.count;
  // Defaults that hang on others, such as a Domino's length on its thickness, once those are known.
  for (const [f, v] of Object.entries(entry.after?.(dj.params, ctx) ?? {}) as [JointParam, number][]) {
    if (dj.params[f] !== undefined) continue;
    dj.params[f] = v;
    dj.defaulted.push(f);
  }
  dj.problems = entry.check(dj.params, ctx);
  return true;
}

/** The way a housing runs along each axis, in words. */
const RUNS: Record<Axis, string> = { x: "left to right", y: "bottom to top", z: "back to front" };

/**
 * Works out a housing's stops: how far short of each edge of its host it
 * stops. Only the two edges the housing runs between can take one, and a
 * stop of 0 is no stop. A stop that can't be used is an error, and the
 * housing runs on to that edge.
 */
function resolveStops(j: Joint, dj: DerivedJoint, lAxis: Axis, r: Resolver, issues: DeriveIssue[]) {
  const given = FACES.filter((f) => j.stop?.[f] !== undefined);
  if (!given.length) return;
  const fail = (message: string) => issues.push({ severity: "error", code: "stop_error", message: `Joint ${dj.id}: ${message}`, parts: [dj.host, dj.guest] });
  if (!canStop(j.type)) {
    fail(`only a dado, groove, rabbet or dado and rabbet can stop short of an edge, so the stop on this ${JOINT_LIBRARY[j.type].name.toLowerCase()} is left out`);
    return;
  }
  const word = housingWord(j.type);
  const out: Partial<Record<Face, number>> = {};
  for (const f of given) {
    if (FACE_AXIS[f] !== lAxis) {
      fail(`the ${word} for ${dj.guest} in ${dj.host} runs ${RUNS[lAxis]}, so it can stop short of the ${AXIS_FACES[lAxis].join(" or the ")}, not the ${f}`);
      continue;
    }
    let v: number;
    try {
      v = evaluateNumber(String(j.stop![f]), r.value).value;
    } catch (e) {
      fail(`its ${f} stop can't be worked out: ${(e as Error).message}`);
      continue;
    }
    if (v < -EPS) fail(`its ${f} stop works out to ${fmt(v)} mm. A stop is how far short of the edge the ${word} ends, so it can't be below 0`);
    else if (v > EPS) out[f] = v;
  }
  if (Object.keys(out).length) dj.stop_mm = out;
}

/** The least wood worth leaving between a stopped housing's end and the edge, the same 6 mm a cut leaves at least. */
const MIN_STOP_MM = 6;

/** A housing's stops in words, such as "10 mm from the front and 5 mm from the back". */
export function stopWords(stop: Partial<Record<Face, number>>): string {
  return FACES.filter((f) => stop[f] !== undefined)
    .map((f) => `${fmt(Math.round(stop[f]! * 10) / 10)} mm from the ${f}`)
    .join(" and ");
}

/**
 * Stops a housing short of its host's edges. It runs along the tongue no
 * nearer each stopped edge than its stop, and the guest's end is notched
 * away beyond that, so the guest keeps its place and its size. The notch
 * reaches the guest's own edge, so a guest set back past the stop needs
 * none. Each notch is machining on the guest. Problems go on the issues,
 * and stops that leave nothing are refused, so the housing runs whole.
 */
function stopHousing(dj: DerivedJoint, host: DerivedPart, guest: DerivedPart, tongue: Box, axis: Axis, tAxis: Axis, lAxis: Axis, issues: DeriveIssue[]): { tongue: Box; stop_mm: Partial<Record<Face, number>> } | null {
  const stops = dj.stop_mm;
  if (!stops) return null;
  const li = AXIS_INDEX[lAxis];
  const [loFace, hiFace] = AXIS_FACES[lAxis];
  const t0 = tongue.min[li]!;
  const t1 = tongue.max[li]!;
  const from = stops[loFace] !== undefined ? Math.max(t0, host.nominal.min[li]! + stops[loFace]!) : t0;
  const to = stops[hiFace] !== undefined ? Math.min(t1, host.nominal.max[li]! - stops[hiFace]!) : t1;
  const run = t1 - t0;
  const word = housingWord(dj.type);
  const what = `the ${word} for ${guest.id} in ${host.id}`;
  const parts = [dj.host, dj.guest];
  const given = FACES.filter((f) => stops[f] !== undefined);
  if (to - from <= EPS) {
    issues.push({
      severity: "error",
      code: "stop_too_long",
      message: `Joint ${dj.id}: stopped ${stopWords(stops)}, ${what} has none of its ${fmt(run)} mm left, so nothing would hold ${guest.id}. Make the stop${given.length === 1 ? "" : "s"} shorter`,
      parts,
    });
    return null;
  }
  // How far short of each stopped edge the housing ends, which a guest set back past its stop makes further.
  const actual: Partial<Record<Face, number>> = {};
  if (stops[loFace] !== undefined) actual[loFace] = from - host.nominal.min[li]!;
  if (stops[hiFace] !== undefined) actual[hiFace] = host.nominal.max[li]! - to;
  const left = to - from;
  if (left < run / 2 - EPS) {
    issues.push({
      severity: "warning",
      code: "stop_short_housing",
      message: `Joint ${dj.id}: the stop${given.length === 1 ? " leaves" : "s leave"} ${fmt(left)} mm of the ${fmt(run)} mm ${word} for ${guest.id} in ${host.id}, less than half, so ${guest.id} has little holding it. Keep at least ${fmt(run / 2)} mm`,
      parts,
    });
  }
  const thin = given.filter((f) => actual[f]! < MIN_STOP_MM - EPS);
  if (thin.length) {
    const near = Object.fromEntries(thin.map((f) => [f, actual[f]!]));
    issues.push({
      severity: "warning",
      code: "stop_thin",
      message: `Joint ${dj.id}: ${what} stops only ${stopWords(near)}, and wood that thin can break out when you square the end. Leave at least ${MIN_STOP_MM} mm`,
      parts,
    });
  }
  // The guest's end beyond the housing comes off as a notch at each stopped corner.
  const span = (b: Box, a: Axis) => b.max[AXIS_INDEX[a]]! - b.min[AXIS_INDEX[a]]!;
  const notchLo = Math.max(0, from - guest.nominal.min[li]!);
  const notchHi = Math.max(0, guest.nominal.max[li]! - to);
  const ext = guest.extensions.find((e) => e.joint === dj.id);
  if (ext && (notchLo > EPS || notchHi > EPS)) ext.notch_mm = [notchLo > EPS ? notchLo : 0, notchHi > EPS ? notchHi : 0];
  // Each notch goes right through the guest, and is sized on its length and width like a cut's notch.
  const face = faceOf(axis, dj.side === "end");
  const t = guest.thickness_axis;
  for (const [corner, lo, hi, n] of [
    [loFace, guest.nominal.min[li]!, from, notchLo],
    [hiFace, to, guest.nominal.max[li]!, notchHi],
  ] as const) {
    if (n <= EPS) continue;
    // A housing takes the guest's whole end, so its notch goes right through. A dado and rabbet's takes only the tongue.
    let region = setRange(tongue, lAxis, lo, hi);
    if (t === tAxis && dj.family === "housing") region = setRange(region, t, guest.box.min[AXIS_INDEX[t]]!, guest.box.max[AXIS_INDEX[t]]!);
    guest.machining.push({
      joint: dj.id,
      type: dj.type,
      label: "notch",
      with: host.id,
      face,
      corner,
      depth_mm: span(region, t),
      width_mm: span(region, guest.width_axis),
      length_mm: span(region, guest.grain_axis),
      region,
    });
  }
  return { tongue: setRange(tongue, lAxis, from, to), stop_mm: actual };
}

function setRange(b: Box, a: Axis, lo: number, hi: number): Box {
  const out = cloneBox(b);
  out.min[AXIS_INDEX[a]] = lo;
  out.max[AXIS_INDEX[a]] = hi;
  return out;
}

function mid(b: Box, a: Axis): number {
  return (b.min[AXIS_INDEX[a]]! + b.max[AXIS_INDEX[a]]!) / 2;
}

/** The host left on each side of a through slot, one entry per axis across the pass axis. A host with cuts is measured to its outline. */
function slotWalls(host: DerivedPart, overlap: Box, pass: Axis, face: SolvedFace | null = null): SlotWall[] {
  if (face) return slotWallsOnShape(host, face, overlap, pass);
  return AXES.filter((a) => a !== pass).map((a) => {
    const i = AXIS_INDEX[a];
    return { lo: overlap.min[i]! - host.nominal.min[i]!, hi: host.nominal.max[i]! - overlap.max[i]!, along_length: a === host.grain_axis };
  });
}

/** The shapes of a joint's two parts, when either has cuts, and the wood where they meet. */
interface JointShape {
  host: SolvedFace | null;
  guest: SolvedFace | null;
  /** Where a guest meets its host face to face: the patch where both still have wood. */
  contact?: Loop[];
}

/** Cut ids in words: "cut kick", or "cuts kick and slot". */
const cutWords = (cs: { id: string }[]) => {
  const ids = [...new Set(cs.map((c) => c.id))];
  return ids.length === 1 ? `cut ${ids[0]}` : `cuts ${ids.slice(0, -1).join(", ")} and ${ids[ids.length - 1]}`;
};
/** How far a cut runs along an axis inside a joint, or the joint's own length there when the cut goes right through that way. */
const runOf = (c: CutInBox, a: Axis, b: Box) => {
  const s = c.span[a];
  return s ? s[1] - s[0] : b.max[AXIS_INDEX[a]]! - b.min[AXIS_INDEX[a]]!;
};

/** Records the machining and see-through features for one placed joint. */
function jointDetail(dj: DerivedJoint, host: DerivedPart, guest: DerivedPart, sh: JointShape | null, issues: DeriveIssue[]) {
  const p = dj.params;
  const span = (b: Box, a: Axis) => b.max[AXIS_INDEX[a]]! - b.min[AXIS_INDEX[a]]!;
  const fit = p.fit ?? 0;
  const name = JOINT_LIBRARY[dj.type].name.toLowerCase();
  const cutJoint = (message: string) => issues.push({ severity: "error", code: "cut_joint", message: `Joint ${dj.id}: ${message}`, parts: [dj.host, dj.guest] });
  const size2 = (c: CutInBox) => {
    const sides = Object.values(c.span).map(([a, b]) => b - a);
    return sides.length === 2 ? `${fmt(sides[0]!)} × ${fmt(sides[1]!)} mm` : `${fmt(sides[0] ?? 0)} mm`;
  };

  if (dj.family === "through") {
    const pass = dj.axis!;
    const o = intersect(guest.nominal, host.nominal);
    dj.allowed = o;
    // The slot is cut to the passing part's blank, so a cut there leaves it loose.
    for (const c of sh ? cutsInBox(guest, sh.guest, o) : []) {
      cutJoint(
        `${cutWords([c])} on ${guest.id} takes ${size2(c)} of wood from where it passes through ${host.id}. The slot is cut to the blank, so ${guest.id} would sit loose in it. Move the cut clear of ${host.id}`,
      );
    }
    // The slot is the passing member's cross-section, plus any fit, right
    // through the host. At an open end it stops where the host does.
    let slot = o;
    const cross = AXES.filter((a) => a !== pass) as [Axis, Axis];
    for (const a of cross) {
      const i = AXIS_INDEX[a];
      slot = setRange(slot, a, Math.max(slot.min[i]! - fit / 2, host.nominal.min[i]!), Math.min(slot.max[i]! + fit / 2, host.nominal.max[i]!));
    }
    dj.depth_mm = span(slot, pass);
    dj.features.push({ kind: "removed", part: host.id, box: slot });
    const shape = slotShape(slotWalls(host, o, pass, sh?.host ?? null), fit);
    if (shape.kind === "open") {
      const along = cross[shape.wall]!;
      const across = cross[1 - shape.wall]!;
      host.machining.push({
        joint: dj.id,
        type: dj.type,
        label: "open slot",
        with: guest.id,
        face: faceOf(pass, false),
        open_end: faceOf(along, shape.side === "hi"),
        depth_mm: span(slot, pass),
        width_mm: span(slot, across),
        length_mm: span(slot, along),
        region: slot,
      });
      return;
    }
    const [w, h] = cross.map((a) => span(slot, a)).sort((x, y) => x - y) as [number, number];
    host.machining.push({
      joint: dj.id,
      type: dj.type,
      label: "through slot",
      with: guest.id,
      face: faceOf(pass, false),
      depth_mm: span(slot, pass),
      width_mm: w,
      length_mm: h,
      region: slot,
    });
    return;
  }

  if (dj.family === "interlock") {
    const o = intersect(guest.nominal, host.nominal);
    dj.allowed = o;
    // Each part keeps half the wood where they cross, so a cut there takes what holds the joint.
    for (const [part, face] of sh
      ? ([
          [host, sh.host],
          [guest, sh.guest],
        ] as const)
      : []) {
      for (const c of cutsInBox(part, face, o)) {
        cutJoint(`${cutWords([c])} on ${part.id} takes ${size2(c)} of wood from inside the ${name}, where both parts need all of theirs. Move the cut clear of the joint`);
      }
    }
    if (dj.type === "half_lap") {
      // The axis where the overlap runs through both parts' full thickness.
      const t = AXES.find((a) => Math.abs(span(o, a) - span(host.nominal, a)) < EPS && Math.abs(span(o, a) - span(guest.nominal, a)) < EPS);
      if (!t) {
        dj.problems.push({ severity: "error", message: `A half lap needs ${dj.guest} and ${dj.host} in the same plane, overlapping through their full thickness` });
        return;
      }
      const m = mid(o, t);
      const hostCut = setRange(o, t, m, o.max[AXIS_INDEX[t]]!);
      const guestCut = setRange(o, t, o.min[AXIS_INDEX[t]]!, m);
      dj.depth_mm = span(o, t) / 2;
      const [a1, a2] = AXES.filter((a) => a !== t) as [Axis, Axis];
      for (const [part, other, cut, face] of [
        [host, guest, hostCut, faceOf(t, true)],
        [guest, host, guestCut, faceOf(t, false)],
      ] as const) {
        dj.features.push({ kind: "removed", part: part.id, box: cut });
        part.machining.push({
          joint: dj.id,
          type: dj.type,
          label: "half lap",
          with: other.id,
          face,
          depth_mm: span(o, t) / 2,
          width_mm: span(o, a1),
          length_mm: span(o, a2),
          region: cut,
        });
      }
      return;
    }
    // Box joint: fingers run across the boards' shared width.
    const f = AXES.find((a) => a !== host.thickness_axis && a !== guest.thickness_axis);
    if (!f || host.thickness_axis === guest.thickness_axis) {
      dj.problems.push({ severity: "error", message: `A box joint needs ${dj.guest} and ${dj.host} meeting at a corner, at right angles` });
      return;
    }
    const width = span(o, f);
    const n = Math.max(1, Math.round(width / (p.finger ?? width)));
    const w = width / n;
    dj.params.finger = w;
    const start = o.min[AXIS_INDEX[f]]!;
    for (let i = 0; i < n; i++) {
      const slice = setRange(o, f, start + i * w, start + (i + 1) * w);
      // The host keeps the even fingers, the guest the odd ones.
      dj.features.push({ kind: "removed", part: i % 2 ? host.id : guest.id, box: slice });
    }
    for (const [part, other, parity] of [
      [host, guest, 1],
      [guest, host, 0],
    ] as const) {
      const cutAxis = part.grain_axis;
      part.machining.push({
        joint: dj.id,
        type: dj.type,
        label: "box joint fingers",
        with: other.id,
        face: faceOf(other.thickness_axis, mid(o, other.thickness_axis) > mid(part.nominal, other.thickness_axis)),
        depth_mm: span(o, cutAxis),
        width_mm: w,
        length_mm: width,
        count: Math.floor((n + (parity === 1 ? 0 : 1)) / 2),
        region: o,
      });
    }
    return;
  }

  const axis = dj.axis!;
  const i = AXIS_INDEX[axis];
  const { tAxis, lAxis } = jointAxes(guest, axis);
  // Where the guest meets the host, and which way is into the guest.
  const contact = dj.side === "end" ? host.nominal.min[i]! : host.nominal.max[i]!;
  const intoGuest = dj.side === "end" ? -1 : 1;
  const hostFace = faceOf(axis, dj.side === "start");
  const guestFace = faceOf(axis, dj.side === "end");

  if (dj.family === "housing" || dj.family === "inset") {
    const prism = intersect(guest.box, host.box);
    dj.allowed = prism;
    let tongue = prism;
    const ti = AXIS_INDEX[tAxis];
    if (dj.family === "inset") {
      const t = Math.min(p.thickness ?? span(prism, tAxis), span(prism, tAxis));
      const c = mid(prism, tAxis);
      tongue = setRange(tongue, tAxis, c - t / 2, c + t / 2);
      if (dj.type === "dado_rabbet") {
        // The tongue sits on the face away from the host's nearer end, so the dado leaves the most wood beyond it.
        const nearMax = host.nominal.max[ti]! - prism.max[ti]! < prism.min[ti]! - host.nominal.min[ti]!;
        tongue = nearMax ? setRange(tongue, tAxis, prism.min[ti]!, prism.min[ti]! + t) : setRange(tongue, tAxis, prism.max[ti]! - t, prism.max[ti]!);
      }
      if (dj.type === "mortise_tenon") {
        const s = p.shoulder ?? 0;
        tongue = setRange(tongue, lAxis, prism.min[AXIS_INDEX[lAxis]]! + s, prism.max[AXIS_INDEX[lAxis]]! - s);
      }
    }
    // A stopped housing runs only to its stop, and the guest is notched beyond it.
    const stopped = canStop(dj.type) ? stopHousing(dj, host, guest, tongue, axis, tAxis, lAxis, issues) : null;
    if (stopped) tongue = stopped.tongue;
    // A groove cut to a set width is that wide, centred on the panel, and the fit is the rest.
    const extra = dj.type === "groove" && p.width !== undefined ? p.width - span(tongue, tAxis) : fit;
    const housing = setRange(tongue, tAxis, tongue.min[ti]! - extra / 2, tongue.max[ti]! + extra / 2);
    dj.features.push({ kind: "tongue", part: guest.id, box: tongue });
    dj.features.push({ kind: "removed", part: host.id, box: housing });
    const hostLabel = dj.type === "mortise_tenon" ? "mortise" : dj.type === "tongue" ? "groove for tongue" : dj.type === "dado_rabbet" ? "dado for tongue" : dj.type;
    if (sh && dj.type === "mortise_tenon") {
      // A mortise needs wood all round, and a tenon needs its whole width.
      for (const c of cutsInBox(host, sh.host, housing)) {
        cutJoint(
          `${cutWords([c])} on ${host.id} breaks into the mortise for ${guest.id}, over ${fmt(runOf(c, lAxis, housing))} mm of its ${fmt(span(housing, lAxis))} mm length. A mortise needs wood all round, so move the cut clear of it`,
        );
      }
      const endAt = dj.side === "end" ? guest.nominal.max[i]! : guest.nominal.min[i]!;
      const end = setRange(tongue, axis, endAt, endAt);
      for (const c of cutsInBox(guest, sh.guest, end)) {
        cutJoint(
          `${cutWords([c])} on ${guest.id} takes wood from under its tenon, over ${fmt(runOf(c, lAxis, tongue))} mm of its ${fmt(span(tongue, lAxis))} mm width. Move the cut clear of the tenon, or set the tenon in further with a bigger shoulder`,
        );
      }
    } else if (sh) {
      // A housing runs out through an edge cut the way it runs out of a blank's edge, but a cutout across it leaves a gap in it.
      for (const c of cutsInBox(host, sh.host, housing, ["cutout"])) {
        issues.push({
          severity: "warning",
          code: "housing_runs_out",
          message: `Joint ${dj.id}: the ${hostLabel} for ${guest.id} in ${host.id} runs out into ${cutWords([c])} for ${fmt(runOf(c, lAxis, housing))} mm, so ${guest.id} shows there and has less to hold it. Move the cut clear, unless that's the look you want`,
          parts: [dj.host, dj.guest],
        });
      }
    }
    host.machining.push({
      joint: dj.id,
      type: dj.type,
      label: hostLabel,
      with: guest.id,
      face: hostFace,
      depth_mm: dj.depth_mm ?? 0,
      width_mm: span(tongue, tAxis) + extra,
      length_mm: span(tongue, lAxis),
      region: housing,
      ...(stopped ? { stop_mm: stopped.stop_mm } : {}),
    });
    if (dj.family === "inset") {
      guest.machining.push({
        joint: dj.id,
        type: dj.type,
        label: dj.type === "mortise_tenon" ? "tenon" : "tongue",
        with: host.id,
        face: guestFace,
        depth_mm: dj.depth_mm ?? 0,
        width_mm: span(tongue, tAxis),
        length_mm: span(tongue, lAxis),
        region: tongue,
        ...(dj.type === "dado_rabbet" ? { flush: faceOf(tAxis, tongue.max[ti]! >= guest.box.max[ti]! - EPS) } : {}),
      });
    }
    return;
  }

  // Fasteners: spread evenly along the edge that meets the host, over the wood its cuts leave.
  if (dj.type === "butt") return;
  const patch = intersect(guest.nominal, host.nominal);
  patch.min[i] = contact;
  patch.max[i] = contact;
  const n = Math.max(1, p.count ?? 1);
  const lo = patch.min[AXIS_INDEX[lAxis]]!;
  const cT = mid(patch, tAxis);
  const spots = sh?.contact ? fastenerStretches(sh.contact, axis, tAxis, cT) : [];
  const len = spots.length ? spots.reduce((s, [a, b]) => s + b - a, 0) : patch.max[AXIS_INDEX[lAxis]]! - lo;
  const at = (k: number, along: number, across = cT): Vec3 => {
    const v: Vec3 = [0, 0, 0];
    v[AXIS_INDEX[lAxis]] = spots.length ? spreadOver(spots, k, n) : lo + ((k + 0.5) / n) * len;
    v[AXIS_INDEX[tAxis]] = across;
    v[i] = along;
    return v;
  };
  if (dj.type === "domino") {
    const centres = Array.from({ length: n }, (_, k) => at(k, contact)[AXIS_INDEX[lAxis]]!);
    dominoDetail(dj, host, guest, sh, issues, { axis, tAxis, lAxis, contact, intoGuest, hostFace, guestFace, across: cT, centres });
    return;
  }
  const dia = p.diameter ?? 4;
  const hostDepth = span(host.nominal, axis);
  for (let k = 0; k < n; k++) {
    if (dj.type === "screws") {
      const from = contact - intoGuest * hostDepth;
      dj.features.push({ kind: "fastener", part: host.id, from: at(k, from), to: at(k, from + intoGuest * (p.length ?? hostDepth + 25)), diameter_mm: dia });
    } else if (dj.type === "dowels") {
      const L = p.length ?? 30;
      dj.features.push({ kind: "fastener", part: guest.id, from: at(k, contact - (intoGuest * L) / 2), to: at(k, contact + (intoGuest * L) / 2), diameter_mm: dia });
    } else if (dj.type === "pocket_screws") {
      // Driven from a pocket in the guest's hidden face, angled into the host.
      const hidden = guest.nominal.min[AXIS_INDEX[tAxis]]! + span(guest.nominal, tAxis) * 0.25;
      const L = p.length ?? 30;
      dj.features.push({
        kind: "fastener",
        part: guest.id,
        from: at(k, contact + intoGuest * (L * 0.8), hidden),
        to: at(k, contact - intoGuest * Math.min(L * 0.4, hostDepth * 0.6)),
        diameter_mm: dia,
      });
    }
  }
  const base = { joint: dj.id, type: dj.type, count: n, diameter_mm: dia, length_mm: len, width_mm: dia, region: patch };
  if (dj.type === "screws") {
    host.machining.push({ ...base, label: "screw holes", with: guest.id, face: faceOf(axis, dj.side === "end"), depth_mm: hostDepth });
  } else if (dj.type === "dowels") {
    const L = p.length ?? 30;
    host.machining.push({ ...base, label: "dowel holes", with: guest.id, face: hostFace, depth_mm: L / 2 + 1 });
    guest.machining.push({ ...base, label: "dowel holes", with: host.id, face: guestFace, depth_mm: L / 2 + 1 });
  } else if (dj.type === "pocket_screws") {
    guest.machining.push({ ...base, label: "pocket holes", with: host.id, face: faceOf(tAxis, false), depth_mm: 0 });
  }
}

/** A Domino's mortise, as machining reads it. */
export const DOMINO_MORTISE = "domino mortise";

/** Where a Domino joint sits, worked out the way any fastener's is. */
interface DominoPlace {
  axis: Axis;
  tAxis: Axis;
  lAxis: Axis;
  /** Where the parts meet on the joint axis, and which way is into the guest. */
  contact: number;
  intoGuest: number;
  hostFace: Face;
  guestFace: Face;
  /** The middle of the joint across the guest's thickness. */
  across: number;
  /** Each Domino's centre along the joint, in order. */
  centres: number[];
}

/**
 * A Domino joint: a pair of matching mortises for each tenon, one in each
 * part, centred on the guest's thickness. The guest's are cut tight, and so
 * is the host's nearest the front, top or right, which lines the joint up.
 * The host's others are longer by the fit, the play Festool's slot
 * principle leaves. Each mortise is machining of its own, so the cut list
 * and the drawings place every one. The tenon sits at the bottom of the
 * guest's mortise, where it's glued first.
 */
function dominoDetail(dj: DerivedJoint, host: DerivedPart, guest: DerivedPart, sh: JointShape | null, issues: DeriveIssue[], at: DominoPlace) {
  const p = dj.params;
  const size = dominoSize(p.thickness, p.length);
  const dh = p.depth ?? 0;
  const dg = dominoGuestDepth(p);
  // The joint's own checks say what's wrong with a size or a depth the DF 500 can't cut.
  if (!size || dg === undefined || dh <= 0 || dh >= size.length_mm) return;
  const { axis, tAxis, lAxis, contact, intoGuest, across, centres } = at;
  const T = size.thickness_mm;
  const W = size.width_mm;
  const play = Math.max(0, p.fit ?? 0);
  const along = (a: number, b: number): [number, number] => [Math.min(a, b), Math.max(a, b)];
  const boxOf = (c: number, long: number, [a, b]: [number, number]): Box => {
    const box = zeroBox();
    box.min[AXIS_INDEX[lAxis]] = c - long / 2;
    box.max[AXIS_INDEX[lAxis]] = c + long / 2;
    box.min[AXIS_INDEX[tAxis]] = across - T / 2;
    box.max[AXIS_INDEX[tAxis]] = across + T / 2;
    box.min[AXIS_INDEX[axis]] = a;
    box.max[AXIS_INDEX[axis]] = b;
    return box;
  };
  const tight = centres.length - 1;
  const inHost: Box[] = [];
  const inGuest: Box[] = [];
  centres.forEach((c, k) => {
    const slack = k === tight ? 0 : play;
    const h = boxOf(c, W + slack, along(contact, contact - intoGuest * dh));
    const g = boxOf(c, W, along(contact, contact + intoGuest * dg));
    inHost.push(h);
    inGuest.push(g);
    dj.features.push(
      { kind: "removed", part: host.id, box: h },
      { kind: "removed", part: guest.id, box: g },
      { kind: "tongue", part: guest.id, box: boxOf(c, W, along(contact + intoGuest * dg, contact + intoGuest * (dg - size.length_mm))) },
    );
    const base = { joint: dj.id, type: dj.type, label: DOMINO_MORTISE };
    host.machining.push({ ...base, with: guest.id, face: at.hostFace, depth_mm: dh, width_mm: T, length_mm: W + slack, ...(slack > 0 ? { play_mm: slack } : {}), region: h });
    guest.machining.push({ ...base, with: host.id, face: at.guestFace, depth_mm: dg, width_mm: T, length_mm: W, region: g });
  });

  // Each mortise needs wood beside it along the joint, and none may run into the next.
  const li = AXIS_INDEX[lAxis];
  const [loEdge, hiEdge] = AXIS_FACES[lAxis];
  const problem = (severity: Severity, message: string) => issues.push({ severity, code: "domino_mortise", message: `Joint ${dj.id}: ${message}`, parts: [dj.host, dj.guest] });
  for (const [part, boxes] of [
    [host, inHost],
    [guest, inGuest],
  ] as const) {
    const lo = boxes[0]!.min[li]! - part.nominal.min[li]!;
    const hi = part.nominal.max[li]! - boxes[boxes.length - 1]!.max[li]!;
    const [wall, edge] = lo <= hi ? [lo, loEdge] : [hi, hiEdge];
    if (wall <= EPS) problem("error", `a Domino mortise breaks out of ${part.id}'s ${edge} edge. Use fewer Dominos or a smaller size`);
    else if (wall < DOMINO_WALL_MM - 1e-9) {
      problem("warning", `a Domino mortise is ${fmt(wall)} mm from ${part.id}'s ${edge} edge, and wood that thin breaks out. Leave at least ${DOMINO_WALL_MM} mm, with fewer Dominos or a smaller size`);
    }
    let gap = Infinity;
    for (let k = 1; k < boxes.length; k++) gap = Math.min(gap, boxes[k]!.min[li]! - boxes[k - 1]!.max[li]!);
    if (gap <= EPS) problem("error", `${boxes.length} Dominos don't fit along the joint, since their mortises in ${part.id} run into each other. Use fewer`);
    else if (gap < DOMINO_WALL_MM - 1e-9) {
      problem("warning", `${fmt(gap)} mm of ${part.id} is left between two Domino mortises, and wood that thin breaks out. Leave at least ${DOMINO_WALL_MM} mm, with fewer Dominos`);
    }
  }
  // A mortise needs wood all round, so a cut into one takes what holds the tenon.
  for (const [part, face, boxes, other] of sh
    ? ([
        [host, sh.host, inHost, guest],
        [guest, sh.guest, inGuest, host],
      ] as const)
    : []) {
    const hit = new Map<string, CutInBox>();
    for (const b of boxes) for (const c of cutsInBox(part, face, b)) if (!hit.has(c.id)) hit.set(c.id, c);
    for (const c of hit.values()) {
      issues.push({
        severity: "error",
        code: "cut_joint",
        message: `Joint ${dj.id}: ${cutWords([c])} on ${part.id} breaks into a Domino mortise for ${other.id}. A mortise needs wood all round, so move the cut clear of it`,
        parts: [dj.host, dj.guest],
      });
    }
  }
}

/**
 * A Domino's mortise that runs into other machining in its part, such as a
 * dado or another joint's mortise, is an error. Each pair is named once.
 */
function dominoCollisions(parts: DerivedPart[], issues: DeriveIssue[]) {
  const named = new Set<string>();
  for (const p of parts) {
    for (const m of p.machining) {
      if (m.label !== DOMINO_MORTISE) continue;
      for (const o of p.machining) {
        if (o.joint === m.joint || !boxesOverlap(m.region, o.region)) continue;
        const key = `${p.id}|${[m.joint, o.joint].sort().join("|")}`;
        if (named.has(key)) continue;
        named.add(key);
        const what = o.label === DOMINO_MORTISE ? `a Domino mortise for ${o.with}` : `the ${o.label} for ${o.with}`;
        issues.push({
          severity: "error",
          code: "domino_mortise",
          message: `Joint ${m.joint}: a Domino mortise in ${p.id} runs into ${what}, from joint ${o.joint}. Move the Dominos clear of it, or use fewer`,
          parts: [p.id],
        });
      }
    }
  }
}

export function derive(design: Design): DeriveResult {
  const r = new Resolver(design);
  const issues: DeriveIssue[] = [];
  const params: Derived["params"] = {};

  for (const p of design.params) {
    try {
      const v = r.param(p.name);
      params[p.name] = { value: v.value, text: v.text };
    } catch (e) {
      params[p.name] = { error: (e as Error).message };
      issues.push({ severity: "error", code: "param_error", message: `Parameter ${p.name}: ${(e as Error).message}`, parts: [] });
    }
  }

  // Expand arrays into part refs.
  const refs: string[] = [];
  for (const p of design.parts) {
    refs.push(p.id);
    const arr = r.arrayOf(p.id);
    if (!arr) continue;
    try {
      const { count } = r.arrayInfo(arr);
      for (let k = 2; k <= count; k++) refs.push(`${p.id}#${k}`);
    } catch (e) {
      issues.push({ severity: "error", code: "array_error", message: (e as Error).message, parts: [p.id] });
    }
  }

  const parts: DerivedPart[] = [];
  const byId = new Map<string, DerivedPart>();
  for (const ref of refs) {
    const panel = r.partFor(ref);
    const { copy } = partRefParts(ref);
    const widthAxis = otherAxis(panel.grain_axis, panel.thickness_axis);
    let broken = false;
    const axes = {} as Record<Axis, AxisTrace>;
    const nominal = zeroBox();
    for (const a of AXES) {
      try {
        const t = r.axis(ref, a);
        axes[a] = t;
        nominal.min[AXIS_INDEX[a]] = t.start.value;
        nominal.max[AXIS_INDEX[a]] = t.end.value;
      } catch (e) {
        broken = true;
        axes[a] = { start: emptyStep, end: emptyStep, size: emptyStep };
        if (copy === 1) {
          issues.push({ severity: "error", code: "geometry_error", message: `${ref}: ${(e as Error).message}`, parts: [ref] });
        }
      }
    }
    if (!broken && copy === 1) {
      for (const a of AXES) {
        if (axes[a].size.value <= EPS) {
          issues.push({
            severity: "error",
            code: "non_positive_size",
            message: `${ref} has no room along ${a}: its size works out to ${fmt(axes[a].size.value)} mm`,
            parts: [ref],
            trace: `size = ${axes[a].size.text}`,
          });
        }
      }
    }
    const dp: DerivedPart = {
      id: ref,
      source: panel.id,
      copy,
      name: copy === 1 ? panel.name : `${panel.name} ${copy}`,
      material: panel.material,
      thickness_axis: panel.thickness_axis,
      grain_axis: panel.grain_axis,
      width_axis: widthAxis,
      tags: panel.tags ?? [],
      decor: panel.decor ?? false,
      unverified: false,
      broken,
      nominal,
      box: cloneBox(nominal),
      axes,
      extensions: [],
      machining: [],
      finished: dimsOf(nominal, panel.grain_axis, widthAxis, panel.thickness_axis),
      cut: dimsOf(nominal, panel.grain_axis, widthAxis, panel.thickness_axis),
    };
    parts.push(dp);
    byId.set(ref, dp);
  }

  for (const u of design.unverified) {
    const box: Box = { min: [...u.min_mm], max: [...u.max_mm] };
    const step = (v: number): Step => ({ value: v, text: `set directly (${fmt(v)})` });
    const axes = {} as Record<Axis, AxisTrace>;
    for (const a of AXES) {
      const i = AXIS_INDEX[a];
      axes[a] = { start: step(box.min[i]), end: step(box.max[i]), size: step(box.max[i] - box.min[i]) };
    }
    const dp: DerivedPart = {
      id: u.id,
      source: u.id,
      copy: 1,
      name: u.name,
      material: "",
      thickness_axis: "z",
      grain_axis: "x",
      width_axis: "y",
      tags: ["unverified"],
      decor: false,
      unverified: true,
      broken: false,
      nominal: box,
      box: cloneBox(box),
      axes,
      extensions: [],
      machining: [],
      finished: dimsOf(box, "x", "y", "z"),
      cut: dimsOf(box, "x", "y", "z"),
    };
    parts.push(dp);
    byId.set(u.id, dp);
  }

  // Each part's shape on its blank, once every nominal box is known. An
  // original is solved once, and its copies share it.
  const faces = new Map<string, SolvedFace | null>();
  const panels = new Map(design.parts.map((p) => [p.id, p]));
  for (const p of parts) {
    const panel = panels.get(p.source);
    if (p.broken || p.unverified || !panel?.cuts?.length || faces.has(p.source)) continue;
    const original = byId.get(p.source)!;
    let face: SolvedFace | null = null;
    try {
      if (!original.broken) face = solveFace(panel, original.nominal, r.cutValues(panel), issues);
    } catch (e) {
      // Each cut's own problems are caught inside. This is for the shape itself, so a bad one never stops the rest.
      issues.push({ severity: "error", code: "cut_error", message: `The shape of ${panel.id} couldn't be worked out: ${(e as Error).message}`, parts: [panel.id] });
    }
    faces.set(p.source, face);
  }
  const faceFor = (p: DerivedPart) => (p.broken || p.unverified ? null : (faces.get(p.source) ?? null));
  // A part split in two is already an error, and its joints sit on its blank until it's whole again.
  const shapeOf = (host: DerivedPart, guest: DerivedPart): JointShape | null => {
    const whole = (p: DerivedPart) => {
      const f = faceFor(p);
      return f && !f.severed ? f : null;
    };
    const h = whole(host);
    const g = whole(guest);
    return h || g ? { host: h, guest: g } : null;
  };
  /**
   * A joint refused because cuts took all the wood it would sit on. It names
   * the cuts on whichever part has no wood left there, or on both.
   */
  const onCut = (dj: DerivedJoint, sh: JointShape, host: DerivedPart, guest: DerivedPart, patch: Box, where: string, name: string, bare: ("host" | "guest")[] = []) => {
    const found = [
      { part: guest.id, cuts: bare.length && !bare.includes("guest") ? [] : cutsInBox(guest, sh.guest, patch) },
      { part: host.id, cuts: bare.length && !bare.includes("host") ? [] : cutsInBox(host, sh.host, patch) },
    ].filter((x) => x.cuts.length);
    const count = found.reduce((n, x) => n + new Set(x.cuts.map((c) => c.id)).size, 0);
    const words = found.length ? found.map((x) => `${cutWords(x.cuts)} on ${x.part}`).join(" and ") : `the cuts on ${dj.guest} and ${dj.host}`;
    issues.push({
      severity: "error",
      code: "joint_on_cut",
      message: `Joint ${dj.id}: ${words} ${count === 1 ? "takes" : "take"} away all the wood where ${dj.guest} ${where} ${dj.host}, so the ${name} can't be placed. Move the cut, or join the parts somewhere else`,
      parts: [dj.host, dj.guest],
    });
  };
  /** Whether a joint's two parts overlap as you see them, each as its shape or its box. */
  const shapesOverlap = (sh: JointShape, host: DerivedPart, guest: DerivedPart) => {
    const seen = (p: DerivedPart, face: SolvedFace | null) => partPrism(face ? { ...p, profile: profileFor(face, []) } : p, "seen");
    return prismsOverlap(seen(guest, sh.guest), seen(host, sh.host), EPS);
  };

  // Expand joints and hardware across arrays.
  const copiesFor = (ids: string[]): { k: number; map: (id: string) => string }[] => {
    const arrays = new Set(ids.map((id) => r.arrayOf(id)).filter((a): a is ArrayPattern => !!a));
    const out = [{ k: 1, map: (id: string) => id }];
    if (arrays.size === 0) return out;
    let count = Infinity;
    for (const a of arrays) {
      try {
        count = Math.min(count, r.arrayInfo(a).count);
      } catch {
        count = 1;
      }
    }
    for (let k = 2; k <= count; k++) {
      out.push({ k, map: (id: string) => (r.arrayOf(id) ? `${id}#${k}` : id) });
    }
    return out;
  };

  /** Why a copy a joint names isn't there, such as a count turned down below it. */
  const copyGone = (ref: string): string => {
    const { source } = partRefParts(ref);
    const arr = r.arrayOf(source);
    if (!byId.has(source)) return `there's no part ${source}`;
    if (!arr) return `${source} isn't in an array, so there's no ${ref}`;
    try {
      const { count } = r.arrayInfo(arr);
      return `array ${arr.id} has ${count} ${count === 1 ? "item" : "items"}, so there's no ${ref}`;
    } catch {
      return `array ${arr.id}'s count can't be worked out, so there's no ${ref}`;
    }
  };

  const joints: DerivedJoint[] = [];
  const placed: { dj: DerivedJoint; host: DerivedPart; guest: DerivedPart; sh: JointShape | null }[] = [];
  for (const j of design.joints) {
    const family = JOINT_FAMILY[j.type];
    // A joint that names one copy, such as shelf#2, joins the two parts it names, once.
    const onCopy = namesCopy(j.host) || namesCopy(j.guest);
    for (const { k, map } of onCopy ? [{ k: 1, map: jointPartId }] : copiesFor([j.host, j.guest])) {
      const dj: DerivedJoint = {
        id: k === 1 ? j.id : `${j.id}#${k}`,
        source: j.id,
        type: j.type,
        family,
        host: map(j.host),
        guest: map(j.guest),
        params: {},
        defaulted: [],
        features: [],
        problems: [],
      };
      if (j.count !== undefined) dj.count = j.count;
      if (onCopy) dj.on_copy = true;
      joints.push(dj);
      const host = byId.get(dj.host);
      const guest = byId.get(dj.guest);
      if (onCopy && (!host || !guest)) {
        const ref = host ? j.guest : j.host;
        issues.push({
          severity: "error",
          code: "joint_copy_missing",
          message: `Joint ${j.id} names ${ref}, but ${copyGone(ref)}. It joins that one copy, so it can't be placed. Delete it, or add it again on a copy that's there`,
          parts: [host, guest].filter((p): p is DerivedPart => !!p).map((p) => p.id),
        });
        continue;
      }
      if (!host || !guest || host.broken || guest.broken) continue;
      const name = JOINT_LIBRARY[j.type].name.toLowerCase();

      if (family === "through") {
        // The guest must stick out of the host on both sides along one axis.
        const pass = AXES.find((a) => {
          const i = AXIS_INDEX[a];
          return guest.nominal.min[i]! < host.nominal.min[i]! - EPS && guest.nominal.max[i]! > host.nominal.max[i]! + EPS;
        });
        if (!boxesOverlap(guest.nominal, host.nominal) || !pass) {
          issues.push({
            severity: "error",
            code: "joint_not_touching",
            message: `Joint ${dj.id}: ${dj.guest} must pass right through ${dj.host} and stick out both sides. For a part that stops inside it, use mortise_tenon or a housing`,
            parts: [dj.host, dj.guest],
          });
          continue;
        }
        const sh = shapeOf(host, guest);
        if (sh && !shapesOverlap(sh, host, guest)) {
          onCut(dj, sh, host, guest, intersect(guest.nominal, host.nominal), "passes through", name);
          continue;
        }
        const ctx: JointContext = {
          guestThickness: guest.finished.thickness,
          guestWidth: guest.finished.width,
          hostThickness: host.finished.thickness,
          hostDepth: host.nominal.max[AXIS_INDEX[pass]]! - host.nominal.min[AXIS_INDEX[pass]]!,
          hostAcross: host.finished.thickness,
          slotWalls: slotWalls(host, intersect(guest.nominal, host.nominal), pass, sh?.host ?? null),
        };
        if (!resolveJointParams(j, dj, ctx, r, issues)) continue;
        dj.axis = pass;
        placed.push({ dj, host, guest, sh });
        continue;
      }

      if (family === "interlock") {
        if (!boxesOverlap(guest.nominal, host.nominal)) {
          issues.push({
            severity: "error",
            code: "joint_not_touching",
            message: `Joint ${dj.id}: a ${name} needs ${dj.guest} and ${dj.host} to overlap where they join. Run both parts through the joint`,
            parts: [dj.host, dj.guest],
          });
          continue;
        }
        const o = intersect(guest.nominal, host.nominal);
        const sh = shapeOf(host, guest);
        if (sh && !shapesOverlap(sh, host, guest)) {
          onCut(dj, sh, host, guest, o, "crosses", name);
          continue;
        }
        const sizeOf = (b: Box, a: Axis) => b.max[AXIS_INDEX[a]]! - b.min[AXIS_INDEX[a]]!;
        const ctx: JointContext = {
          guestThickness: guest.finished.thickness,
          guestWidth: guest.finished.width,
          hostThickness: host.finished.thickness,
          hostDepth: sizeOf(o, host.thickness_axis),
          hostAcross: host.finished.thickness,
        };
        if (!resolveJointParams(j, dj, ctx, r, issues)) continue;
        placed.push({ dj, host, guest, sh });
        continue;
      }

      const touch = touching(guest.nominal, host.nominal);
      if (!touch) {
        issues.push({
          severity: family === "fastener" ? "warning" : "error",
          code: "joint_not_touching",
          message: `Joint ${dj.id}: ${dj.guest} doesn't touch ${dj.host}, so the ${name} can't be placed. Position the guest against a face of the host first`,
          parts: [dj.host, dj.guest],
        });
        continue;
      }
      // The joint sits where both parts still have wood once their cuts are made.
      const sh = shapeOf(host, guest);
      if (sh) {
        const at = touch.side === "end" ? host.nominal.min[AXIS_INDEX[touch.axis]]! : host.nominal.max[AXIS_INDEX[touch.axis]]!;
        const patch = setRange(intersect(guest.nominal, host.nominal), touch.axis, at, at);
        const wood = contactWood(
          { part: guest, face: sh.guest, on: faceOf(touch.axis, touch.side === "end") },
          { part: host, face: sh.host, on: faceOf(touch.axis, touch.side === "start") },
          touch.axis,
          patch,
        );
        const longest = Math.max(...AXES.filter((a) => a !== touch.axis).map((a) => patch.max[AXIS_INDEX[a]]! - patch.min[AXIS_INDEX[a]]!));
        if (wood.area <= EPS * longest) {
          // Which part has no wood there on its own.
          const alone = (who: "host" | "guest") =>
            contactWood(
              { part: guest, face: who === "guest" ? sh.guest : null, on: faceOf(touch.axis, touch.side === "end") },
              { part: host, face: who === "host" ? sh.host : null, on: faceOf(touch.axis, touch.side === "start") },
              touch.axis,
              patch,
            ).area <= EPS * longest;
          onCut(dj, sh, host, guest, patch, "meets", name, (["guest", "host"] as const).filter(alone));
          continue;
        }
        sh.contact = wood.loops;
      }
      dj.axis = touch.axis;
      dj.side = touch.side;
      const { tAxis, lAxis } = jointAxes(guest, touch.axis);
      const size = (p: DerivedPart, a: Axis) => p.nominal.max[AXIS_INDEX[a]]! - p.nominal.min[AXIS_INDEX[a]]!;
      const ti = AXIS_INDEX[tAxis];
      const ctx: JointContext = {
        guestThickness: size(guest, tAxis),
        guestWidth: size(guest, lAxis),
        hostThickness: host.finished.thickness,
        hostDepth: size(host, touch.axis),
        hostAcross: size(host, tAxis),
        guestDepth: size(guest, touch.axis),
        housingWalls: [
          Math.max(guest.nominal.min[ti]!, host.nominal.min[ti]!) - host.nominal.min[ti]!,
          host.nominal.max[ti]! - Math.min(guest.nominal.max[ti]!, host.nominal.max[ti]!),
        ],
      };
      if (!resolveJointParams(j, dj, ctx, r, issues)) continue;
      resolveStops(j, dj, lAxis, r, issues);
      if (family === "housing" || family === "inset") {
        const depth = dj.params.depth ?? 0;
        dj.depth_mm = depth;
        const i = AXIS_INDEX[touch.axis];
        if (touch.side === "end") guest.box.max[i] = guest.box.max[i]! + depth;
        else guest.box.min[i] = guest.box.min[i]! - depth;
        guest.extensions.push({ joint: dj.id, host: dj.host, axis: touch.axis, side: touch.side, depth_mm: depth });
      }
      placed.push({ dj, host, guest, sh });
    }
  }

  // Joint detail is worked out once every guest has its final size, so each
  // housing matches the tongue that goes into it.
  for (const { dj, host, guest, sh } of placed) {
    jointDetail(dj, host, guest, sh, issues);
    if (!dj.on_copy) continue;
    // Machining from a joint on one copy names the other part as the joint does, so the
    // cut list keeps its copy's number. An array's original alone reads as shelf#1.
    const named = (p: DerivedPart) => (p.copy === 1 && r.arrayOf(p.source) ? `${p.id}#1` : p.id);
    for (const [part, other] of [
      [host, guest],
      [guest, host],
    ] as const) {
      for (const m of part.machining) if (m.joint === dj.id) Object.assign(m, { with: named(other), on_copy: true });
    }
  }
  dominoCollisions(parts, issues);

  for (const p of parts) {
    p.cut = dimsOf(p.box, p.grain_axis, p.width_axis, p.thickness_axis);
  }

  // Each profile carries its own part's housings, over the stretches of each end no cut touched.
  for (const p of parts) {
    const face = faceFor(p);
    if (face) p.profile = profileFor(face, p.extensions);
  }

  const hardware: DerivedHardware[] = [];
  for (const h of design.hardware as Hardware[]) {
    // Where the model sits. Copies in an array move with their parts.
    let origin: Vec3 | null = null;
    if (h.place && h.shape) {
      try {
        origin = [h.place.x, h.place.y, h.place.z].map((e) => evaluateNumber(e, r.value).value) as Vec3;
      } catch (e) {
        issues.push({ severity: "error", code: "hardware_error", message: `Hardware ${h.id}: ${(e as Error).message}`, parts: [] });
      }
    }
    const arr = h.connects.map((id) => r.arrayOf(id)).find((a): a is ArrayPattern => !!a);
    for (const { k, map } of copiesFor(h.connects)) {
      const boxes: Box[] = [];
      if (origin && h.shape) {
        const shift: Vec3 = [0, 0, 0];
        if (arr && k > 1) shift[AXIS_INDEX[arr.axis]] = r.arrayInfo(arr).pitch * (k - 1);
        const at = origin.map((v, i) => v + shift[i]!) as Vec3;
        for (const b of h.shape) boxes.push(placeBox(b, at, h.place!.length_axis ?? "x"));
      }
      const dh: DerivedHardware = {
        id: k === 1 ? h.id : `${h.id}#${k}`,
        source: h.id,
        kind: h.kind,
        name: h.name,
        connects: h.connects.map(map),
        qty: h.qty,
        spec: h.spec ?? {},
        boxes,
        on_floor: !!h.on_floor,
      };
      if (h.library_part) dh.library_part = h.library_part;
      hardware.push(dh);
    }
  }

  // gap_x, gap_y and gap_z measure between the shapes you see, once every one is known.
  const gap: GapResolver = (axis, a, b) => {
    const solid = (ref: string) => {
      const p = byId.get(ref);
      if (!p) {
        r.partFor(ref);
        throw new ExprError(`Unknown part "${ref}"`);
      }
      if (p.broken) throw new ExprError(`${ref}'s size couldn't be worked out, so gap_${axis} can't measure to it`);
      return partPrism(p, "seen");
    };
    const g = prismGap(solid(a), solid(b), axis, EPS);
    if (g === null) {
      throw new ExprError(`seen along ${axis}, ${a} and ${b} don't cover any of each other, so gap_${axis} has nothing to measure. Use the axis they're apart on`);
    }
    return g;
  };

  // overall.width and the like read the box around every part, once every one is known.
  const overall = wholePiece(parts);
  const value = (name: string) => (name.startsWith(`${OVERALL}.`) && !byId.has(OVERALL) ? overallValue(overall, name) : r.value(name));

  return {
    params,
    parts,
    joints,
    hardware,
    issues,
    byId,
    overall,
    evaluate: (expr: string) => evaluate(expr, value, gap),
  };
}

/**
 * The box around every part, stand-ins included, and the part at each end
 * of each axis. Props and hardware aren't in it. The first part in the list
 * names an end that several share.
 */
export function wholePiece(parts: readonly DerivedPart[]): WholePiece | { error: string } {
  const solid = parts.filter((p) => !p.decor);
  const broken = solid.find((p) => p.broken);
  if (broken) return { error: `${broken.id}'s size couldn't be worked out` };
  if (!solid.length) return { error: "there are no parts yet" };
  const box = zeroBox();
  const ends = {} as Record<Axis, [string, string]>;
  for (const a of AXES) {
    const i = AXIS_INDEX[a];
    const lo = Math.min(...solid.map((p) => p.nominal.min[i]));
    const hi = Math.max(...solid.map((p) => p.nominal.max[i]));
    box.min[i] = lo;
    box.max[i] = hi;
    ends[a] = [solid.find((p) => p.nominal.min[i] <= lo + EPS)!.id, solid.find((p) => p.nominal.max[i] >= hi - EPS)!.id];
  }
  return { box, ends };
}

function overallValue(whole: WholePiece | { error: string }, name: string): number {
  const prop = name.slice(OVERALL.length + 1);
  if (!OVERALL_NAMES.includes(prop)) {
    throw new ExprError(`"${name}" isn't something the whole piece has. Use overall.width, overall.height, overall.depth or a face such as overall.top`);
  }
  if ("error" in whole) throw new ExprError(`${name} can't be worked out, since ${whole.error}`);
  const axis = OVERALL_SIZES[prop];
  if (axis) return whole.box.max[AXIS_INDEX[axis]] - whole.box.min[AXIS_INDEX[axis]];
  const face = prop as Face;
  const i = AXIS_INDEX[FACE_AXIS[face]];
  return FACE_IS_MAX[face] ? whole.box.max[i] : whole.box.min[i];
}

const OVERALL_SIZE_OF: Record<Axis, string> = { x: "width", y: "height", z: "depth" };

/**
 * Where the whole piece starts and ends along each axis an expression reads
 * it on, with the part at each end, such as "overall.depth runs from
 * back.back (-6) to side_l.front (300)". Empty when it doesn't read it.
 */
export function overallWorking(d: Pick<DeriveResult, "overall" | "byId">, expr: string): string[] {
  if (d.byId.has(OVERALL) || "error" in d.overall) return [];
  let refs: string[];
  try {
    refs = refsOf(expr);
  } catch {
    return [];
  }
  const axes = new Set<Axis>();
  for (const ref of refs) {
    if (!ref.startsWith(`${OVERALL}.`)) continue;
    const prop = ref.slice(OVERALL.length + 1);
    const axis = OVERALL_SIZES[prop] ?? FACE_AXIS[prop as Face];
    if (axis) axes.add(axis);
  }
  const { box, ends } = d.overall;
  return AXES.filter((a) => axes.has(a)).map((a) => {
    const i = AXIS_INDEX[a];
    const [lo, hi] = ends[a];
    return `overall.${OVERALL_SIZE_OF[a]} runs from ${lo}.${faceOf(a, false)} (${fmt(box.min[i])}) to ${hi}.${faceOf(a, true)} (${fmt(box.max[i])})`;
  });
}

/** Strips the functions so the result can be sent as JSON. */
export function toPlain(d: DeriveResult): Derived {
  return { params: d.params, parts: d.parts, joints: d.joints, hardware: d.hardware, issues: d.issues };
}
