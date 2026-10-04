// A small reading bench for Dave's place in Fairhaven, built with the same
// operations Claude uses: a seat on four legs, a front rail, a low rail and
// a book shelf of slats, with three rules of its own. Every size is made up.
// The tests for the five tabs, the ghost preview and the Check tab's fixes
// share it.

import { applyOps, cutList, derive, emptyDesign, runChecks, type Design, type Op } from "@woodchuck/core";
import type { ServerState } from "../src/api.js";

const leg = (id: string, name: string, x: "start" | "end", z: "start" | "end"): Op => ({
  op: "add_panel",
  id,
  name,
  material: "leg40",
  thickness_axis: "x",
  grain_axis: "y",
  x: x === "start" ? { start: { at: "0" } } : { end: { at: "bench_length" } },
  y: { start: { at: "0" }, end: { at: "seat_height - slat_t" } },
  z: z === "start" ? { start: { at: "0" }, size: "leg_size" } : { end: { at: "bench_depth" }, size: "leg_size" },
});

export const BENCH_OPS: Op[] = [
  { op: "set_param", name: "bench_length", expr: "1100", unit: "mm", note: "Overall length" },
  { op: "set_param", name: "bench_depth", expr: "360", unit: "mm", note: "Back to front" },
  { op: "set_param", name: "seat_height", expr: "440", unit: "mm", note: "Floor to the top of the seat" },
  { op: "set_param", name: "slat_t", expr: "18", unit: "mm" },
  { op: "set_param", name: "leg_size", expr: "40", unit: "mm" },
  { op: "set_param", name: "rail_w", expr: "60", unit: "mm" },
  { op: "set_param", name: "slat_gap", expr: "12", unit: "mm" },
  { op: "set_param", name: "shelf_count", expr: "4", unit: "count" },
  { op: "set_param", name: "shelf_top", expr: "100", unit: "mm", note: "Book shelf height" },
  { op: "define_material", id: "leg40", name: "Spotted gum 40 mm", kind: "solid", thickness_mm: 40, grained: true },
  { op: "define_material", id: "gum18", name: "Spotted gum 18 mm", kind: "solid", thickness_mm: 18, grained: true },
  leg("leg_bl", "Leg, back left", "start", "start"),
  leg("leg_fl", "Leg, front left", "start", "end"),
  leg("leg_br", "Leg, back right", "end", "start"),
  leg("leg_fr", "Leg, front right", "end", "end"),
  {
    op: "add_panel",
    id: "seat",
    name: "Seat",
    material: "gum18",
    thickness_axis: "y",
    grain_axis: "x",
    x: { start: { at: "0" }, end: { at: "bench_length" } },
    y: { end: { at: "seat_height" } },
    z: { start: { at: "0" }, end: { at: "bench_depth" } },
  },
  {
    op: "add_panel",
    id: "rail_front_top",
    name: "Front top rail",
    material: "gum18",
    thickness_axis: "z",
    grain_axis: "x",
    x: { start: { face: "leg_fl.right" }, end: { face: "leg_fr.left" } },
    y: { end: { at: "seat_height - slat_t" }, size: "rail_w" },
    z: { end: { at: "bench_depth" } },
  },
  {
    op: "add_panel",
    id: "rail_front_low",
    name: "Front low rail",
    material: "gum18",
    thickness_axis: "z",
    grain_axis: "x",
    x: { start: { face: "leg_fl.right" }, end: { face: "leg_fr.left" } },
    y: { end: { at: "shelf_top - slat_t" }, size: "40" },
    z: { end: { at: "bench_depth" } },
  },
  {
    op: "add_panel",
    id: "shelf_slat",
    name: "Shelf slat",
    material: "gum18",
    thickness_axis: "y",
    grain_axis: "z",
    x: { start: { at: "leg_size + slat_gap" }, size: "60" },
    y: { end: { at: "shelf_top" } },
    z: { start: { at: "leg_size" }, end: { at: "bench_depth - leg_size" } },
  },
  { op: "set_array", id: "shelf_slats", parts: ["shelf_slat"], axis: "x", count: "shelf_count", pitch: "60 + slat_gap" },
  { op: "set_rule", id: "book_room", expr: "rail_front_top.bottom - shelf_top >= 240", severity: "error", message: "Under the front rail needs at least 240 mm above the shelf for books." },
  { op: "set_rule", id: "seat_height_ok", expr: "seat_height >= 420 && seat_height <= 460", severity: "warning", message: "Seat height should stay at a normal sitting height." },
  { op: "set_rule", id: "slat_gap_12", expr: "slat_gap == 12", severity: "warning", message: "Dave asked for 12 mm gaps between slats." },
];

export const bench = (extra: Op[] = []): Design => applyOps(emptyDesign("Fairhaven reading bench"), [...BENCH_OPS, ...extra]);

/** The parts of the server's state the side panel and the model read, for a design. */
export function stateOf(design: Design, more: Partial<ServerState> = {}): ServerState {
  const d = derive(design);
  return {
    project: { slug: "reading-bench", name: design.name },
    projects: [{ slug: "reading-bench", name: design.name, starred: false, changed: null }],
    design,
    derived: { params: d.params, parts: d.parts, joints: d.joints, hardware: d.hardware, issues: d.issues },
    report: runChecks(design, d),
    cutlist: cutList(design, d),
    history: [],
    redo: 0,
    chat: [],
    waiting: [],
    busy: false,
    model: "claude-sonnet-5-5",
    models: [],
    has_key: true,
    has_openai_key: false,
    build: "test",
    backdrop: null,
    tool_requests: [],
    repo: null,
    versions: [],
    library: { parts: [], pending: {}, broken: [], proposals: [] },
    ...more,
  };
}
