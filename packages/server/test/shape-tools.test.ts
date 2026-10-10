// Issue #3: Claude shapes a part with set_edge_cut, set_cutout and
// delete_cut. Each one checks its input through the core operations, joins
// apply_edits and preview_change, reports the shape it leaves, and undoes
// with the rest of the turn. The fixture is an invented drawer box whose
// sides slope from a 150 mm back down to an 80 mm front, 380 mm deep, with
// a rail over its front. Every size is made up.

import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyOps, cutList, derive, emptyDesign, runChecks, type Design, type Op } from "@woodchuck/core";
import { describePins, pinnedCut, Turn, type MessagesClient } from "../src/agent.js";
import { createApp } from "../src/index.js";
import { designText, type AppState } from "../src/answers.js";
import { scriptedClient } from "../src/scripted.js";
import { Store } from "../src/store.js";
import { EDIT_TOOLS, runTool, TOOLS, type ToolContext } from "../src/tools.js";

type Block = Record<string, unknown>;

const call = (id: string, name: string, input: Block): Block => ({ type: "tool_use", id, name, input });

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "woodchuck-shape-"));
  store = new Store(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function turn(client: MessagesClient) {
  return new Turn(store, client, { chat() {}, delta() {}, changed() {} }, () => Buffer.from("png"));
}

const results = (client: ReturnType<typeof scriptedClient>, n: number) => client.sent[n]!.messages.at(-1)!.content as unknown as Block[];
const resultOf = (client: ReturnType<typeof scriptedClient>, n: number, id: string) => results(client, n).find((b) => b.tool_use_id === id)!;

const box: Block[] = [
  { op: "define_material", id: "ply12", name: "12 mm birch ply", kind: "sheet", thickness_mm: 12, grained: true },
  { op: "set_param", name: "box_width", expr: "340", unit: "mm" },
  { op: "set_param", name: "box_depth", expr: "380", unit: "mm" },
  { op: "set_param", name: "back_height", expr: "150", unit: "mm" },
  { op: "set_param", name: "front_height", expr: "80", unit: "mm" },
  ...(["side_l", "side_r"] as const).map((id, i) => ({
    op: "add_panel",
    id,
    name: i ? "Drawer side, right" : "Drawer side, left",
    material: "ply12",
    thickness_axis: "x",
    grain_axis: "z",
    x: i ? { end: { at: "box_width" } } : { start: { at: "0" } },
    y: { start: { at: "0" }, size: "back_height" },
    z: { start: { at: "0" }, size: "box_depth" },
  })),
  {
    op: "add_panel",
    id: "back",
    name: "Drawer back",
    material: "ply12",
    thickness_axis: "z",
    grain_axis: "x",
    x: { start: { face: "side_l.right" }, end: { face: "side_r.left" } },
    y: { start: { at: "0" }, size: "back_height" },
    z: { start: { face: "side_l.back" } },
  },
  {
    op: "add_panel",
    id: "front",
    name: "Drawer front",
    material: "ply12",
    thickness_axis: "z",
    grain_axis: "x",
    x: { start: { face: "side_l.right" }, end: { face: "side_r.left" } },
    y: { start: { at: "0" }, size: "front_height" },
    z: { end: { face: "side_l.front" } },
  },
  ...["side_l", "side_r"].flatMap((host) => ["back", "front"].map((guest) => ({ op: "add_joint", id: `${guest}_${host.slice(-1)}`, type: "dado", host, guest, depth: "4" }))),
];
const slope = (id: string): Block => ({ op: "set_edge_cut", id, cut: "slope", edge: "top", start: { face: "back.top" }, end: { face: "front.top" } });
const cable: Block = { op: "set_cutout", id: "back", cut: "cable", shape: "circle", centre: { x: { at: "170" }, y: { face: "back.top", offset: "-40" } }, diameter: "30" };
const rail: Block = {
  op: "add_panel",
  id: "rail",
  name: "Rail",
  material: "ply12",
  thickness_axis: "y",
  grain_axis: "x",
  x: { start: { at: "0" }, size: "box_width" },
  y: { start: { at: "120" } },
  z: { start: { at: "250" }, end: { at: "box_depth" } },
  tags: ["wall_mounted"],
};
const clearance: Block = { op: "set_rule", id: "rail_clear", expr: "gap_y(rail, side_l) >= 6", severity: "error", message: "The drawer needs 6 mm under the rail" };

const SLOPE_TEXT = "top edge sloped from 150 at the back end to 80 at the front end, 10.4°";
const asOps = (blocks: Block[]) => blocks as unknown as Op[];
const drawer = (more: Block[] = []): Design => applyOps(emptyDesign("Sloped drawer"), asOps([...box, ...more]));
/** A tool call's input, from an edit as apply_edits lists it. */
const input = ({ op: _op, ...rest }: Block) => rest;

describe("the cut tools", () => {
  it("are edit tools, so apply_edits and preview_change take them", () => {
    for (const name of ["set_edge_cut", "set_cutout", "delete_cut"]) {
      expect(TOOLS.some((t) => t.name === name)).toBe(true);
      expect(EDIT_TOOLS.has(name)).toBe(true);
    }
    const tool = (name: string) => TOOLS.find((t) => t.name === name)!;
    // The app tells a design when the tool it asked for is built, so slopes lead.
    expect(tool("set_edge_cut").description).toMatch(/^Slope, taper or chamfer an edge of a panel/);
    expect(Object.keys(tool("set_edge_cut").input_schema.properties!)).toEqual(["id", "cut", "edge", "start", "end", "start_along", "end_along", "note"]);
    expect(tool("set_edge_cut").input_schema.required).toEqual(["id", "cut", "edge", "start", "end"]);
    expect(Object.keys(tool("set_cutout").input_schema.properties!)).toEqual(["id", "cut", "shape", "x", "y", "z", "radius", "centre", "diameter", "note"]);
    expect(tool("set_cutout").input_schema.required).toEqual(["id", "cut", "shape"]);
    expect(tool("delete_cut").input_schema.required).toEqual(["id", "cut"]);
    expect(tool("add_panel").description).not.toContain("rectangular");
    expect(tool("add_panel").description).toContain("set_edge_cut and set_cutout");
  });

  it("make the cuts their descriptions' examples promise", () => {
    const d = derive(
      drawer([
        { op: "set_param", name: "kick_height", expr: "40", unit: "mm" },
        { op: "set_param", name: "kick_depth", expr: "30", unit: "mm" },
        { op: "set_edge_cut", id: "side_l", cut: "corner", edge: "top", start: { face: "side_l.top" }, start_along: { face: "side_l.front", offset: "-30" }, end: { face: "side_l.top", offset: "-30" } },
        { op: "set_cutout", id: "back", cut: "cable", shape: "circle", centre: { x: { at: "300" }, y: { face: "back.top", offset: "-80" } }, diameter: "35" },
        { op: "set_cutout", id: "side_r", cut: "kick", shape: "rect", y: { start: { face: "side_r.bottom" }, size: "kick_height" }, z: { end: { face: "side_r.front" }, size: "kick_depth" } },
      ]),
    );
    const texts = (id: string) => d.byId.get(id)!.profile!.cuts.map((c) => `${c.kind}: ${c.text}`);
    expect(texts("side_l")).toEqual(["chamfer: top front corner cut off 30 along the top edge and 30 along the front end, 45°"]);
    expect(texts("back")).toEqual(["hole: 35 mm hole, centre 288 from the left and 70 from the bottom"]);
    expect(texts("side_r")).toEqual(["notch: 30 × 40 notch out of the bottom front corner"]);
  });

  it("each make a cut, are refused with the reason, and undo with the turn", async () => {
    store.project.change("you", "Drawer box", asOps(box));
    const client = scriptedClient([
      [
        call("e1", "set_edge_cut", input(slope("side_l"))),
        call("e2", "set_edge_cut", { ...input(slope("side_r")), edge: "left" }),
        call("e3", "set_edge_cut", { ...input(slope("side_r")), end: { face: "front.back" } }),
        call("e4", "set_edge_cut", { ...input(slope("side_r")), id: "plinth" }),
        call("c1", "set_cutout", input(cable)),
        call("c2", "set_cutout", { ...input(cable), cut: "vent", centre: { x: { at: "100" }, z: { at: "6" } } }),
        call("c3", "set_cutout", { ...input(cable), id: "lid" }),
        call("d1", "delete_cut", { id: "side_l", cut: "slope" }),
        call("d2", "delete_cut", { id: "back", cut: "nope" }),
        call("d3", "delete_cut", { id: "plinth", cut: "slope" }),
      ],
      [{ type: "text", text: "Sloped and holed." }],
    ]);
    await turn(client).run({ text: "Slope the sides and drill the back", selection: [] });

    const ok = (id: string) => {
      const r = resultOf(client, 1, id);
      expect(r.is_error).toBeUndefined();
      return JSON.parse(String(r.content)) as { sizes: { id: string; shape?: string[] }[]; problems: { new: string[] } };
    };
    const refused = (id: string) => {
      const r = resultOf(client, 1, id);
      expect(r.is_error).toBe(true);
      return String(r.content);
    };

    // A cut that leaves the box where it was still comes back, with the shape it leaves.
    expect(ok("e1").sizes).toEqual([
      { id: "side_l", cut_mm: { length: 380, width: 150, thickness: 12 }, from_mm: [0, 0, 0], to_mm: [12, 150, 380], shape: [`slope: ${SLOPE_TEXT}`] },
    ]);
    expect(refused("e2")).toBe("side_r cut slope can't take wood from the left face, which is a broad face of side_r. Pick one of its edges: bottom, top, back, front");
    expect(refused("e3")).toBe("side_r cut slope end is on the y axis, so its face must be bottom or top, not back");
    expect(refused("e4")).toBe('There\'s no panel "plinth"');
    expect(ok("c1").sizes.map((s) => [s.id, s.shape])).toEqual([["back", ["cable: 30 mm hole, centre 158 from the left and 110 from the bottom"]]]);
    expect(refused("c2")).toBe("back cut vent goes right through back, and z is its thickness axis. Give it only x and y");
    expect(refused("c3")).toBe('There\'s no panel "lid"');
    expect(ok("d1").sizes).toEqual([{ id: "side_l", cut_mm: { length: 380, width: 150, thickness: 12 }, from_mm: [0, 0, 0], to_mm: [12, 150, 380], shape: ["no cuts: the whole blank"] }]);
    expect(refused("d2")).toBe('back has no cut "nope". Its cuts: cable');
    expect(refused("d3")).toBe('There\'s no panel "plinth"');

    // The chat names each step by its part, which is how the screen finds it.
    const lines = store.project.chat.filter((c) => c.kind === "tool").map((c) => c.kind === "tool" && c.summary.split(":")[0]);
    expect(lines.slice(0, 1)).toEqual(["set edge cut side_l"]);
    expect(lines).toContain("set cutout back");
    expect(lines).toContain("delete cut side_l");

    const parts = store.project.design.parts;
    expect(parts.find((p) => p.id === "side_l")!.cuts).toBeUndefined();
    expect(parts.find((p) => p.id === "back")!.cuts).toEqual([{ id: "cable", kind: "cutout", shape: "circle", centre: { x: { at: "170" }, y: { face: "back.top", offset: "-40" } }, diameter: "30" }]);
    store.project.undo();
    expect(store.project.design.parts.every((p) => !p.cuts)).toBe(true);
    expect(store.project.design.parts).toHaveLength(4);
  });
});

describe("cuts in a list of edits", () => {
  it("builds a sloped side and a holed back in one call, and stops at a refused cut with the edits before it kept", async () => {
    const vent: Block = { op: "set_cutout", id: "back", cut: "vent", shape: "rect", x: { start: { at: "60" }, size: "80" }, y: { start: { at: "30" }, size: "20" }, z: { size: "5" } };
    const { z: _z, ...flat } = vent;
    const slot = { ...flat, radius: "10" };
    const edits = [...box, slope("side_l"), cable, vent, slope("side_r")];
    const client = scriptedClient([[call("a1", "apply_edits", { edits })], [call("a2", "apply_edits", { edits: [slot, slope("side_r")] })], [{ type: "text", text: "Done." }]]);
    await turn(client).run({ text: "Build a drawer that slopes to the front, with a cable hole in the back", selection: [] });

    const failed = resultOf(client, 1, "a1");
    expect(failed.is_error).toBe(true);
    const [lead, json] = String(failed.content).split("\n");
    const n = box.length;
    expect(lead).toBe(
      `Edit ${n + 3} of ${n + 4} (set_cutout back vent) was refused: back cut vent goes right through back, and z is its thickness axis. Give it only x and y. ` +
        `Edits 1 to ${n + 2} are made and stay in this turn's change. Edit ${n + 4} didn't run. Send edit ${n + 3} fixed, with the ones after it, in a new call.`,
    );
    const summary = JSON.parse(json!) as { sizes: { id: string; shape?: string[] }[] };
    const shapes = Object.fromEntries(summary.sizes.map((s) => [s.id, s.shape]));
    expect(shapes.side_l).toEqual([`slope: ${SLOPE_TEXT}`]);
    expect(shapes.back).toEqual(["cable: 30 mm hole, centre 158 from the left and 110 from the bottom"]);
    expect(shapes.side_r).toBeUndefined();

    // The fix carries on in the same change: a slot whose radius is half its short side.
    const fixed = JSON.parse(String(resultOf(client, 2, "a2").content)) as { ok: boolean; sizes: { id: string; shape?: string[] }[] };
    expect(fixed.ok).toBe(true);
    expect(fixed.sizes.find((s) => s.id === "back")!.shape).toEqual([
      "cable: 30 mm hole, centre 158 from the left and 110 from the bottom",
      "vent: 80 × 20 cutout with 10 mm round corners, 48 from the left and 30 from the bottom",
    ]);
    expect(fixed.sizes.find((s) => s.id === "side_r")!.shape).toEqual([`slope: ${SLOPE_TEXT}`]);
    expect(store.project.history).toHaveLength(1);
    store.project.undo();
    expect(store.project.design.parts).toEqual([]);
  });

  it("holds a listed cut to its tool's fields before any edit runs", () => {
    const ctx: ToolContext = {
      library: { list: () => [], get: () => undefined, propose: () => ({ id: "", part: {} as never }) },
      design: () => store.project.design,
      apply: (op) => store.project.apply([op]),
      requestTool: () => ({ id: "", count: 0 }),
      renderPng: () => Buffer.from(""),
    };
    const out = runTool("apply_edits", { edits: [box[0], { ...slope("side_l"), diameter: "10" }] }, ctx);
    expect(out).toMatchObject({
      isError: true,
      content: "Edit 2 (set_edge_cut): diameter isn't a field of set_edge_cut. Its fields: id, cut, edge, start, end, start_along, end_along, note",
    });
    expect(runTool("apply_edits", { edits: [{ op: "delete_cut", id: "side_l" }] }, ctx)).toMatchObject({ isError: true, content: "Edit 1 (delete_cut) needs cut" });
    expect(store.project.design.materials).toEqual([]);
  });
});

describe("a cut as a suggested change", () => {
  const ctx = (design: () => Design): ToolContext => ({
    library: { list: () => [], get: () => undefined, propose: () => ({ id: "", part: {} as never }) },
    design,
    apply: () => {
      throw new Error("A preview never changes the design");
    },
    requestTool: () => ({ id: "", count: 0 }),
    renderPng: () => Buffer.from(""),
  });
  const ask = { title: "Sloped sides", explanation: "Sloping the sides down to the front shows what's inside.", ops: [slope("side_l"), slope("side_r")] };

  it("tries the cut on a copy and says what it changes, with the design left alone", () => {
    const design = drawer();
    const out = runTool("preview_change", ask, ctx(() => design));
    expect(out.isError).toBeUndefined();
    const shown = JSON.parse(String(out.content)) as { changes: string[]; problems: { new: string[] } };
    expect(shown.changes.join("\n")).toContain("slope (edge cut) on side_l");
    expect(shown.changes.join("\n")).toContain("slope (edge cut) on side_r");
    expect(shown.problems.new).toEqual([]);
    expect(out.waitFor).toMatchObject({ kind: "preview", ops: [{ op: "set_edge_cut", id: "side_l" }, { op: "set_edge_cut", id: "side_r" }] });
    expect(design.parts.every((p) => !p.cuts)).toBe(true);
    // A cut that changes nothing is refused before the woodworker sees it.
    expect(runTool("preview_change", { ...ask, ops: [{ op: "delete_cut", id: "side_l", cut: "slope" }] }, ctx(() => design))).toMatchObject({
      isError: true,
      content: 'side_l has no cut "slope". It has no cuts',
    });
  });

  it("waits for Apply, then makes the cut as one change", async () => {
    const appDir = mkdtempSync(path.join(tmpdir(), "woodchuck-shape-app-"));
    const client = scriptedClient([
      [call("a1", "apply_edits", { edits: box })],
      [{ type: "text", text: "Here's the box." }],
      [call("p1", "preview_change", ask)],
      [{ type: "text", text: "Sloped." }],
    ]);
    const app = createApp({ dataDir: appDir, client, watchTools: false });
    await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const post = (p: string, body: unknown) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    type State = { waiting: string[]; design: Design; chat: { kind: string; status?: string; ops?: Op[] }[] };
    const settle = async (): Promise<State> => {
      for (let i = 0; i < 200; i++) {
        const busy = (await (await fetch(`${base}/api/busy`)).json()) as { busy: boolean };
        if (!busy.busy) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      return (await (await fetch(`${base}/api/state`)).json()) as State;
    };
    try {
      await post("/api/chat", { text: "Build a drawer box" });
      await settle();
      await post("/api/chat", { text: "Could the sides slope?" });
      let s = await settle();
      expect(s.waiting).toEqual(["preview"]);
      expect(s.design.parts.every((p) => !p.cuts)).toBe(true);
      expect(s.chat.find((c) => c.kind === "preview")!.ops!.map((o) => o.op)).toEqual(["set_edge_cut", "set_edge_cut"]);

      await post("/api/chat", { text: "Apply it.", preview: "apply" });
      s = await settle();
      expect(s.chat.find((c) => c.kind === "preview")!.status).toBe("applied");
      const d = derive(s.design);
      expect(["side_l", "side_r"].map((id) => d.byId.get(id)!.profile!.cuts.map((c) => c.text))).toEqual([[SLOPE_TEXT], [SLOPE_TEXT]]);
    } finally {
      await app.close();
      rmSync(appDir, { recursive: true, force: true });
    }
  });
});

describe("a pin on a cut", () => {
  const design = drawer([slope("side_l"), cable, { op: "set_cutout", id: "side_r", cut: "kick", shape: "rect", y: { start: { face: "side_r.bottom" }, size: "30" }, z: { end: { face: "side_r.front" }, size: "40" } }]);
  const d = derive(design);
  const pin = (part: string, face: string, point_mm: [number, number, number]) => ({ n: 1, part, face, point_mm });

  it("names the cut whose edge or hole it sits on", () => {
    // The slope is 115 high halfway along the side.
    expect(pinnedCut(design, d, pin("side_l", "top", [6, 115, 190]))).toBe("on the sloped edge from cut slope");
    expect(pinnedCut(design, d, pin("back", "left", [185, 110, 6]))).toBe("on the wall of the hole from cut cable");
    expect(pinnedCut(design, d, pin("side_r", "bottom", [334, 30, 360]))).toBe("on the edge of the notch from cut kick");
    expect(pinnedCut(design, d, pin("side_r", "front", [334, 15, 340]))).toBe("on the edge of the notch from cut kick");
  });

  it("names nothing on wood no cut touched, on a broad face, or on a part with no cuts", () => {
    expect(pinnedCut(design, d, pin("side_l", "bottom", [6, 0, 190]))).toBe("");
    expect(pinnedCut(design, d, pin("side_l", "back", [6, 100, 0]))).toBe("");
    expect(pinnedCut(design, d, pin("side_l", "right", [12, 100, 190]))).toBe("");
    expect(pinnedCut(design, d, pin("front", "top", [170, 80, 374]))).toBe("");
    expect(pinnedCut(design, d, pin("nowhere", "top", [0, 0, 0]))).toBe("");
  });

  it("tells Claude which cut a pin is on", async () => {
    store.project.change("you", "Sloped drawer", asOps([...box, slope("side_l")]));
    const client = scriptedClient([[{ type: "text", text: "Got it." }]]);
    await turn(client).run({ text: "Make this shallower", selection: [], pins: [pin("side_l", "top", [6, 115, 190]), { ...pin("side_l", "bottom", [6, 0, 190]), n: 2 }] });
    const content = client.sent[0]!.messages.at(-1)!.content as unknown as Block[];
    expect(String(content.at(-1)!.text)).toMatch(
      /^Make this shallower\n\n\(Pinned in the app: pin 1 on side_l, top face, at x 6, y 115, z 190 mm, on the sloped edge from cut slope; pin 2 on side_l, bottom face, at x 6, y 0, z 190 mm\.\)\n\n/,
    );
    expect(describePins([pin("side_l", "top", [6, 115, 190])])).toBe("pin 1 on side_l, top face, at x 6, y 115, z 190 mm");
  });
});

describe("another chat reads the shape", () => {
  it("puts each part's shape on its line in woodchuck_design", () => {
    const design = drawer([slope("side_l"), cable, { ...cable, cut: "cable_2", centre: { x: { at: "250" }, y: { at: "110" } } }, { op: "set_cutout", id: "side_r", cut: "kick", shape: "rect", y: { start: { face: "side_r.bottom" }, size: "30" }, z: { end: { face: "side_r.front" }, size: "40" } }]);
    const s: AppState = { busy: false, waiting: [], design, project: { slug: "drawer", name: "Sloped drawer" }, report: { errors: 0, warnings: 0, ready_to_cut: true }, chat: [] };
    const lines = designText(s).split("\n");
    expect(lines).toContain("- side_l (Drawer side, left): 380 × 150 × 12, ply12, top sloped from 150 at the back to 80 at the front, 10.4°");
    expect(lines).toContain("- side_r (Drawer side, right): 380 × 150 × 12, ply12, 1 notch");
    expect(lines).toContain("- back (Drawer back): 316 × 150 × 12, ply12, 2 holes");
    expect(lines).toContain("- front (Drawer front): 316 × 80 × 12, ply12");
  });
});

describe("a drawer side sloped by Claude", () => {
  it("is made with set_edge_cut, measured with gap_y, and passes the checks", async () => {
    const client = scriptedClient([
      [{ type: "text", text: "The box first." }, call("a1", "apply_edits", { edits: [...box, rail] })],
      [{ type: "text", text: "Now the slope, and room under the rail." }, call("s1", "set_edge_cut", input(slope("side_l"))), call("s2", "set_edge_cut", input(slope("side_r"))), call("r1", "set_rule", input(clearance))],
      [call("k1", "check_design", {})],
      [{ type: "text", text: "The sides slope from the back's top to the front's, and the drawer clears the rail." }],
    ]);
    await turn(client).run({ text: "A drawer under a rail, with sides that slope down to the front", selection: [] });

    for (const id of ["s1", "s2", "r1"]) expect(resultOf(client, 2, id).is_error).toBeUndefined();
    const check = JSON.parse(String(resultOf(client, 3, "k1").content)) as { ready_to_cut: boolean; errors: number; warnings: number; problems: unknown[] };
    expect(check).toEqual({ ready_to_cut: true, errors: 0, warnings: 0, problems: [] });

    const design = store.project.design;
    const d = derive(design);
    // The slope is 103.9 high where the rail starts, at z 250, and the rail's underside is at 120.
    expect(d.evaluate("gap_y(rail, side_l)").value).toBeCloseTo(120 - (150 - (70 * 250) / 380), 5);
    expect(runChecks(design, d).issues).toEqual([]);
    const side = cutList(design, d).rows.find((r) => r.parts.includes("side_l"))!;
    expect(side.shape).toEqual([SLOPE_TEXT]);

    // The blank's top reads the slope's highest point, which is why the rule measures with gap_y.
    expect(d.evaluate("rail.bottom - side_l.top").value).toBe(-30);
    store.project.undo();
    expect(store.project.design.parts).toEqual([]);
  });
});
