// Issue #56: a requirement becomes a rule for every direction it limits, and
// an overall size holds the whole piece. Claude's instructions and set_rule
// say so, with the names that read the whole piece. A scripted Claude builds
// an invented bookshelf for Globex, "300 deep" with a 6 mm back fixed on
// behind 300 mm sides, and check_design shows it the failing rule with the
// part at each end. It takes the back's thickness off the sides, and the
// checks pass. Every size is made up: 760 mm wide, 1200 mm tall, in 18 mm
// birch ply. No key.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyOps, derive, emptyDesign, recordConsoleOps, runChecks, type Op } from "@woodchuck/core";
import { Turn, type MessagesClient } from "../src/agent.js";
import { SYSTEM_PROMPT } from "../src/prompt.js";
import { extent } from "../src/quality.js";
import { scriptedClient } from "../src/scripted.js";
import { Store } from "../src/store.js";
import { TOOLS } from "../src/tools.js";

type Block = Record<string, unknown>;

const call = (id: string, name: string, input: Block): Block => ({ type: "tool_use", id, name, input });

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "woodchuck-requirements-"));
  store = new Store(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function turn(client: MessagesClient) {
  return new Turn(store, client, { chat() {}, delta() {}, changed() {} }, () => Buffer.from("png"));
}

const resultOf = (client: ReturnType<typeof scriptedClient>, n: number, id: string) =>
  (client.sent[n]!.messages.at(-1)!.content as unknown as Block[]).find((b) => b.tool_use_id === id)!;

const setRule = TOOLS.find((t) => t.name === "set_rule")!;

describe("Claude's instructions on requirements", () => {
  it("ask for a rule in every direction a requirement limits", () => {
    expect(SYSTEM_PROMPT).toContain("Add one whenever the woodworker gives you a requirement the geometry must keep meeting, and one for each direction it limits.");
    expect(SYSTEM_PROMPT).toContain(
      '12-inch LPs need lp_clear across a drawer, "drawer_side_r.left - drawer_side_l.right >= lp_clear", and standing up in it, from its bottom to whatever is over it, such as "top.bottom - drawer_bottom.top >= lp_clear".',
    );
    expect(SYSTEM_PROMPT).toContain("A shelf's load needs a rule on its span and one on its thickness.");
    expect(setRule.description).toContain("Use one for every requirement the woodworker states, and one for each direction it limits.");
    expect(setRule.description).toContain('"drawer_side_r.left - drawer_side_l.right >= lp_clear", and standing up in it, "top.bottom - drawer_bottom.top >= lp_clear"');
  });

  it("ask whether a count on a piece with sections means in total or in each", () => {
    expect(SYSTEM_PROMPT).toContain('ask whether it\'s two in total or two in each before changing anything.');
  });

  it("hold an overall size to the whole piece, back, feet and top included", () => {
    expect(SYSTEM_PROMPT).toContain(
      "A rule or a plan's key size can also read the whole piece: overall.width, overall.height and overall.depth are the box around every part, and overall.top and the other faces are its edges.",
    );
    expect(SYSTEM_PROMPT).toContain(
      'An overall size the woodworker gives, such as "make it 300 deep", is the whole piece, with the back, feet, top and any overhang in it. Hold it with a rule on the whole piece, such as "overall.depth == 300", and fit the parts inside it: a back goes between or into the sides, or the sides get shallower by its thickness.',
    );
    expect(setRule.description).toContain(
      'An overall size is the whole piece: overall.width, overall.height and overall.depth are the box around every part, back, feet and top included, such as "overall.depth == 300"',
    );
    expect(setRule.description).toContain("Props and hardware aren't in it, so for a piece on bought legs, overall.top is its height from the floor.");
  });

  it("quote rules that work on the record console", () => {
    const consoleDesign = applyOps(emptyDesign("Initech record console"), recordConsoleOps());
    // A quoted comparison, written with an expression's characters only.
    const quoted = [...`${SYSTEM_PROMPT} ${setRule.description}`.matchAll(/"([a-z0-9_.#() +\-*/<>=!&|]*(?:>=|==)[a-z0-9_.#() +\-*/<>=!&|]*)"/g)].map((m) => m[1]!);
    expect(new Set(quoted)).toEqual(new Set(["drawer_side_r.left - drawer_side_l.right >= lp_clear", "top.bottom - drawer_bottom.top >= lp_clear", "overall.depth == 300"]));
    const ruled = applyOps(consoleDesign, quoted.map((expr, i) => ({ op: "set_rule", id: `quoted_${i}`, expr, message: "Quoted" }) as Op));
    const d = derive(ruled);
    // The console's drawers stand LPs up with 339 mm over their bottoms, and the whole piece is 520 mm deep.
    expect(d.evaluate("top.bottom - drawer_bottom.top").value).toBe(339);
    expect(d.evaluate("overall.depth").value).toBe(520);
    expect(runChecks(ruled, d).issues.filter((i) => i.code === "rule_error")).toEqual([]);
  });
});

const upright = (id: string, name: string, x: Block): Block => ({
  op: "add_panel",
  id,
  name,
  material: "birch18",
  thickness_axis: "x",
  grain_axis: "y",
  x,
  y: { start: { at: "0" }, size: "height" },
  z: { start: { at: "0" }, size: "depth" },
  tags: ["side"],
});
const across = (id: string, name: string, y: Block): Block => ({
  op: "add_panel",
  id,
  name,
  material: "birch18",
  thickness_axis: "y",
  grain_axis: "x",
  x: { start: { face: "side_l.right" }, end: { face: "side_r.left" } },
  y,
  z: { start: { at: "0" }, size: "depth" },
  tags: ["shelf"],
});

/** Claude's first try: the sides are 300 deep, and the back goes on behind them. */
const bookshelf = call("b1", "apply_edits", {
  edits: [
    { op: "define_material", id: "birch18", name: "18 mm birch ply", kind: "sheet", thickness_mm: 18, grained: true, sheet_sizes_mm: [[2440, 1220]] },
    { op: "define_material", id: "ply6", name: "6 mm ply", kind: "sheet", thickness_mm: 6, grained: true, sheet_sizes_mm: [[2440, 1220]] },
    { op: "set_param", name: "width", expr: "760", unit: "mm" },
    { op: "set_param", name: "height", expr: "1200", unit: "mm" },
    { op: "set_param", name: "depth", expr: "300", unit: "mm" },
    upright("side_l", "Left side", { start: { at: "0" } }),
    upright("side_r", "Right side", { end: { at: "width" } }),
    across("bottom", "Bottom", { start: { at: "0" } }),
    across("shelf", "Shelf", { start: { at: "580" } }),
    across("top", "Top", { end: { at: "height" } }),
    {
      op: "add_panel",
      id: "back",
      name: "Back",
      material: "ply6",
      thickness_axis: "z",
      grain_axis: "y",
      x: { start: { face: "side_l.left" }, end: { face: "side_r.right" } },
      y: { start: { at: "0" }, end: { at: "height" } },
      z: { end: { face: "side_l.back" } },
    },
    { op: "set_rule", id: "overall_depth", expr: "overall.depth == 300", severity: "error", message: "The bookshelf is 300 mm deep overall, back included" },
  ],
});

describe("a bookshelf 300 deep with a back behind its sides", () => {
  it("fails its overall rule in check_design, names the back, and passes once the sides make room", async () => {
    const client = scriptedClient([
      [{ type: "text", text: "Carcass and back first." }, bookshelf],
      [call("k1", "check_design", {})],
      [{ type: "text", text: "The back sticks out 6 mm. The sides give up its thickness." }, call("s1", "set_param", { name: "depth", expr: "300 - back.thickness", unit: "mm" }), call("k2", "check_design", {})],
      [{ type: "text", text: "It's 300 mm deep overall, back included." }],
    ]);
    await turn(client).run({ text: "A bookshelf 760 mm wide and 1200 mm tall in 18 mm birch ply. Make it 300 deep.", selection: [] });

    expect(resultOf(client, 1, "b1").is_error).toBeUndefined();
    const first = JSON.parse(String(resultOf(client, 2, "k1").content)) as { ready_to_cut: boolean; errors: number; problems: Block[] };
    expect(first).toMatchObject({ ready_to_cut: false, errors: 1 });
    expect(first.problems).toEqual([
      {
        severity: "error",
        message: "The bookshelf is 300 mm deep overall, back included (rule overall_depth)",
        working: "overall.depth (306) == 300, where overall.depth runs from back.back (-6) to side_l.front (300)",
      },
    ]);

    // The edit's own result says the rule is fixed, and the full checks agree.
    const fixed = JSON.parse(String(resultOf(client, 3, "s1").content)) as { problems: { errors: number; fixed: string[] } };
    expect(fixed.problems).toMatchObject({ errors: 0, fixed: ["The bookshelf is 300 mm deep overall, back included (rule overall_depth)"] });
    expect(JSON.parse(String(resultOf(client, 3, "k2").content))).toEqual({ ready_to_cut: true, errors: 0, warnings: 0, problems: [] });

    const design = store.project.design;
    const d = derive(design);
    expect(d.evaluate("side_l.size_z").value).toBe(294);
    expect(d.evaluate("overall.depth").value).toBe(300);
    // The benchmark's depth-300 check measures the same box, so it passes too.
    expect(extent(design).depth_mm).toBe(300);
  });

  it("measures the same 306 mm the benchmark saw before the fix", () => {
    const edits = (bookshelf.input as { edits: Op[] }).edits;
    const design = applyOps(emptyDesign("Globex bookshelf"), edits);
    expect(derive(design).evaluate("overall.depth").value).toBe(306);
    expect(extent(design).depth_mm).toBe(306);
  });
});
