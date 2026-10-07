// Issue #66: the exploded view pulls a piece apart the way it goes
// together. Every worked joint comes apart along its joint, a table's base
// drops off its top as one frame before its end frames come off, and the
// record console's drawers slide out the front. Then every part fans out
// from the middle of the piece, up and down as well as out. Solid wood never rests
// inside solid wood: apart, no two parts overlap, and a joint pulled apart
// on its own rests clear of every part. On the way, the whole piece never
// overlaps more than it does together, where a tongue sits in its
// housing. The table is invented: 1200 × 600 × 725 in oak.

import { describe, expect, it } from "vitest";
import {
  applyOps,
  derive,
  emptyDesign,
  explodeJoint,
  explodeOffsets,
  explodePiece,
  hardwareOffset,
  JOINT_TYPES,
  jointExample,
  NO_EXPLOSION,
  recordConsoleOps,
  FAN_OUT,
  runChecks,
  type Box,
  type DerivedPart,
  type Explosion,
  type Op,
  type Vec3,
} from "../src/index.js";

const moved = (b: Box, o: Vec3 | undefined): Box => ({
  min: b.min.map((v, k) => v + (o?.[k] ?? 0)) as Vec3,
  max: b.max.map((v, k) => v + (o?.[k] ?? 0)) as Vec3,
});
const overlap = (a: Box, b: Box) => [0, 1, 2].every((k) => Math.min(a.max[k]!, b.max[k]!) - Math.max(a.min[k]!, b.min[k]!) > 0.01);

/** Pairs of parts whose boxes, tongues included, overlap once fully apart. */
function stillInside(parts: DerivedPart[], e: Explosion): string[] {
  const off = explodeOffsets(e, 1);
  const boxes = parts.map((p) => ({ id: p.id, box: moved(p.box, off.get(p.id)) }));
  const out: string[] = [];
  for (let a = 0; a < boxes.length; a++) {
    for (let b = a + 1; b < boxes.length; b++) if (overlap(boxes[a]!.box, boxes[b]!.box)) out.push(`${boxes[a]!.id} in ${boxes[b]!.id}`);
  }
  return out;
}

const shared = (a: Box, b: Box) => [0, 1, 2].reduce((v, k) => v * Math.max(0, Math.min(a.max[k]!, b.max[k]!) - Math.max(a.min[k]!, b.min[k]!)), 1);

/** Pairs of parts that overlap more, once apart, than they do together: one resting inside another. */
function restsInside(parts: DerivedPart[], e: Explosion): string[] {
  const off = explodeOffsets(e, 1);
  const out: string[] = [];
  for (let a = 0; a < parts.length; a++) {
    for (let b = a + 1; b < parts.length; b++) {
      const p = parts[a]!;
      const q = parts[b]!;
      if (shared(moved(p.box, off.get(p.id)), moved(q.box, off.get(q.id))) > shared(p.box, q.box) + 1) out.push(`${p.id} in ${q.id}`);
    }
  }
  return out;
}

/** Pairs of parts that overlap more, at some point on the way apart, than they do together. */
function passThrough(parts: DerivedPart[], e: Explosion, steps = 2000): string[] {
  const out = new Set<string>();
  for (let s = 0; s <= steps; s++) {
    const off = explodeOffsets(e, s / steps);
    for (let a = 0; a < parts.length; a++) {
      for (let b = a + 1; b < parts.length; b++) {
        const p = parts[a]!;
        const q = parts[b]!;
        if (shared(moved(p.box, off.get(p.id)), moved(q.box, off.get(q.id))) > shared(p.box, q.box) + 1) out.add(`${p.id} through ${q.id}`);
      }
    }
  }
  return [...out];
}

/** The moves that slide parts off their joints, before the last stage fans them out. */
const slides = (e: Explosion) => e.moves.filter((m) => m.stage < e.stages);
/** The last stage: every part carried on away from the middle of the piece, by id. */
const fan = (e: Explosion) => new Map(e.moves.filter((m) => m.stage === e.stages).map((m) => [m.parts[0]!, m.by_mm]));

