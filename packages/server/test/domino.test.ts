// Issue #63: Claude joins a carcass with Dominos through add_joint, and the
// bought tenons reach the hardware list as library parts. A scripted Claude
// reads the joint library, opens the Domino's worked example, builds an
// invented bedside carcass in 18 mm ply (450 wide, 500 tall, 300 deep) in
// two lists of edits, reads the cut list, and hears why a Domino Festool
// doesn't make is refused. The library's Domino files are held to the sizes
// the joint uses. Issue #89: add_joint's loose puts the play in the guest's
// mortises, and the host's are cut tight.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DOMINO_SIZES, derive, validateLibraryPart } from "@woodchuck/core";
import { Turn, type MessagesClient } from "../src/agent.js";
import { scriptedClient } from "../src/scripted.js";
import { Store } from "../src/store.js";
import { TOOLS } from "../src/tools.js";

type Block = Record<string, unknown>;

const call = (id: string, name: string, input: Block): Block => ({ type: "tool_use", id, name, input });

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "woodchuck-domino-"));
  store = new Store(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function turn(client: MessagesClient) {
  return new Turn(store, client, { chat() {}, delta() {}, changed() {} }, () => Buffer.from("png"));
}

const results = (client: ReturnType<typeof scriptedClient>, n: number) => client.sent[n]!.messages.at(-1)!.content as unknown as Block[];
const resultOf = (client: ReturnType<typeof scriptedClient>, n: number, id: string) => results(client, n).find((b) => b.tool_use_id === id)!;

const panel = (id: string, name: string, thickness_axis: string, grain_axis: string, x: Block, y: Block, z: Block): Block => ({
  op: "add_panel",
  id,
  name,
  material: "ply18",
  thickness_axis,
  grain_axis,
  x,
  y,
  z,
});

const panels: Block[] = [
  { op: "define_material", id: "ply18", name: "18 mm birch ply", kind: "sheet", thickness_mm: 18, grained: true },
  panel("top", "Top", "y", "x", { start: { at: "0" }, size: "450" }, { start: { at: "500" } }, { start: { at: "0" }, size: "300" }),
  panel("side_l", "Side", "x", "y", { start: { at: "0" } }, { start: { at: "0" }, end: { face: "top.bottom" } }, { start: { at: "0" }, size: "300" }),
  panel("side_r", "Side", "x", "y", { end: { at: "450" } }, { start: { at: "0" }, end: { face: "top.bottom" } }, { start: { at: "0" }, size: "300" }),
  panel("bottom", "Bottom", "y", "x", { start: { face: "side_l.right" }, end: { face: "side_r.left" } }, { start: { at: "60" } }, { start: { at: "0" }, size: "300" }),
];

const joints: Block[] = [
  { op: "add_joint", id: "top_l", type: "domino", host: "top", guest: "side_l", note: "Lines the top up with the side" },
  { op: "add_joint", id: "top_r", type: "domino", host: "top", guest: "side_r" },
  { op: "add_joint", id: "bottom_l", type: "domino", host: "side_l", guest: "bottom", thickness: "5", count: 4 },
  { op: "add_joint", id: "bottom_r", type: "domino", host: "side_r", guest: "bottom", thickness: "5", count: 4 },
];

type Entry = { type: string; name: string; summary: string; use_when: string; tools: string[]; changes_sizes: string; params: { name: string; default: string }[]; loose?: string };

describe("Claude's Dominos", () => {
  it("are in add_joint, with when to use them", () => {
    const addJoint = TOOLS.find((t) => t.name === "add_joint")!;
    const props = addJoint.input_schema.properties as Record<string, { enum?: string[]; description?: string }>;
    expect(props.type!.enum).toContain("domino");
    expect(props.type!.description).toContain("Use it only when the woodworker's workshop lists a Domino joiner, and dowels when it doesn't");
    expect(props.thickness!.description).toContain("A Domino's is its cutter: 4, 5, 6, 8 or 10");
    expect(props.length!.description).toContain("Dominos are 4 × 20, 5 × 30, 6 × 40, 8 × 40, 8 × 50 and 10 × 50 mm");
    expect(props.fit!.description).toContain("the joiner's width setting for the loose piece's mortises: 6 or 10 leaves play along the joint there, 6 when left out, and 0 cuts both pieces tight");
    expect(props.count!.description).toBe("Number of screws, pocket screws, dowels or Dominos");
    expect(props.loose!.enum).toEqual(["host", "guest"]);
    expect(props.loose!.description).toMatch(/^Domino only: which piece gets the loose mortises/);
    expect(props.loose!.description).toContain("The host when left out. To change it on a joint, delete_joint it and add it again");
  });

  it("join a carcass, and put the tenons on the hardware list, as one undo", async () => {
    const client = scriptedClient([
      [call("l1", "list_joints", {}), call("s1", "show_joint", { type: "domino", note: "Quick to line up, and your workshop has a Domino" })],
      [call("a1", "apply_edits", { edits: panels }), call("a2", "apply_edits", { edits: joints })],
      [call("c1", "get_cut_list", {}), call("j1", "add_joint", { id: "back_l", type: "domino", host: "side_l", guest: "bottom", thickness: "5", length: "40" })],
      [{ type: "text", text: "Carcass joined with Dominos." }],
    ]);
    await turn(client).run({ text: "Join the carcass with my Domino", selection: [] });

    // The library offers the Domino as a loose tenon, so a request for add_loose_tenon finds it.
    const library = JSON.parse(String(resultOf(client, 1, "l1").content)) as Entry[];
    const domino = library.find((e) => e.type === "domino")!;
    expect(domino.name).toBe("Domino (loose tenon)");
    expect(domino.tools).toEqual(["Festool Domino joiner (DF 500)"]);
    expect(domino.use_when).toContain("when the woodworker's workshop lists a Festool Domino joiner");
    expect(domino.use_when).toContain("Without a Domino, use dowels.");
    expect(domino.changes_sizes).toBe("None. Cuts matching mortises in both parts, and lists the tenons as hardware to buy.");
    expect(domino.params.map((p) => p.name)).toEqual(["count", "thickness", "length", "depth", "fit"]);
    expect(domino.params.find((p) => p.name === "fit")).toMatchObject({ default: "6" });
    expect(domino.loose).toMatch(/^Give loose, "host" or "guest", for the piece whose mortises take the fit as play\. It's the host when left out\./);
    expect(library.filter((e) => e.loose).map((e) => e.type)).toEqual(["domino"]);
    expect(store.project.chat.find((c) => c.kind === "example")).toMatchObject({ joint: "domino" });

    // The joints stage leaves no problem and changes no size.
    const built = JSON.parse(String(resultOf(client, 2, "a2").content)) as { ok: boolean; problems: { errors: number; warnings: number } };
    expect(built.ok).toBe(true);
    expect(built.problems).toMatchObject({ errors: 0, warnings: 0 });
    const d = derive(store.project.design);
    expect(d.byId.get("bottom")!.cut).toEqual({ length: 414, width: 300, thickness: 18 });
    expect(d.byId.get("side_l")!.machining.map((m) => [m.joint, m.label, m.depth_mm, m.length_mm])).toEqual([
      ["top_l", "domino mortise", 28, 19.8],
      ["top_l", "domino mortise", 28, 19.8],
      ["top_l", "domino mortise", 28, 19.8],
      ["bottom_l", "domino mortise", 12, 24.8],
      ["bottom_l", "domino mortise", 12, 24.8],
      ["bottom_l", "domino mortise", 12, 24.8],
      ["bottom_l", "domino mortise", 12, 24.8],
    ]);

    // The cut list buys each size as its library part, counted from the joints.
    const list = JSON.parse(String(resultOf(client, 3, "c1").content)) as { hardware: Block[] };
    expect(list.hardware.map((h) => [h.name, h.qty, h.library_part])).toEqual([
      ["Festool DOMINO tenon, beech, 6 × 40 mm", 6, "festool-domino-beech-6x40"],
      ["Festool DOMINO tenon, beech, 5 × 30 mm", 8, "festool-domino-beech-5x30"],
    ]);

    // A Domino Festool doesn't make is refused, in words that list the ones it does.
    const refused = resultOf(client, 3, "j1");
    expect(refused.is_error).toBe(true);
    expect(String(refused.content)).toContain(
      "There's no Domino 5 mm thick and 40 mm long for the DF 500. Its beech tenons are 4 × 20, 5 × 30, 6 × 40, 8 × 40, 8 × 50 and 10 × 50 mm, thickness by length",
    );

    expect(store.project.history).toHaveLength(1);
    store.project.undo();
    expect(store.project.design.joints).toEqual([]);
  });

  it("put the play in the guest when add_joint says so, and refuse loose anywhere else", async () => {
    const client = scriptedClient([
      [call("a1", "apply_edits", { edits: [...panels, { op: "add_joint", id: "top_r", type: "domino", host: "top", guest: "side_r", loose: "guest" }] })],
      [
        call("j1", "add_joint", { id: "top_l", type: "domino", host: "top", guest: "side_l", loose: "guest" }),
        call("j2", "add_joint", { id: "bottom_l", type: "dowels", host: "side_l", guest: "bottom", loose: "guest" }),
        call("j3", "add_joint", { id: "bottom_r", type: "domino", host: "side_r", guest: "bottom", loose: "side_r" }),
        call("j4", "add_joint", { id: "top_l", type: "domino", host: "top", guest: "side_l" }),
      ],
      [{ type: "text", text: "The sides take the play." }],
    ]);
    await turn(client).run({ text: "Put the Domino play in the sides", selection: [] });

    expect(JSON.parse(String(resultOf(client, 1, "a1").content))).toMatchObject({ ok: true });
    expect(resultOf(client, 2, "j1").is_error).toBeFalsy();
    const refusal = (id: string) => {
      const r = resultOf(client, 2, id);
      expect(r.is_error).toBe(true);
      return String(r.content);
    };
    expect(refusal("j2")).toContain("loose only applies to domino joints, not dowels");
    expect(refusal("j3")).toContain('loose names the piece whose Domino mortises get the play, "host" or "guest", not "side_r"');
    expect(refusal("j4")).toMatch(/Joint "top_l" already exists, and this one differs in loose\. .* To change it, delete_joint it and add it again/);

    expect(store.project.design.joints.map((j) => [j.id, j.loose])).toEqual([
      ["top_r", "guest"],
      ["top_l", "guest"],
    ]);
    // The top's mortises are tight, and each side's are 6 mm longer than the tenon is wide.
    const d = derive(store.project.design);
    const mortises = (part: string) => d.byId.get(part)!.machining.map((m) => [m.joint, m.length_mm, m.play_mm ?? 0]);
    expect(mortises("top")).toEqual([...Array(3).fill(["top_r", 19.8, 0]), ...Array(3).fill(["top_l", 19.8, 0])]);
    expect(mortises("side_l")).toEqual(Array(3).fill(["top_l", 25.8, 6]));
    expect(mortises("side_r")).toEqual(Array(3).fill(["top_r", 25.8, 6]));
  });
});

describe("the library's Domino tenons", () => {
  it("match the sizes the joint lists, with Festool's figures and sources", () => {
    const folder = path.resolve(__dirname, "../../../library/parts");
    for (const s of DOMINO_SIZES) {
      const part = validateLibraryPart(JSON.parse(readFileSync(path.join(folder, `${s.library_part}.json`), "utf8")));
      expect(part).toMatchObject({ id: s.library_part, name: s.name, kind: "fixing", maker: "Festool" });
      expect(part.specs).toMatchObject({ thickness_mm: s.thickness_mm, width_mm: s.width_mm, length_mm: s.length_mm, cutter_mm: s.thickness_mm });
      expect(part.shape).toEqual([{ name: "tenon", min_mm: [0, 0, 0], max_mm: [s.length_mm, s.width_mm, s.thickness_mm] }]);
      expect(part.sources.map((x) => new URL(x.url!).hostname)).toEqual(["www.festool.com", "www.festool.com", "www.festoolusa.com"]);
    }
  });
});
