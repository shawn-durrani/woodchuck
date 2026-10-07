// Issue #66: Claude pulls one of the design's own joints apart on the model
// with show_joint's id, and the window hears it as a card in the chat. The
// fixture is an invented wall shelf: two 18 mm pine sides, 600 tall and
// 240 deep, with one shelf housed in both. Every size is made up.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Turn } from "../src/agent.js";
import { SYSTEM_PROMPT } from "../src/prompt.js";
import { scriptedClient } from "../src/scripted.js";
import { Store } from "../src/store.js";
import { runTool, TOOLS, type ToolContext } from "../src/tools.js";

type Block = Record<string, unknown>;

const call = (id: string, name: string, input: Block): Block => ({ type: "tool_use", id, name, input });

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "woodchuck-explode-"));
  store = new Store(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const shelf: Block[] = [
  { op: "define_material", id: "pine18", name: "18 mm pine", kind: "solid", thickness_mm: 18, grained: true },
  ...(["side_l", "side_r"] as const).map((id, i) => ({
    op: "add_panel",
    id,
    name: i ? "Right side" : "Left side",
    material: "pine18",
    thickness_axis: "x",
    grain_axis: "y",
    x: i ? { end: { at: "600" } } : { start: { at: "0" } },
    y: { start: { at: "0" }, size: "600" },
    z: { start: { at: "0" }, size: "240" },
  })),
  {
    op: "add_panel",
    id: "shelf",
    name: "Shelf",
    material: "pine18",
    thickness_axis: "y",
    grain_axis: "x",
    x: { start: { face: "side_l.right" }, end: { face: "side_r.left" } },
    y: { start: { at: "300" } },
    z: { start: { at: "0" }, size: "240" },
  },
  { op: "add_joint", id: "shelf_l", type: "dado", host: "side_l", guest: "shelf" },
  { op: "add_joint", id: "shelf_r", type: "dado", host: "side_r", guest: "shelf" },
];

const ctx = (): ToolContext => ({
  library: { list: () => [], get: () => undefined, propose: () => ({ id: "", part: {} as never }) },
  design: () => store.project.design,
  apply: (op) => store.project.apply([op]),
  requestTool: () => ({ id: "", count: 0 }),
  renderPng: () => Buffer.from(""),
});

describe("show_joint with a joint of the design", () => {
  it("takes an id, and the prompt says when to use it", () => {
    const tool = TOOLS.find((t) => t.name === "show_joint")!;
    expect(tool.input_schema.required).toEqual([]);
    expect(tool.description).toContain("Or give id, one of this design's own joints, to pull its two parts apart on the model itself");
    expect(SYSTEM_PROMPT).toContain("When they ask how a joint in their own piece goes together, call show_joint with its id");
  });

  it("names the joint it pulls apart, and refuses one that isn't there with the ones that are", () => {
    runTool("apply_edits", { edits: shelf }, ctx());
    const shown = runTool("show_joint", { id: "shelf_l", note: "The shelf slides out of its dado" }, ctx());
    expect(shown.example).toEqual({ joint: "dado", of: "shelf_l", note: "The shelf slides out of its dado" });
    expect(shown.content).toBe("Joint shelf_l, a dado (housing) with shelf into side_l, is pulled apart on the model, with the rest faded. Say a sentence about it; the model shows the rest.");
    expect(runTool("show_joint", { id: "nope" }, ctx())).toMatchObject({ isError: true, content: `There's no joint "nope" in this design. Its joints: shelf_l, shelf_r` });
    expect(runTool("show_joint", {}, ctx())).toMatchObject({ isError: true });
  });

  it("puts a card in the chat that the window pulls apart", async () => {
    const client = scriptedClient([
      [call("a1", "apply_edits", { edits: shelf })],
      [call("j1", "show_joint", { id: "shelf_r" })],
      [{ type: "text", text: "The shelf slides sideways out of its dado." }],
    ]);
    await new Turn(store, client, { chat() {}, delta() {}, changed() {} }, () => Buffer.from("png")).run({ text: "How does the shelf go into the right side?", selection: [] });
    const card = store.project.chat.find((c) => c.kind === "example");
    expect(card).toMatchObject({ kind: "example", joint: "dado", of: "shelf_r" });
  });
});