function table() {
  const leg = (id: string, x: string, z: string): Op => ({
    op: "add_panel",
    id,
    name: "Leg",
    material: "oak45",
    thickness_axis: "z",
    grain_axis: "y",
    x: { start: { at: x }, size: "45" },
    y: { start: { at: "0" }, size: "700" },
    z: { start: { at: z } },
  });
  const rail = (id: string, axis: "x" | "z", at: string, from: string, to: string): Op => ({
    op: "add_panel",
    id,
    name: "Rail",
    material: "oak20",
    thickness_axis: axis === "x" ? "z" : "x",
    grain_axis: axis,
    [axis]: { start: { face: `${from}.${axis === "x" ? "right" : "front"}` }, end: { face: `${to}.${axis === "x" ? "left" : "back"}` } },
    y: { end: { at: "700" }, size: "100" },
    [axis === "x" ? "z" : "x"]: { start: { at } },
  }) as unknown as Op;
  const tenons: [string, string][] = [
    ["rail_front", "leg_fl"],
    ["rail_front", "leg_fr"],
    ["rail_back", "leg_bl"],
    ["rail_back", "leg_br"],
    ["rail_left", "leg_fl"],
    ["rail_left", "leg_bl"],
    ["rail_right", "leg_fr"],
    ["rail_right", "leg_br"],
  ];
  const ops: Op[] = [
    { op: "define_material", id: "oak45", name: "45 mm oak", kind: "solid", thickness_mm: 45, grained: true },
    { op: "define_material", id: "oak20", name: "20 mm oak", kind: "solid", thickness_mm: 20, grained: true },
    { op: "define_material", id: "oak25", name: "25 mm oak", kind: "solid", thickness_mm: 25, grained: true },
    leg("leg_fl", "0", "555"),
    leg("leg_fr", "1155", "555"),
    leg("leg_bl", "0", "0"),
    leg("leg_br", "1155", "0"),
    rail("rail_front", "x", "570", "leg_fl", "leg_fr"),
    rail("rail_back", "x", "10", "leg_bl", "leg_br"),
    rail("rail_left", "z", "12", "leg_bl", "leg_fl"),
    rail("rail_right", "z", "1168", "leg_br", "leg_fr"),
    { op: "add_panel", id: "top", name: "Top", material: "oak25", thickness_axis: "y", grain_axis: "x", x: { start: { at: "-20" }, size: "1240" }, y: { start: { at: "700" } }, z: { start: { at: "-20" }, size: "640" } },
    ...tenons.map(([guest, host]): Op => ({ op: "add_joint", id: `${guest}_${host}`, type: "mortise_tenon", host, guest, depth: "15" })),
    ...["rail_front", "rail_back", "rail_left", "rail_right"].map((guest): Op => ({ op: "add_joint", id: `top_${guest}`, type: "screws", host: "top", guest, count: 3 })),
  ];
  const design = applyOps(emptyDesign("Table"), ops);
  return Object.assign(derive(design), { design });
}

describe("one joint apart", () => {
  it("slides each worked example's guest off its host along the joint, clear of it, and never through the floor", () => {
    for (const type of JOINT_TYPES) {
      const r = derive(jointExample(type));
      const j = r.joints[0]!;
      const e = explodeJoint(r.parts, r.joints, j.id)!;
      expect(e, type).not.toBeNull();
      expect(e.moves).toHaveLength(1);
      // The guest comes off, unless that would take it through the floor, when the host lifts off it instead.
      const mover = e.moves[0]!.parts[0]!;
      expect(mover, type).toBe(type === "butt" || type === "screws" || type === "pocket_screws" || type === "dowels" || type === "domino" ? j.host : j.guest);
      expect(e.passes, type).toEqual([]);
      const by = e.moves[0]!.by_mm;
      // Only one axis moves.
      expect(by.filter((v) => v !== 0), type).toHaveLength(1);
      if (j.axis) expect(by[["x", "y", "z"].indexOf(j.axis)], type).not.toBe(0);
      const still = r.byId.get(mover === j.guest ? j.host : j.guest)!;
      const away = r.byId.get(mover)!;
      expect(overlap(moved(away.box, by), still.box), type).toBe(false);
      expect(away.box.min[1]! + by[1], type).toBeGreaterThanOrEqual(-0.01);
      // The camera frames the joint, apart, within the two parts.
      expect(e.focus.max.every((v, k) => v > e.focus.min[k]!), type).toBe(true);
    }
  });

  it("slides a tenon straight out of its mortise, away from the leg", () => {
    const r = derive(jointExample("mortise_tenon"));
    const j = r.joints[0]!;
    const e = explodeJoint(r.parts, r.joints, j.id)!;
    const k = ["x", "y", "z"].indexOf(j.axis!);
    const away = Math.sign((r.byId.get(j.guest)!.nominal.min[k]! + r.byId.get(j.guest)!.nominal.max[k]!) - (r.byId.get(j.host)!.nominal.min[k]! + r.byId.get(j.host)!.nominal.max[k]!));
    expect(Math.sign(e.moves[0]!.by_mm[k]!)).toBe(away);
    expect(Math.abs(e.moves[0]!.by_mm[k]!)).toBeGreaterThan(j.depth_mm!);
  });

  it("lifts a half lap's guest off the half its host keeps", () => {
    const r = derive(jointExample("half_lap"));
    const e = explodeJoint(r.parts, r.joints, r.joints[0]!.id)!;
    expect(e.moves[0]!.by_mm.find((v) => v !== 0)).toBeGreaterThan(0);
  });

  it("lifts the top off a rail screwed to it, since the rail's tenons hold it in the legs", () => {
    const r = table();
    const e = explodeJoint(r.parts, r.joints, "top_rail_front")!;
    expect(e.moves[0]!.parts).toEqual(["top"]);
    expect(e.moves[0]!.by_mm[1]).toBeGreaterThan(0);
    expect(e.passes).toEqual([]);
  });

  it("slides the leg off a rail held at both ends, through the other rail's tenon, and rests it clear", () => {
    const r = table();
    const e = explodeJoint(r.parts, r.joints, "rail_front_leg_fl")!;
    // The rail would have to clear the far leg, so the leg comes off the rail instead.
    expect(e.moves[0]!.parts).toEqual(["leg_fl"]);
    expect(e.moves[0]!.by_mm[0]).toBeLessThan(0);
    expect(e.passes).toEqual(["rail_left"]);
    expect(restsInside(r.parts, e)).toEqual([]);
  });

  it("rests every joint of the table and the record console clear of every part", () => {
    for (const r of [table(), derive(applyOps(emptyDesign("x"), recordConsoleOps()))]) {
      // The other joints stay together, so only a new overlap counts.
      for (const j of r.joints) expect(restsInside(r.parts, explodeJoint(r.parts, r.joints, j.id)!), j.id).toEqual([]);
    }
  });

  it("is null for a joint that isn't there", () => {
    const r = derive(jointExample("dado"));
    expect(explodeJoint(r.parts, r.joints, "nope")).toBeNull();
  });
});

