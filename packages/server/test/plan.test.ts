// Issue #39: submit_plan works out every key size on the model before it
// pins the plan. A size the model doesn't give, or an expression that can't
// be worked out, refuses the plan with each one listed, and nothing is
// pinned. A plan that passes carries the model's number for each size, which
// the card shows. The fixture is an invented bookcase in 18 mm ply, 600 mm
// wide, with a shelf repeated three times up its sides at a 320 mm pitch. The
// clear gap between two shelves is 302 mm. Every size is made up.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Turn, type MessagesClient } from "../src/agent.js";
import { SYSTEM_PROMPT } from "../src/prompt.js";
import { scriptedClient } from "../src/scripted.js";
import { Store } from "../src/store.js";
import { TOOLS } from "../src/tools.js";

type Block = Record<string, unknown>;

const call = (id: string, name: string, input: Block): Block => ({ type: "tool_use", id, name, input });
const scripted = (replies: Block[][]) => scriptedClient(replies);

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "woodchuck-plan-"));
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
  y: { start: { at: "0" }, size: "900" },
  z: { start: { at: "0" }, size: "250" },
});

/** The draft Claude builds before it plans, as one list of edits. */
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
      y: { start: { at: "100" } },
      z: { start: { at: "0" }, size: "250" },
    },
    { op: "set_array", id: "shelves", parts: ["shelf"], axis: "y", count: "3", pitch: "320" },
  ],
});

const plan = (key_dims: Block[]): Block => ({
  summary: "A three-shelf bookcase in birch ply.",
  parts: [
    { label: "Side", qty: 2, tag: "side" },
    { label: "Shelf", qty: 3, tag: "shelf" },
  ],
  key_dims,
  joints: ["Shelves screwed through the sides, quick to make"],
  assumptions: ["18 mm birch ply"],
});

const gap = { label: "Clear gap between shelves", expr: "shelf#2.bottom - shelf.top" };
const pitch = { label: "Shelf pitch", expr: "shelf#2.bottom - shelf.bottom" };
const inside = { label: "Inside width", expr: "right.left - left.right" };

const resultOf = (client: ReturnType<typeof scriptedClient>, n: number, id: string) =>
  (client.sent[n]!.messages.at(-1)!.content as unknown as Block[]).find((b) => b.tool_use_id === id)!;

describe("a plan's key sizes", () => {
  it("pin with the model's number for each, which the card shows", async () => {
    const client = scripted([
      [bookcase],
      [call("p1", "submit_plan", plan([{ ...gap, expected_mm: 302 }, { ...pitch, expected_mm: 320 }, { ...inside, expected_mm: 564.3 }]))],
    ]);
    await turn(client).run({ text: "A bookcase with three shelves", selection: [] });

    expect(store.project.pending?.waiting).toEqual([{ tool_use_id: "p1", kind: "plan" }]);
    const pinned = [
      { ...gap, expected_mm: 302, model_mm: 302 },
      { ...pitch, expected_mm: 320, model_mm: 320 },
      // Within the 0.5 mm the app allows, and the card gives the model's own number.
      { ...inside, expected_mm: 564.3, model_mm: 564 },
    ];
    expect(store.project.design.plan).toMatchObject({ status: "proposed", key_dims: pinned });
    const card = store.project.chat.find((c) => c.kind === "plan");
    expect(card).toMatchObject({ kind: "plan", plan: { key_dims: pinned } });
  });

  it("refuse a plan that calls the shelf pitch the clear gap, and pin nothing", async () => {
    const client = scripted([
      [bookcase],
      [call("p1", "submit_plan", plan([{ ...gap, expected_mm: 320 }, { ...inside, expected_mm: 564 }]))],
      [{ type: "text", text: "That was the pitch. I'll fix the label." }],
    ]);
    await turn(client).run({ text: "A bookcase with three shelves", selection: [] });

    expect(resultOf(client, 2, "p1")).toMatchObject({
      is_error: true,
      content: [
        "The plan wasn't pinned. 1 of 2 key sizes doesn't match the model:",
        "- Clear gap between shelves: shelf#2.bottom - shelf.top gives 302 mm on the model (shelf#2.bottom (420) - shelf.top (118)), but expected_mm is 320 (± 0.5).",
        "Fix expected_mm, the label or the model for each one, so every label says what its expression measures, such as a clear gap or a pitch. Then call submit_plan again with the whole plan.",
      ].join("\n"),
    });
    expect(store.project.design.plan).toBeUndefined();
    expect(store.project.pending).toBeNull();
    expect(store.project.chat.some((c) => c.kind === "plan")).toBe(false);
    expect(store.project.chat.find((c) => c.kind === "tool" && c.name === "submit_plan")).toMatchObject({
      is_error: true,
      summary: "submit a plan: 1 of 2 key sizes doesn't match the model: Clear gap between shelves. The plan wasn't pinned",
    });
  });

  it("refuse a plan whose expression can't be worked out", async () => {
    const client = scripted([
      [bookcase],
      [
        call(
          "p1",
          "submit_plan",
          plan([
            { label: "Top to the top shelf", expr: "top.bottom - shelf#3.top", expected_mm: 160 },
            { label: "Shelves fit", expr: "shelf#3.top < 900", expected_mm: 1 },
            { ...pitch, expected_mm: 320 },
          ]),
        ),
        call("p2", "submit_plan", { ...plan([]), key_dims: "320 mm pitch" }),
      ],
      [{ type: "text", text: "There's no top yet." }],
    ]);
    await turn(client).run({ text: "A bookcase with three shelves", selection: [] });

    expect(resultOf(client, 2, "p1")).toMatchObject({
      is_error: true,
      content: [
        "The plan wasn't pinned. 2 of 3 key sizes don't match the model:",
        '- Top to the top shelf: can\'t work out top.bottom - shelf#3.top: Unknown part "top". Parts: left, right, shelf.',
        "- Shelves fit: shelf#3.top < 900 gives true/false, not a size.",
        "Fix expected_mm, the label or the model for each one, so every label says what its expression measures, such as a clear gap or a pitch. Then call submit_plan again with the whole plan.",
      ].join("\n"),
    });
    expect(resultOf(client, 2, "p2")).toMatchObject({ is_error: true, content: "key_dims must be a list of { label, expr, expected_mm }" });
    expect(store.project.design.plan).toBeUndefined();
    expect(store.project.chat.some((c) => c.kind === "plan")).toBe(false);
  });

  it("are explained to Claude: checked against the model, and labelled with what they measure", () => {
    const tool = TOOLS.find((t) => t.name === "submit_plan")!;
    expect(tool.description).toContain("If one doesn't match its expected_mm or can't be worked out, the plan is refused and nothing is pinned.");
    const dims = (tool.input_schema.properties as Record<string, { items: { properties: Record<string, { description?: string }> } }>).key_dims!;
    expect(dims.items.properties.label!.description).toMatch(/clear gap between two shelves or the pitch/);
    expect(SYSTEM_PROMPT).toContain(
      "The app checks each key size against the model and refuses a plan with a mismatch, so label each one with what its expression measures, such as a clear gap or a pitch.",
    );
  });
});
