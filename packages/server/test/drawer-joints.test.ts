// Issue #45: Claude builds a drawer box with its bottom in grooves and its
// corners rabbeted, through the same tools as any edit. A scripted Claude
// reads the joint library, opens the dado and rabbet's worked example and
// builds the box in two stages, then cuts a groove too narrow for the bottom
// and hears why. The box is invented: 400 wide, 450 deep and 120 tall in
// 12 mm ply, with a 6 mm ply bottom 10 mm up.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { derive } from "@woodchuck/core";
import { Turn, type MessagesClient } from "../src/agent.js";
import { SYSTEM_PROMPT } from "../src/prompt.js";
import { scriptedClient } from "../src/scripted.js";
import { Store } from "../src/store.js";
import { TOOLS } from "../src/tools.js";

type Block = Record<string, unknown>;

const call = (id: string, name: string, input: Block): Block => ({ type: "tool_use", id, name, input });

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "woodchuck-drawer-"));
  store = new Store(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function turn(client: MessagesClient) {
  return new Turn(store, client, { chat() {}, delta() {}, changed() {} }, () => Buffer.from("png"));
}

const results = (client: ReturnType<typeof scriptedClient>, n: number) => client.sent[n]!.messages.at(-1)!.content as unknown as Block[];
const resultOf = (client: ReturnType<typeof scriptedClient>, n: number, id: string) => results(client, n).find((b) => b.tool_use_id === id)!;

const panel = (id: string, name: string, material: string, thickness_axis: string, grain_axis: string, x: Block, y: Block, z: Block): Block => ({
  op: "add_panel",
  id,
  name,
  material,
  thickness_axis,
  grain_axis,
  x,
  y,
  z,
});

const panels: Block[] = [
  { op: "define_material", id: "ply12", name: "12 mm birch ply", kind: "sheet", thickness_mm: 12, grained: true },
  { op: "define_material", id: "ply6", name: "6 mm birch ply", kind: "sheet", thickness_mm: 6, grained: true },
  panel("front", "Box front", "ply12", "z", "x", { start: { at: "0" }, size: "400" }, { start: { at: "0" }, size: "120" }, { end: { at: "450" } }),
  panel("back", "Box back", "ply12", "z", "x", { start: { at: "0" }, size: "400" }, { start: { at: "16" }, end: { at: "120" } }, { start: { at: "0" } }),
  panel("side_l", "Side", "ply12", "x", "z", { start: { at: "0" } }, { start: { at: "0" }, size: "120" }, { start: { face: "back.front" }, end: { face: "front.back" } }),
  panel("side_r", "Side", "ply12", "x", "z", { end: { at: "400" } }, { start: { at: "0" }, size: "120" }, { start: { face: "back.front" }, end: { face: "front.back" } }),
  panel("bottom", "Bottom", "ply6", "y", "z", { start: { face: "side_l.right" }, end: { face: "side_r.left" } }, { start: { face: "side_l.bottom", offset: "10" } }, { start: { face: "back.back" }, end: { face: "front.back" } }),
  // The back stops on top of the bottom, so the bottom slides in from behind.
  { op: "update_panel", id: "back", y: { start: { face: "bottom.top" }, end: { at: "120" } } },
];

const joints: Block[] = [
  ...["front", "back"].flatMap((host) => ["side_l", "side_r"].map((guest) => ({ op: "add_joint", id: `${guest}_in_${host}`, type: "rabbet", host, guest, depth: "6" }))),
  ...["side_l", "side_r", "front"].map((host) => ({ op: "add_joint", id: `bottom_in_${host}`, type: "groove", host, guest: "bottom", depth: "6", width: "6" })),
  { op: "add_joint", id: "bottom_to_back", type: "screws", host: "bottom", guest: "back", count: 2 },
];

type Entry = { type: string; use_when: string; changes_sizes: string; params: { name: string }[] };

describe("Claude's drawer joints", () => {
  it("are in add_joint, list_joints and the standing instructions", () => {
    const addJoint = TOOLS.find((t) => t.name === "add_joint")!;
    const props = addJoint.input_schema.properties as Record<string, { enum?: string[]; type?: unknown }>;
    expect(props.type!.enum).toContain("dado_rabbet");
    expect(props.width!.type).toEqual(["string", "number"]);
    expect(addJoint.description).toContain("A drawer bottom is the guest of one groove in each part round it");
    expect(SYSTEM_PROMPT).toContain("A drawer box's bottom sits in grooves about 10 mm up its sides, front and back, and is never screwed on underneath.");
  });

  it("builds a drawer box with its bottom in grooves and its corners rabbeted, as one undo", async () => {
    const client = scriptedClient([
      [call("l1", "list_joints", {}), call("s1", "show_joint", { type: "dado_rabbet", note: "For a front that takes a pull" })],
      [call("a1", "apply_edits", { edits: panels }), call("a2", "apply_edits", { edits: joints })],
      [{ type: "text", text: "Bottom in grooves, rabbeted corners." }],
    ]);
    await turn(client).run({ text: "Build a drawer box with a captured bottom", selection: [] });

    // The library tells Claude where each drawer joint goes.
    const library = JSON.parse(String(resultOf(client, 1, "l1").content)) as Entry[];
    const entry = (type: string) => library.find((e) => e.type === type)!;
    expect(entry("groove").use_when).toMatch(/^Drawer bottoms, held in grooves in the sides, the front and the back about 10 mm up/);
    expect(entry("groove").use_when).toContain("never screwed on underneath");
    expect(entry("groove").changes_sizes).toContain("give it one groove joint for each part it sits in");
    expect(entry("groove").params.map((p) => p.name)).toEqual(["depth", "fit", "width"]);
    expect(entry("rabbet").use_when).toMatch(/^Drawer-box corners/);
    expect(entry("dado_rabbet").params.map((p) => p.name)).toEqual(["thickness", "depth", "fit"]);
    expect(store.project.chat.find((c) => c.kind === "example")).toMatchObject({ joint: "dado_rabbet", note: "For a front that takes a pull" });

    // The joints stage leaves no problem, and the bottom grows 6 into each of its three grooves.
    const built = JSON.parse(String(resultOf(client, 2, "a2").content)) as { ok: boolean; sizes: { id: string; cut_mm: Block }[]; problems: { errors: number; warnings: number } };
    expect(built.ok).toBe(true);
    expect(built.problems).toMatchObject({ errors: 0, warnings: 0 });
    expect(built.sizes.find((s) => s.id === "bottom")!.cut_mm).toEqual({ length: 444, width: 388, thickness: 6 });
    expect(built.sizes.find((s) => s.id === "side_l")!.cut_mm).toEqual({ length: 438, width: 120, thickness: 12 });

    const d = derive(store.project.design);
    expect(d.byId.get("side_l")!.machining.map((m) => [m.label, m.width_mm, m.depth_mm, m.length_mm])).toEqual([["groove", 6, 6, 438]]);
    expect(d.byId.get("front")!.machining.map((m) => [m.label, m.width_mm, m.depth_mm, m.length_mm])).toEqual([
      ["rabbet", 12, 6, 120],
      ["rabbet", 12, 6, 120],
      ["groove", 6, 6, 388],
    ]);
    expect(store.project.history).toHaveLength(1);
    store.project.undo();
    expect(store.project.design.parts).toEqual([]);
  });

  it("hears why a groove too narrow for the bottom won't do", async () => {
    store.project.change("you", "Drawer box", [...panels, ...joints] as never);
    const client = scriptedClient([
      [
        call("d1", "delete_joint", { id: "bottom_in_front" }),
        call("g1", "add_joint", { id: "bottom_in_front", type: "groove", host: "front", guest: "bottom", depth: "6", width: "5.5" }),
        call("g2", "add_joint", { id: "bottom_in_back", type: "groove", host: "back", guest: "bottom", width: "6", fit: "0.5" }),
      ],
      [{ type: "text", text: "The bottom needs a 6 mm groove." }],
    ]);
    await turn(client).run({ text: "Use my 5.5 mm bit for the front's groove", selection: [] });

    const narrow = JSON.parse(String(resultOf(client, 1, "g1").content)) as { problems: { errors: number; new: string[] } };
    expect(narrow.problems.errors).toBe(1);
    expect(narrow.problems.new).toEqual([
      "bottom_in_front (groove joining bottom to front): The groove is 5.5 mm wide and the panel 6 mm thick, so the panel won't go in. Cut the groove 6 mm wide, or thin the panel's edge to fit with a tongue joint",
    ]);
    const both = resultOf(client, 1, "g2");
    expect(both.is_error).toBe(true);
    expect(String(both.content)).toContain("Give a groove its width or its fit, not both");
  });
});
