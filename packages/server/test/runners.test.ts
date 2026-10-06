// Issue #46: with no slides that fit, Claude gives the drawers wooden runners
// as timber, and hardware is only what you buy. Claude's instructions and
// tools say so. A scripted Claude reads the library's AcmeCo slide, which
// needs a cabinet 470 deep, for an invented bedside cabinet 360 deep. It
// builds the carcass, then tries a "Drawer wax glides" placeholder, as
// Claude did in a demo, and the refusal tells it to make runners. It builds
// them, the checks pass, and the cut list has the runners as timber and
// nothing to buy. Every size is made up. No key.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CutList } from "@woodchuck/core";
import { Turn } from "../src/agent.js";
import { PartsLibrary } from "../src/library.js";
import { SYSTEM_PROMPT } from "../src/prompt.js";
import { scriptedClient } from "../src/scripted.js";
import { Store } from "../src/store.js";
import { TOOLS } from "../src/tools.js";

type Block = Record<string, unknown>;

const call = (id: string, name: string, input: Block): Block => ({ type: "tool_use", id, name, input });

const slide = {
  id: "acmeco-glide-450",
  name: "AcmeCo Glide 450 side-mount slide",
  kind: "drawer_slide",
  maker: "AcmeCo",
  sources: [{ url: "https://example.com/acmeco-glide", title: "AcmeCo Glide spec sheet" }],
  specs: { length_mm: 450, min_cabinet_depth_mm: 470, clearance_per_side_mm: 12.7, load_kg: 30 },
  shape: [{ name: "slide", min_mm: [0, 0, 0], max_mm: [450, 45, 12.7] }],
};

let dir: string;
let store: Store;
let library: PartsLibrary;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "woodchuck-runners-"));
  store = new Store(path.join(dir, "data"));
  library = new PartsLibrary(path.join(dir, "library"), path.join(dir, "data", "part-proposals.json"));
  library.approve(library.propose(slide).id);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const access = () => ({ list: () => library.list().parts, get: (id: string) => library.get(id), propose: (i: unknown) => library.propose(i) });
const turn = (client: ReturnType<typeof scriptedClient>) =>
  new Turn(store, client, { chat() {}, delta() {}, changed() {} }, () => Buffer.from("png"), access());
const resultOf = (client: ReturnType<typeof scriptedClient>, n: number, id: string) =>
  (client.sent[n]!.messages.at(-1)!.content as unknown as Block[]).find((b) => b.tool_use_id === id)!;

const panel = (id: string, name: string, material: string, thickness_axis: string, grain_axis: string, x: Block, y: Block, z: Block, tags: string[]): Block => ({
  op: "add_panel",
  id,
  name,
  material,
  thickness_axis,
  grain_axis,
  x,
  y,
  z,
  tags,
});
const full = { start: { at: "0" }, size: "depth" };
const between = { start: { face: "dside_l.right" }, end: { face: "dside_r.left" } };
const sideHigh = { start: { face: "dside_l.bottom" }, end: { face: "dside_l.top" } };

/** The carcass: two sides, a bottom and a top. */
const carcass = call("b1", "apply_edits", {
  edits: [
    { op: "rename_design", name: "Bedside cabinet" },
    { op: "set_param", name: "width", expr: "450", unit: "mm" },
    { op: "set_param", name: "height", expr: "520", unit: "mm" },
    { op: "set_param", name: "depth", expr: "360", unit: "mm" },
    { op: "set_param", name: "run_gap", expr: "1", unit: "mm", note: "Running clearance each side of a drawer" },
    { op: "define_material", id: "ply18", name: "18 mm birch ply", kind: "sheet", thickness_mm: 18, grained: true },
    { op: "define_material", id: "ply12", name: "12 mm birch ply", kind: "sheet", thickness_mm: 12, grained: true },
    { op: "define_material", id: "oak12", name: "12 mm oak strip", kind: "solid", thickness_mm: 12, grained: true, species: "tasmanian_oak" },
    panel("side_l", "Left side", "ply18", "x", "y", { start: { at: "0" } }, { start: { at: "0" }, size: "height" }, full, ["carcass"]),
    panel("side_r", "Right side", "ply18", "x", "y", { end: { at: "width" } }, { start: { at: "0" }, size: "height" }, full, ["carcass"]),
    panel("bottom", "Bottom", "ply18", "y", "x", { start: { face: "side_l.right" }, end: { face: "side_r.left" } }, { start: { at: "0" } }, full, ["carcass"]),
    panel("top", "Top", "ply18", "y", "x", { start: { face: "side_l.right" }, end: { face: "side_r.left" } }, { end: { at: "height" } }, full, ["carcass"]),
    { op: "add_joint", id: "bottom_l", type: "screws", host: "side_l", guest: "bottom" },
    { op: "add_joint", id: "bottom_r", type: "screws", host: "side_r", guest: "bottom" },
    { op: "add_joint", id: "top_l", type: "screws", host: "side_l", guest: "top" },
    { op: "add_joint", id: "top_r", type: "screws", host: "side_r", guest: "top" },
  ],
});