describe("the whole piece apart", () => {
  it("leaves every worked example's two boards clear of each other", () => {
    for (const type of JOINT_TYPES) {
      const r = derive(jointExample(type));
      const e = explodePiece(r.parts, r.joints, r.hardware);
      expect(slides(e), type).toHaveLength(1);
      expect(stillInside(r.parts, e), type).toEqual([]);
      expect(passThrough(r.parts, e, 200), type).toEqual([]);
    }
  });

  it("drops a table's base off its top as one frame, then takes the end frames off it", () => {
    const r = table();
    expect(runChecks(r.design, r).issues.filter((i) => i.severity === "error")).toEqual([]);
    const e = explodePiece(r.parts, r.joints, r.hardware);
    const first = e.moves.filter((m) => m.stage === 1);
    expect(first).toHaveLength(1);
    expect(first[0]!.parts).toEqual(["leg_bl", "leg_br", "leg_fl", "leg_fr", "rail_back", "rail_front", "rail_left", "rail_right"]);
    expect(first[0]!.by_mm[1]).toBeLessThan(0);
    // Each end frame slides off the long rails sideways as a whole, before its leg comes off its rail.
    const ends = e.moves.filter((m) => m.stage === 2 && m.parts.length === 3);
    expect(ends.map((m) => m.parts)).toEqual([
      ["leg_bl", "leg_fl", "rail_left"],
      ["leg_br", "leg_fr", "rail_right"],
    ]);
    expect(ends.map((m) => Math.sign(m.by_mm[0]))).toEqual([-1, 1]);
    const legOff = e.moves.find((m) => m.parts.length === 1 && m.parts[0] === "leg_fl")!;
    expect(legOff.stage).toBeGreaterThan(2);
    expect(stillInside(r.parts, e)).toEqual([]);
    expect(passThrough(r.parts, e)).toEqual([]);
  });

  it("slides the record console's drawers out the front, and leaves nothing inside anything", () => {
    const r = derive(applyOps(emptyDesign("x"), recordConsoleOps()));
    const e = explodePiece(r.parts, r.joints, r.hardware);
    expect(e.locked).toEqual([]);
    expect(stillInside(r.parts, e)).toEqual([]);
    expect(passThrough(r.parts, e)).toEqual([]);
    const drawer = e.moves.find((m) => m.parts.includes("drawer_side_l") && m.parts.includes("drawer_bottom") && m.parts.length > 1)!;
    expect(drawer.by_mm[2]).toBeGreaterThan(0);
    // Every part slides off its joints but the one that stays put, and then every part fans out.
    const slid = new Set(slides(e).flatMap((m) => m.parts));
    expect(r.parts.filter((p) => !slid.has(p.id))).toHaveLength(1);
    expect(fan(e).size).toBe(r.parts.length);
  });

  it("fans a table out from its middle, the top up, the rails up and out, and each leg out past its corner", () => {
    const r = table();
    const e = explodePiece(r.parts, r.joints, r.hardware);
    const f = fan(e);
    const sign = (id: string) => f.get(id)!.map(Math.sign);
    expect(sign("top")).toEqual([0, 1, 0]);
    expect(sign("leg_fl")).toEqual([-1, -1, 1]);
    expect(sign("leg_br")).toEqual([1, -1, -1]);
    expect(sign("rail_front")[1]).toBe(1);
    expect(sign("rail_front")[2]).toBe(1);
    // A part at the very edge goes the full share of the longest side.
    expect(f.get("top")![1]).toBeGreaterThan(0.9 * FAN_OUT * 1240);
    // The fan-out is the last stage, after every part is off its joints, and nothing meets on the way.
    expect(Math.max(...slides(e).map((m) => m.stage))).toBe(e.stages - 1);
    expect(passThrough(r.parts, e)).toEqual([]);
  });

  it("keeps the whole piece on the floor at every step, rising together when a part would dip below it", () => {
    for (const r of [table(), derive(applyOps(emptyDesign("x"), recordConsoleOps()))]) {
      const e = explodePiece(r.parts, r.joints, r.hardware);
      let rose = false;
      for (let s = 0; s <= 400; s++) {
        const off = explodeOffsets(e, s / 400);
        const lowest = Math.min(...r.parts.map((p) => p.box.min[1]! + (off.get(p.id)?.[1] ?? 0)));
        expect(lowest).toBeGreaterThanOrEqual(-0.01);
        // The part that stays put rises too, when the piece has to.
        const top = r.parts.find((p) => !e.moves.some((m) => m.stage < e.stages && m.parts.includes(p.id)))!;
        if ((off.get(top.id)?.[1] ?? 0) > 0.01) rose = true;
      }
      // The table's base drops off its top, so the piece rises to keep its legs on the floor.
      expect(rose).toBe(true);
    }
  });

  it("works it out the same way every time", () => {
    const r = table();
    expect(JSON.stringify(explodePiece(r.parts, r.joints, r.hardware))).toBe(JSON.stringify(explodePiece(r.parts, r.joints, r.hardware)));
  });

  it("takes apart two parts whose joints hold each other every way through each other, rests them clear, and says so", () => {
    const part = (id: string, min: Vec3, max: Vec3) => ({ id, box: { min, max }, nominal: { min, max }, broken: false, thickness_axis: "x" as const });
    const parts = [part("a", [0, 0, 0], [100, 100, 100]), part("b", [100, 0, 0], [150, 100, 100])];
    const joints = [
      { id: "j1", type: "dado" as const, family: "housing" as const, host: "a", guest: "b", axis: "x" as const, side: "start" as const, features: [] },
      { id: "j2", type: "screws" as const, family: "fastener" as const, host: "a", guest: "b", axis: "y" as const, side: "end" as const, features: [] },
    ];
    const e = explodePiece(parts, joints);
    expect(slides(e).map((m) => m.parts)).toEqual([["b"]]);
    expect(e.locked).toEqual([["a", "b"]]);
    expect(stillInside(parts as unknown as DerivedPart[], e)).toEqual([]);
  });

  it("leaves out broken parts, and has nothing to do with fewer than two", () => {
    const r = derive(jointExample("dado"));
    expect(explodePiece(r.parts.slice(0, 1), r.joints)).toEqual(NO_EXPLOSION);
    expect(explodePiece(r.parts.map((p, i) => ({ ...p, broken: i === 0 })), r.joints)).toEqual(NO_EXPLOSION);
  });
});

