// Issue #12: apply_edits makes a whole stage of a build in one call. The
// edits run in order through the same operations as the single edit tools,
// the turn stays one undo, a refused edit stops the list with the ones
// before it kept, and the problems come back once for the whole list. The
// fixture is a small invented carcass: two 18 mm sides 500 mm apart, a
// shelf between them on dados, and a clear oil.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { derive } from "@woodchuck/core";
import { Turn, type MessagesClient } from "../src/agent.js";
import { progress, type Item } from "../src/progress.js";
import { scriptedClient } from "../src/scripted.js";
import { Store } from "../src/store.js";
import { MAX_EDITS, runTool, TOOLS, type ToolContext } from "../src/tools.js";

type Block = Record<string, unknown>;

const call = (id: string, name: string, input: Block): Block => ({ type: "tool_use", id, name, input });

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "woodchuck-apply-"));
  store = new Store(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function turn(client: MessagesClient) {
  return new Turn(store, client, { chat() {}, delta() {}, changed() {} }, () => Buffer.from("png"));
}

const ply = { op: "define_material", id: "ply18", name: "18 mm ply", kind: "sheet", thickness_mm: 18, grained: true };
const side = (id: string, name: string, x: Block) => ({
  op: "add_panel",
  id,
  name,
  material: "ply18",
  thickness_axis: "x",
  grain_axis: "y",
  x,
  y: { start: { at: "0" }, size: "600" },
  z: { start: { at: "0" }, size: "300" },
});
const left = side("left", "Left side", { start: { at: "0" } });
const right = side("right", "Right side", { end: { at: "500" } });
const shelf = (id: string, material: string) => ({
  op: "add_panel",
  id,
  name: "Shelf",
  material,
  thickness_axis: "y",
  grain_axis: "x",
  x: { start: { face: "left.right" }, end: { face: "right.left" } },
  y: { start: { at: "200" } },
  z: { start: { at: "0" }, size: "300" },
});
const dado = (id: string, host: string) => ({ op: "add_joint", id, type: "dado", host, guest: "shelf", depth: "6" });
const oil = { op: "set_finish", targets: ["material:ply18"], finish: "natur" };
// A rule the carcass breaks, so the list makes one new problem.
const wide = { op: "set_rule", id: "wide_shelf", expr: "shelf.length >= 600", message: "The shelf should be at least 600 mm long" };

const results = (client: ReturnType<typeof scriptedClient>, n: number) => client.sent[n]!.messages.at(-1)!.content as unknown as Block[];
const tools = () => store.project.chat.filter((c) => c.kind === "tool");

describe("apply_edits", () => {
  it("builds a stage in order as one step, one undo and one compact result", async () => {
    const edits = [ply, left, right, shelf("shelf", "ply18"), dado("shelf_l", "left"), dado("shelf_r", "right"), oil, wide];
    const client = scriptedClient([[{ type: "text", text: "Carcass first." }, call("a1", "apply_edits", { edits })], [{ type: "text", text: "Carcass done." }]]);
    await turn(client).run({ text: "Build a small carcass", selection: [] });

    // In order: the shelf sits against faces added earlier in the list, and both dados lengthen it.
    const design = store.project.design;
    expect(design.parts.map((p) => p.id)).toEqual(["left", "right", "shelf"]);
    expect(design.joints.map((j) => j.id)).toEqual(["shelf_l", "shelf_r"]);
    expect(design.finishes).toEqual({ "material:ply18": "satin_wood_oil/natur" });
    expect(derive(design).byId.get("shelf")!.cut.length).toBe(500 - 36 + 12);

    // One result, on one line, that sums up the whole list once.
    const sent = results(client, 1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.is_error).toBeUndefined();
    const content = String(sent[0]!.content);
    expect(content).not.toContain("\n");
    expect(content.length).toBeLessThan(1500);
    const result = JSON.parse(content);
    expect(result).toMatchObject({ ok: true, applied: 8, added: ["left", "right", "shelf"], removed: [] });
    expect(result.sizes.map((s: { id: string }) => s.id)).toEqual(["left", "right", "shelf"]);
    expect(result.problems.new).toEqual(["The shelf should be at least 600 mm long (rule wide_shelf)"]);
    expect(content.split("The shelf should be at least 600 mm long")).toHaveLength(2);

    // One chat line and one step, but every edit counts.
    expect(tools().map((c) => c.kind === "tool" && [c.name, c.summary])).toEqual([["apply_edits", "apply 8 edits"]]);
    expect(store.project.history).toHaveLength(1);
    expect(store.project.chat.find((c) => c.kind === "change")).toMatchObject({ author: "claude", edits: 8 });
    const p = progress({ chat: store.project.chat as unknown as Item[], job: store.project.job, busy: false, waiting: [], queued: [], now: Date.now(), parts: 3 });
    expect(p).toMatchObject({ steps: 1, edits: 8, parts: 3, recent: ["apply 8 edits"] });

    store.project.undo();
    expect(store.project.design.parts).toEqual([]);
    expect(store.project.design.materials).toEqual([]);
  });

  it("stops at a refused edit, keeps the ones before it, and says which failed", async () => {
    const client = scriptedClient([
      [call("a1", "apply_edits", { edits: [ply, left, right, shelf("broken", "walnut"), shelf("shelf", "ply18"), dado("shelf_l", "left")] })],
      [call("a2", "apply_edits", { edits: [shelf("shelf", "ply18"), dado("shelf_l", "left")] })],
      [{ type: "text", text: "Fixed the shelf." }],
    ]);
    await turn(client).run({ text: "Build a small carcass", selection: [] });

    const failed = results(client, 1)[0]!;
    expect(failed.is_error).toBe(true);
    const [lead, json] = String(failed.content).split("\n");
    expect(lead).toBe(
      'Edit 4 of 6 (add_panel broken) was refused: Material "walnut" doesn\'t exist. Materials: ply18. ' +
        "Edits 1 to 3 are made and stay in this turn's change. Edits 5 to 6 didn't run. " +
        "Send edit 4 fixed, with the ones after it, in a new call.",
    );
    expect(JSON.parse(json!)).toMatchObject({
      ok: false,
      applied: 3,
      not_run: 2,
      failed: { edit: 4, op: "add_panel broken" },
      added: ["left", "right"],
    });
    // The chat shows a short line, not the whole result.
    expect(tools()[0]).toMatchObject({
      is_error: true,
      summary: 'apply 6 edits: edit 4 of 6 (add_panel broken) failed: Material "walnut" doesn\'t exist. Materials: ply18. 3 made, 2 not run',
    });

    // The fix goes on from where the list stopped, in the same change.
    expect(results(client, 2)[0]!.is_error).toBeUndefined();
    expect(store.project.design.parts.map((p) => p.id)).toEqual(["left", "right", "shelf"]);
    expect(store.project.design.joints.map((j) => j.id)).toEqual(["shelf_l"]);
    expect(store.project.history).toHaveLength(1);
    expect(store.project.chat.find((c) => c.kind === "change")).toMatchObject({ edits: 5 });
    store.project.undo();
    expect(store.project.design.parts).toEqual([]);
  });

  it("says nothing changed when the first edit is refused", async () => {
    const client = scriptedClient([[call("a1", "apply_edits", { edits: [{ op: "delete_part", id: "nope" }, ply] })], [{ type: "text", text: "Nothing there." }]]);
    await turn(client).run({ text: "Tidy up", selection: [] });
    const [lead, json] = String(results(client, 1)[0]!.content).split("\n");
    expect(lead).toBe('Edit 1 of 2 (delete_part nope) was refused: There\'s no part "nope". Nothing was changed. Edit 2 didn\'t run. Send edit 1 fixed, with the ones after it, in a new call.');
    expect(JSON.parse(json!)).toEqual({ ok: false, applied: 0, failed: { edit: 1, op: "delete_part nope", error: 'There\'s no part "nope"' }, not_run: 1 });
    expect(store.project.design.materials).toEqual([]);
    expect(store.project.history).toHaveLength(0);
  });
});

describe("apply_edits checks every edit before any runs", () => {
  const ctx = (): ToolContext => ({
    library: { list: () => [], get: () => undefined, propose: () => ({ id: "", part: {} as never }) },
    design: () => store.project.design,
    apply: (op) => store.project.apply([op]),
    requestTool: () => ({ id: "", count: 0 }),
    renderPng: () => Buffer.from(""),
  });
  const refused = (edits: unknown) => {
    const out = runTool("apply_edits", { edits }, ctx());
    expect(out.isError).toBe(true);
    // Nothing ran, not even the good edit first in the list.
    expect(store.project.design.materials).toEqual([]);
    return String(out.content);
  };

  it("refuses a tool that isn't an edit, a field the tool doesn't have, and a missing field", () => {
    expect(refused([ply, { op: "make_drawer", id: "d1" }])).toMatch(/^Edit 2: "make_drawer" isn't an edit tool\. Use one of: clear_design, /);
    expect(refused([ply, { op: "apply_edits", edits: [ply] }])).toMatch(/^Edit 2: "apply_edits" isn't an edit tool/);
    expect(refused([ply, { op: "render_views" }])).toMatch(/^Edit 2: "render_views" isn't an edit tool/);
    expect(refused([ply, { ...left, colour: "red" }])).toMatch(/^Edit 2 \(add_panel\): colour isn't a field of add_panel\. Its fields: id, name, material,/);
    expect(refused([ply, { op: "set_param", name: "width" }])).toBe("Edit 2 (set_param) needs expr");
    const example = '{"op": "set_param", "name": "shelf_depth", "expr": "320", "unit": "mm"}';
    expect(refused([ply, "add a shelf"])).toBe(`Edit 2 must be an object with "op" and that tool's input. Example: ${example}`);
    expect(refused([])).toBe(`edits must list at least one edit. Example: "edits": [${example}]`);
    expect(refused(undefined)).toBe(`edits must list at least one edit. Example: "edits": [${example}]`);
  });

  it("quotes the right shape of a missing field that takes an object or a list (#40)", () => {
    const { x: _x, ...noX } = left;
    expect(refused([ply, noX])).toBe('Edit 2 (add_panel) needs x. Example: "x": {"start": {"at": "0"}, "size": "600"}');
    expect(refused([ply, { op: "set_finish", finish: "natur" }])).toBe('Edit 2 (set_finish) needs targets. Example: "targets": ["material:ply18", "shelf", "shelf.front"]');
    expect(refused([ply, { op: "add_unverified_box", id: "lamp", name: "Lamp", reason: "No tool yet" }])).toBe('Edit 2 (add_unverified_box) needs min_mm, max_mm. Example: "min_mm": [0, 0, 0]');
  });

  it(`takes at most ${MAX_EDITS} edits`, () => {
    const params = (n: number) => Array.from({ length: n }, (_, i) => ({ op: "set_param", name: `gap_${i}`, expr: "2", unit: "mm" }));
    expect(refused(params(MAX_EDITS + 1))).toBe(`edits lists ${MAX_EDITS + 1} edits, and the most is ${MAX_EDITS}. Split it into stages, such as the panels, then the joints, then the finishes`);
    const out = runTool("apply_edits", { edits: params(MAX_EDITS) }, ctx());
    expect(out.isError).toBeUndefined();
    expect(store.project.design.params).toHaveLength(MAX_EDITS);
  });

  it("holds a preview's edits to the same fields", () => {
    const out = runTool("preview_change", { title: "Wider", explanation: "A wider shelf.", ops: [{ op: "set_param", name: "width", expr: "600", size: 2 }] }, ctx());
    expect(out).toMatchObject({ isError: true, content: expect.stringMatching(/^Edit 1 \(set_param\): size isn't a field of set_param/) });
  });
});

// Issue #40: a list that's sent again after a refusal runs on past the edits
// the first one made, a number may come as a JSON number or in quotes, and a
// refusal of the wrong shape quotes the right one.
describe("a list of edits sent again", () => {
  const ctx = (): ToolContext => ({
    library: { list: () => [], get: () => undefined, propose: () => ({ id: "", part: {} as never }) },
    design: () => store.project.design,
    apply: (op) => store.project.apply([op]),
    requestTool: () => ({ id: "", count: 0 }),
    renderPng: () => Buffer.from(""),
  });

  it("counts an edit that's already there as made, so the rest of the list runs", async () => {
    const stage = (host: string) => [ply, left, right, shelf("shelf", "ply18"), dado("shelf_l", "left"), dado("shelf_r", host), oil];
    const client = scriptedClient([
      [call("a1", "apply_edits", { edits: stage("nope") })],
      [call("a2", "apply_edits", { edits: stage("right") })],
      [{ type: "text", text: "Carcass done." }],
    ]);
    await turn(client).run({ text: "Build a small carcass", selection: [] });

    expect(String(results(client, 1)[0]!.content)).toMatch(/^Edit 6 of 7 \(add_joint shelf_r\) was refused: host "nope" isn't a part\. Edits 1 to 5 are made/);
    const again = results(client, 2)[0]!;
    expect(again.is_error).toBeUndefined();
    const result = JSON.parse(String(again.content));
    expect(result).toMatchObject({
      ok: true,
      applied: 7,
      already_there: ["define_material ply18", "add_panel left", "add_panel right", "add_panel shelf", "add_joint shelf_l"],
      added: [],
    });
    expect(store.project.design.joints.map((j) => j.id)).toEqual(["shelf_l", "shelf_r"]);
    expect(store.project.design.finishes).toEqual({ "material:ply18": "satin_wood_oil/natur" });
    expect(store.project.history).toHaveLength(1);
  });

  it("refuses a different edit under an id that's taken, and shows the one there", () => {
    runTool("apply_edits", { edits: [ply, left, right, shelf("shelf", "ply18"), dado("shelf_l", "left")] }, ctx());
    const out = runTool("apply_edits", { edits: [{ ...dado("shelf_l", "left"), depth: "8" }, dado("shelf_r", "right")] }, ctx());
    expect(out.isError).toBe(true);
    expect(String(out.content).split("\n")[0]).toBe(
      'Edit 1 of 2 (add_joint shelf_l) was refused: Joint "shelf_l" already exists, and this one differs in depth. ' +
        'It\'s {"type": "dado", "host": "left", "guest": "shelf", "depth": "6"}. To change it, delete_joint it and add it again, or pick a new id. ' +
        "Nothing was changed. Edit 2 didn't run. Send edit 1 fixed, with the ones after it, in a new call.",
    );
  });

  it("says a single edit that's already there changed nothing", () => {
    runTool("apply_edits", { edits: [ply, left] }, ctx());
    const before = store.project.design;
    const { op: _op, ...fields } = left;
    const out = runTool("add_panel", fields, ctx());
    expect(out.isError).toBeUndefined();
    expect(JSON.parse(String(out.content))).toEqual({ ok: true, unchanged: "add_panel left is already there as given, so nothing changed" });
    expect(store.project.design).toBe(before);
  });

  it("takes a number as a JSON number or in quotes wherever an expression goes", () => {
    const tool = (name: string) => TOOLS.find((t) => t.name === name)!;
    const props = (name: string) => tool(name).input_schema.properties as Record<string, Record<string, unknown>>;
    expect(props("set_cutout").radius!.type).toEqual(["string", "number"]);
    expect(props("set_param").expr!.type).toEqual(["string", "number"]);
    expect(props("add_joint").depth!.type).toEqual(["string", "number"]);
    const out = runTool(
      "apply_edits",
      { edits: [ply, { ...left, y: { start: { at: 0 }, size: '"600"' } }, { op: "set_cutout", id: "left", cut: "hole", shape: "circle", centre: { y: { at: 300 }, z: { at: "'150'" } }, diameter: '"20"' }] },
      ctx(),
    );
    expect(out.isError).toBeUndefined();
    const side = store.project.design.parts[0]!;
    expect(side.y).toEqual({ start: { at: "0" }, size: "600" });
    expect(side.cuts).toEqual([{ id: "hole", kind: "cutout", shape: "circle", centre: { y: { at: "300" }, z: { at: "150" } }, diameter: "20" }]);
  });

  it("reads a plan's key size the same way, then checks it on the model", () => {
    runTool("apply_edits", { edits: [ply, left] }, ctx());
    const plan = (expr: unknown) => ({ summary: "One side.", parts: [], key_dims: [{ label: "Side height", expr, expected_mm: 600 }], joints: [], assumptions: [] });
    expect(runTool("submit_plan", plan("'600'"), ctx()).isError).toBeUndefined();
    expect(store.project.design.plan!.key_dims).toEqual([{ label: "Side height", expr: "600", expected_mm: 600, model_mm: 600 }]);
    // A quoted face isn't a number, so it stays as sent and the model can't work it out.
    const out = runTool("submit_plan", plan('"left.top"'), ctx());
    expect(out.isError).toBe(true);
    expect(String(out.content)).toMatch(/^The plan wasn't pinned\. 1 of 1 key size doesn't match the model:\n- Side height: can't work out "left\.top"/);
  });

  it("tells the shape of a material's sheet sizes, in its description and when they're wrong", () => {
    expect(TOOLS.find((t) => t.name === "define_material")!.description).toContain("such as [[2440, 1220]]");
    const out = runTool("apply_edits", { edits: [{ ...ply, sheet_sizes_mm: [2440, 1220] }] }, ctx());
    expect(String(out.content)).toMatch(/^Edit 1 of 1 \(define_material ply18\) was refused: sheet_sizes_mm must be a list of \[length along the grain, width\] pairs in mm\. Example: "sheet_sizes_mm": \[\[2440, 1220\]\]\./);
  });
});