/** A 12 × 20 mm oak runner on each side, and a drawer box resting on them, twice up. */
const drawers = call("b2", "apply_edits", {
  edits: [
    panel("runner_l", "Runner", "oak12", "x", "z", { start: { face: "side_l.right" } }, { start: { face: "bottom.top", offset: "30" }, size: "20" }, full, ["runner"]),
    panel("runner_r", "Runner", "oak12", "x", "z", { end: { face: "side_r.left" } }, { start: { face: "runner_l.bottom" }, size: "20" }, full, ["runner"]),
    panel("dside_l", "Drawer side", "ply12", "x", "z", { start: { face: "side_l.right", offset: "run_gap" } }, { start: { face: "runner_l.top" }, size: "200" }, { start: { at: "10" }, end: { face: "side_l.front" } }, ["drawer"]),
    panel("dside_r", "Drawer side", "ply12", "x", "z", { end: { face: "side_r.left", offset: "-run_gap" } }, sideHigh, { start: { face: "dside_l.back" }, end: { face: "dside_l.front" } }, ["drawer"]),
    panel("dfront", "Drawer front", "ply12", "z", "x", between, sideHigh, { end: { face: "dside_l.front" } }, ["drawer"]),
    panel("dback", "Drawer back", "ply12", "z", "x", between, sideHigh, { start: { face: "dside_l.back" } }, ["drawer"]),
    { op: "add_joint", id: "runner_l_fix", type: "screws", host: "runner_l", guest: "side_l", length: "28" },
    { op: "add_joint", id: "runner_r_fix", type: "screws", host: "runner_r", guest: "side_r", length: "28" },
    { op: "add_joint", id: "front_l", type: "screws", host: "dside_l", guest: "dfront" },
    { op: "add_joint", id: "front_r", type: "screws", host: "dside_r", guest: "dfront" },
    { op: "add_joint", id: "back_l", type: "screws", host: "dside_l", guest: "dback" },
    { op: "add_joint", id: "back_r", type: "screws", host: "dside_r", guest: "dback" },
    { op: "set_array", id: "drawers", parts: ["runner_l", "runner_r", "dside_l", "dside_r", "dfront", "dback"], axis: "y", count: "2", pitch: "230" },
  ],
});

describe("Claude's instructions on drawers without slides", () => {
  it("say to make wooden runners as timber, with running clearance, and never list them as hardware", () => {
    expect(SYSTEM_PROMPT).toContain(
      "When slides don't fit, such as in a carcass too shallow for them, or the woodworker doesn't want them, make wooden runners: timber strips fixed to the carcass sides and tagged runner, with each drawer side resting on one or riding it in a groove.",
    );
    expect(SYSTEM_PROMPT).toContain("Leave 0.5 to 1 mm running clearance beside the drawer and over it, and give a runner's groove a fit of 0.5 to 1 mm.");
    expect(SYSTEM_PROMPT).toContain("Hardware is only what you buy, so runners, glides and wax never go in set_hardware.");
    const setHardware = TOOLS.find((t) => t.name === "set_hardware")!;
    expect(setHardware.description).toContain("Hardware is only what you buy, so it needs library_part or the maker's figures in spec. Wooden runners and glides are timber: add them with add_panel, tagged runner.");
    const tags = (TOOLS.find((t) => t.name === "add_panel")!.input_schema.properties as Record<string, { description: string }>).tags!;
    expect(tags.description).toContain("runner marks a strip or shelf a drawer slides on, and the checks hold that drawer to running clearance");
  });
});

describe("a cabinet too shallow for the library's slides", () => {
  it("gets wooden runners on the cut list, after the hardware placeholder is refused", async () => {
    const client = scriptedClient([
      [{ type: "text", text: "Checking the slides first." }, call("l1", "list_library_parts", { kind: "drawer_slide" })],
      [{ type: "text", text: "Carcass first." }, carcass],
      [call("h1", "set_hardware", { id: "glides", kind: "drawer_slide", name: "Drawer wax glides", connects: ["side_l", "side_r"], qty: 2 })],
      [{ type: "text", text: "The AcmeCo slide needs a cabinet 470 deep, and this one is 360, so the drawers run on oak runners." }, drawers],
      [call("k1", "check_design", {}), call("c1", "get_cut_list", {})],
      [{ type: "text", text: "Two drawers on oak runners, with 1 mm running clearance each side. Wax the runners." }],
    ]);
    await turn(client).run({ text: "A bedside cabinet with two drawers, 450 wide, 520 tall and 360 deep, in 18 mm birch ply. Use the AcmeCo slides if they fit.", selection: [] });

    expect(String(resultOf(client, 1, "l1").content)).toContain('"min_cabinet_depth_mm": 470');
    expect(resultOf(client, 2, "b1").is_error).toBeUndefined();
    const refused = resultOf(client, 3, "h1");
    expect(refused.is_error).toBe(true);
    expect(refused.content).toBe(
      'Drawer wax glides (glides) names nothing to buy: it has no library_part and no spec. Hardware is only what you buy, so give library_part, or the maker\'s figures in spec, such as {"length_mm": 450}. ' +
        "Wooden runners and glides are timber: add each with add_panel, tagged runner, and the drawer slides on it with no hardware",
    );
    expect(resultOf(client, 4, "b2").is_error).toBeUndefined();

    const checks = JSON.parse(String(resultOf(client, 5, "k1").content)) as { ready_to_cut: boolean; errors: number; warnings: number };
    expect(checks).toMatchObject({ ready_to_cut: true, errors: 0, warnings: 0 });
    const list = JSON.parse(String(resultOf(client, 5, "c1").content)) as CutList;
    expect(list.hardware).toEqual([]);
    expect(list.rows.filter((r) => r.name === "Runner").map((r) => ({ qty: r.qty, size: [r.length_mm, r.width_mm, r.thickness_mm], material: r.material_name }))).toEqual([
      { qty: 2, size: [360, 20, 12], material: "12 mm oak strip" },
      { qty: 2, size: [360, 20, 12], material: "12 mm oak strip" },
    ]);
    expect(list.notes).toEqual(["Wax the runners in rows 1 and 2, and the drawer edges or grooves that run on them, so the drawers slide freely."]);
    expect(store.project.design.hardware).toEqual([]);
  });
});
