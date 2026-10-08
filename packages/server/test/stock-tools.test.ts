// Issue #78: Claude records the wood the woodworker already has with
// set_stock, and get_cut_list reads back the cutting plan, each board by
// letter with its rips. The fixture is an invented hall stand: four 21 mm
// pine stiles, 600 long and 44 wide. Every size is made up.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SYSTEM_PROMPT } from "../src/prompt.js";
import { Store } from "../src/store.js";
import { EDIT_TOOLS, runTool, TOOLS, type ToolContext } from "../src/tools.js";

type Block = Record<string, unknown>;

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "woodchuck-stock-"));
  store = new Store(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const stand: Block[] = [
  { op: "define_material", id: "pine", name: "21 mm pine", kind: "solid", thickness_mm: 21, grained: true },
  ...[1, 2, 3, 4].map((k) => ({
    op: "add_panel",
    id: `stile_${k}`,
    name: "Stile",
    material: "pine",
    thickness_axis: "z",
    grain_axis: "x",
    x: { start: { at: String(1000 * k) }, size: "600" },
    y: { start: { at: "0" }, size: "44" },
    z: { start: { at: "0" } },
  })),
];

const ctx = (): ToolContext => ({
  library: { list: () => [], get: () => undefined, propose: () => ({ id: "", part: {} as never }) },
  design: () => store.project.design,
  apply: (op) => store.project.apply([op]),
  requestTool: () => ({ id: "", count: 0 }),
  renderPng: () => Buffer.from(""),
});

describe("set_stock and the cutting plan", () => {
  it("is an edit tool, and the prompt says to ask what wood they have", () => {
    expect(EDIT_TOOLS.has("set_stock")).toBe(true);
    expect(TOOLS.find((t) => t.name === "set_stock")!.description).toContain("Ask what they have before guessing");
    expect(SYSTEM_PROMPT).toContain("set_stock");
  });

  it("cuts from the boards they have, ripping the stiles, and get_cut_list reads it back", () => {
    runTool("apply_edits", { edits: stand }, ctx());
    const set = runTool("set_stock", { material: "pine", owned: [{ length_mm: 1300, width_mm: 92, qty: 1 }] }, ctx());
    expect(set.isError).toBeFalsy();
    expect(store.project.design.stock).toEqual({ materials: { pine: { owned: [{ length_mm: 1300, width_mm: 92, qty: 1 }] } } });
    const plan = JSON.parse(runTool("get_cut_list", {}, ctx()).content as string).cutting_plan as string[];
    expect(plan).toContain("From your stock: 1 of your 92 × 21 pine board at 1300.");
    expect(plan).toContain("Nothing to buy.");
    expect(plan.find((l) => l.startsWith("A: yours, 21 mm pine 1300 × 92."))).toContain("Stile 600, rip to 44");
  });

  it("refuses stock for a material that isn't there, with the fix", () => {
    const r = runTool("set_stock", { material: "oak", owned: [{ length_mm: 1300, width_mm: 92, qty: 1 }] }, ctx());
    expect(r).toMatchObject({ isError: true });
    expect(String(r.content)).toContain('There\'s no material "oak"');
  });
});