describe("the way there", () => {
  const e: Explosion = {
    stages: 2,
    locked: [],
    moves: [
      { parts: ["a", "b"], by_mm: [0, -100, 0], stage: 1 },
      { parts: ["b"], by_mm: [50, 0, 0], stage: 2 },
    ],
  };

  it("keeps everything together at 0 and fully apart at 1", () => {
    expect(explodeOffsets(e, 0).size).toBe(0);
    const apart = explodeOffsets(e, 1);
    expect(apart.get("a")).toEqual([0, -100, 0]);
    expect(apart.get("b")).toEqual([50, -100, 0]);
  });

  it("finishes each stage before the next one starts, easing in and out", () => {
    const half = explodeOffsets(e, 0.5);
    expect(half.get("b")).toEqual([0, -100, 0]);
    const quarter = explodeOffsets(e, 0.25);
    expect(quarter.get("a")![1]).toBeCloseTo(-50);
    expect(explodeOffsets(e, 0.1).get("a")![1]).toBeGreaterThan(-20);
  });

  it("hangs hardware between the parts it joins", () => {
    const off = new Map<string, Vec3>([["door", [0, 0, 100]]]);
    expect(hardwareOffset(["door", "side"], off)).toEqual([0, 0, 50]);
    expect(hardwareOffset([], off)).toEqual([0, 0, 0]);
  });
});
