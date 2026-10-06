// Issue #44: Claude stops a dado short of an edge with add_joint's stop,
// and shows a stopped housing with show_joint. The fixture is an invented
// wall shelf: two 18 mm pine sides, 600 tall and 240 deep, with one shelf
// housed in both. Every size is made up.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cutList, derive, FACES } from "@woodchuck/core";
import { Turn, type MessagesClient } from "../src/agent.js";
import { SYSTEM_PROMPT } from "../src/prompt.js";
import { scriptedClient } from "../src/scripted.js";
import { Store } from "../src/store.js";
import { runTool, TOOLS, type ToolContext } from "../src/tools.js";

type Block = Record<string, unknown>;

const call = (id: string, name: string, input: Block): Block => ({ type: "tool_use", id, name, input });

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "woodchuck-stopped-"));
  store = new Store(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const turn = (client: MessagesClient) => new Turn(store, client, { chat() {}, delta() {}, changed() {} }, () => Buffer.from("png"));
const resultOf = (client: ReturnType<typeof scriptedClient>, n: number, id: string) =>
  (client.sent[n]!.messages.at(-1)!.content as unknown as Block[]).find((b) => b.tool_use_id === id)!;

const sides: Block[] = [
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
];
const stopped = (id: string, host: string): Block => ({ op: "add_joint", id, type: "dado", host, guest: "shelf", stop: { front: 10 } });

const ctx = (): ToolContext => ({
  library: { list: () => [], get: () => undefined, propose: () => ({ id: "", part: {} as never }) },
  design: () => store.project.design,
  apply: (op) => store.project.apply([op]),
  requestTool: () => ({ id: "", count: 0 }),
  renderPng: () => Buffer.from(""),
});

describe("the stop on add_joint", () => {
  it("is in add_joint's fields, with an example, for any edge of the host", () => {
    const tool = TOOLS.find((t) => t.name === "add_joint")!;
    const stop = (tool.input_schema.properties as Record<string, { properties?: Record<string, { type: unknown }> }>).stop!;
    expect(Object.keys(stop.properties!)).toEqual([...FACES]);
    expect(stop.properties!.front!.type).toEqual(["string", "number"]);
    expect(tool.description).toContain('"stop": {"front": "10"}');
    expect(tool.description).toContain("its front corner is notched 10 mm to match");
    // The prompt says when to use it, and never makes it a default.
    expect(SYSTEM_PROMPT).toContain("A dado, groove, rabbet or dado_rabbet can stop short of an edge with add_joint's stop");
    expect(SYSTEM_PROMPT).toContain("use it when the woodworker asks for a stopped housing or says that edge will be seen");
  });

  it("stops a scripted shelf's dados short of the front, and Claude hears what that made", async () => {
    const client = scriptedClient([
      [call("a1", "apply_edits", { edits: [...sides, stopped("shelf_l", "side_l"), stopped("shelf_r", "side_r")] })],
      [call("j1", "show_joint", { type: "dado", stopped: true, note: "So the front edges stay clean" })],
      [{ type: "text", text: "Stopped 10 mm short of the front." }],
    ]);
    await turn(client).run({ text: "Build a wall shelf with stopped dados, so the front edges don't show a slot", selection: [] });

    const built = resultOf(client, 1, "a1");
    expect(built.is_error).toBeUndefined();
    const d = store.project.design;
    expect(d.joints.map((j) => [j.id, j.stop])).toEqual([
      ["shelf_l", { front: "10" }],
      ["shelf_r", { front: "10" }],
    ]);
    const rows = cutList(d, derive(d)).rows;
    expect(rows.find((r) => r.name === "Left side")!.machining).toEqual(["dado 18 wide × 6 deep × 230 long in the right face for shelf at (12,300,0), stopped 10 mm from the front"]);
    expect(rows.find((r) => r.name === "Shelf")!.machining).toEqual([
      "notch 6 × 10 out of the front left corner, to fit the stopped dado in side_l at (0,0,230)",
      "notch 6 × 10 out of the front right corner, to fit the stopped dado in side_r at (570,0,230)",
    ]);

    expect(String(resultOf(client, 2, "j1").content)).toBe("The worked example of a stopped dado (housing) is open beside the model. Say a sentence about it; the drawer shows the rest.");
    const card = store.project.chat.find((c) => c.kind === "example");
    expect(card).toMatchObject({ kind: "example", joint: "dado", note: "So the front edges stay clean", stopped: true });
    store.project.undo();
    expect(store.project.design.joints).toEqual([]);
  });

  it("is refused on a joint that isn't a housing, and on a field of the wrong shape", () => {
    runTool("apply_edits", { edits: sides }, ctx());
    const screws = runTool("add_joint", { id: "shelf_l", type: "screws", host: "side_l", guest: "shelf", stop: { front: "10" } }, ctx());
    expect(screws).toMatchObject({ isError: true, content: "stop only applies to dado, groove, rabbet and dado_rabbet joints, not screws" });
    const flat = runTool("apply_edits", { edits: [{ ...stopped("shelf_l", "side_l"), stop: 10 }] }, ctx());
    expect(flat.isError).toBe(true);
    expect(String(flat.content)).toContain('stop must be an object of the edges the housing stops short of, each with how far in mm. Example: "stop": {"front": "10"}');
    expect(store.project.design.joints).toEqual([]);
  });
});

describe("list_joints and show_joint", () => {
  it("say a dado, groove, rabbet or dado_rabbet can stop short, and no other joint", () => {
    const joints = JSON.parse(String(runTool("list_joints", {}, ctx()).content)) as { type: string; stop?: string }[];
    expect(joints.filter((j) => j.stop).map((j) => j.type)).toEqual(["dado", "groove", "rabbet", "dado_rabbet"]);
    expect(joints.find((j) => j.type === "dado")!.stop).toMatch(/^It can stop short of one or both edges it runs between/);
  });

  it("show a stopped example only for a housing", () => {
    const tool = TOOLS.find((t) => t.name === "show_joint")!;
    expect(Object.keys(tool.input_schema.properties!)).toEqual(["type", "stopped", "note"]);
    expect(runTool("show_joint", { type: "groove", stopped: true }, ctx())).toMatchObject({ example: { joint: "groove", stopped: true } });
    expect(runTool("show_joint", { type: "groove" }, ctx()).example).toEqual({ joint: "groove" });
    expect(runTool("show_joint", { type: "mortise_tenon", stopped: true }, ctx())).toMatchObject({
      isError: true,
      content: "A mortise tenon can't stop short of an edge. Only a dado, groove, rabbet or dado_rabbet can, so show it without stopped",
    });
  });
});
