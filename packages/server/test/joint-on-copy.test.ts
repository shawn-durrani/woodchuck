// Issue #43: Claude houses a drawer divider into one shelf of an evenly
// spaced row, with add_joint naming that copy, such as shelf#2. The fixture
// is an invented bookcase in 18 mm ply, 600 mm wide, with three shelves
// 250 mm apart, each housed into both sides. Every size is made up.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Turn, type MessagesClient } from "../src/agent.js";
import { scriptedClient } from "../src/scripted.js";
import { Store } from "../src/store.js";
import { TOOLS } from "../src/tools.js";

type Block = Record<string, unknown>;

const call = (id: string, name: string, input: Block): Block => ({ type: "tool_use", id, name, input });

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "woodchuck-copy-joint-"));
  store = new Store(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function turn(client: MessagesClient) {
  return new Turn(store, client, { chat() {}, delta() {}, changed() {} }, () => Buffer.from("png"));
}

const side = (id: string, name: string, x: Block): Block => ({
  op: "add_panel",
  id,
  name,
  material: "ply18",
  thickness_axis: "x",
  grain_axis: "y",
  x,
  y: { start: { at: "0" }, size: "1200" },
  z: { start: { at: "0" }, size: "250" },
});

/** The carcass, its shelves and the divider, as one list of edits. */
const bookcase = call("b1", "apply_edits", {
  edits: [
    { op: "define_material", id: "ply18", name: "18 mm birch ply", kind: "sheet", thickness_mm: 18, grained: true },
    { op: "set_param", name: "width", expr: "600", unit: "mm" },
    side("left", "Left side", { start: { at: "0" } }),
    side("right", "Right side", { end: { at: "width" } }),
    {
      op: "add_panel",
      id: "shelf",
      name: "Shelf",
      material: "ply18",
      thickness_axis: "y",
      grain_axis: "x",
      x: { start: { face: "left.right" }, end: { face: "right.left" } },
      y: { start: { at: "250" } },
      z: { start: { at: "0" }, size: "250" },
    },
    { op: "set_array", id: "shelf_row", parts: ["shelf"], axis: "y", count: "3", pitch: "250" },
    {
      op: "add_panel",
      id: "divider",
      name: "Divider",
      material: "ply18",
      thickness_axis: "x",
      grain_axis: "y",
      x: { start: { at: "width / 2 - 9" } },
      y: { start: { face: "shelf.top" }, end: { face: "shelf#2.bottom" } },
      z: { start: { at: "0" }, size: "250" },
    },
    { op: "add_joint", id: "shelf_l", type: "dado", host: "left", guest: "shelf" },
    { op: "add_joint", id: "shelf_r", type: "dado", host: "right", guest: "shelf" },
    { op: "add_joint", id: "divider_foot", type: "pocket_screws", host: "shelf#1", guest: "divider" },
  ],
});

const resultOf = (client: ReturnType<typeof scriptedClient>, n: number, id: string) =>
  (client.sent[n]!.messages.at(-1)!.content as unknown as Block[]).find((b) => b.tool_use_id === id)!;
const bodyOf = (r: Block) => JSON.parse(String(r.content)) as Record<string, unknown>;

describe("a joint on one copy, from Claude", () => {
  it("houses the divider into shelf#2 alone, and the cut list gives shelf#2 a row of its own", async () => {
    const client = scriptedClient([
      [bookcase],
      [
        call("j1", "add_joint", { id: "divider_top", type: "dado", host: "shelf#2", guest: "divider", note: "Housed into the second shelf only" }),
        call("j2", "add_joint", { id: "divider_spare", type: "dado", host: "shelf#5", guest: "divider" }),
      ],
      [call("c1", "get_cut_list", {}), call("c2", "check_design", {})],
      [{ type: "text", text: "The divider is housed into the second shelf." }],
    ]);
    await turn(client).run({ text: "Add a drawer divider under the second shelf, housed into it", selection: [] });

    expect(resultOf(client, 2, "j1")).not.toHaveProperty("is_error", true);
    expect(bodyOf(resultOf(client, 2, "j1"))).toMatchObject({
      ok: true,
      sizes: [{ id: "divider", cut_mm: { length: 238, width: 250, thickness: 18 } }],
      problems: { errors: 0, new: [] },
    });
    expect(resultOf(client, 2, "j2")).toMatchObject({
      is_error: true,
      content: expect.stringContaining(
        'host "shelf#5" doesn\'t exist: array shelf_row has 3 items, so its copies run from shelf#2 to shelf#3. Name shelf#1 for the original alone',
      ),
    });
    expect(store.project.design.joints.filter((j) => j.guest === "divider")).toEqual([
      { id: "divider_foot", type: "pocket_screws", host: "shelf#1", guest: "divider" },
      { id: "divider_top", type: "dado", host: "shelf#2", guest: "divider", note: "Housed into the second shelf only" },
    ]);

    const list = bodyOf(resultOf(client, 3, "c1")) as { rows: { name: string; qty: number; machining: string[]; parts: string[] }[] };
    expect(list.rows.filter((r) => r.name.startsWith("Shelf")).map((r) => [r.name, r.qty, r.machining, r.parts])).toEqual([
      ["Shelf", 2, [], ["shelf", "shelf#3"]],
      ["Shelf (shelf#2)", 1, ["dado 18 wide × 6 deep × 250 long in the bottom face for divider at (279,0,0)"], ["shelf#2"]],
    ]);
    expect(bodyOf(resultOf(client, 3, "c2"))).toMatchObject({ ready_to_cut: true, errors: 0, warnings: 0 });
  });

  it("hears a clear problem when a new count leaves the joint's copy gone", async () => {
    const client = scriptedClient([
      [bookcase, call("j1", "add_joint", { id: "divider_top", type: "dado", host: "shelf#2", guest: "divider" })],
      [call("a1", "set_array", { id: "shelf_row", parts: ["shelf"], axis: "y", count: "1", pitch: "250" })],
      [{ type: "text", text: "One shelf leaves the divider with nothing to go into." }],
    ]);
    await turn(client).run({ text: "Make it one shelf", selection: [] });

    const result = bodyOf(resultOf(client, 2, "a1")) as { problems: { new: string[] } };
    expect(result.problems.new).toContain(
      "Joint divider_top names shelf#2, but array shelf_row has 1 item, so there's no shelf#2. It joins that one copy, so it can't be placed. Delete it, or add it again on a copy that's there",
    );
    // The joint stays, so turning the count back up puts the divider back where it was.
    expect(store.project.design.joints.map((j) => [j.id, j.host])).toContainEqual(["divider_top", "shelf#2"]);
  });

  it("tells Claude how to join one copy, and that a count change keeps the copy's number", () => {
    const tool = (name: string) => TOOLS.find((t) => t.name === name)!;
    expect(tool("add_joint").description).toContain(
      "A drawer divider housed into the underside of the second shelf only is a dado with host shelf#2 and guest divider.",
    );
    expect(tool("add_joint").description).toContain("To join one copy alone, name it as host or guest, such as shelf#2, or shelf#1 for the original alone.");
    expect(tool("set_array").description).toContain("A joint on one copy, such as shelf#2, follows the copy's number");
    expect(tool("delete_array").description).toContain("A joint on one of its copies, such as shelf#2, is then an error until you delete it.");
  });
});
