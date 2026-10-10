// The Woodchuck MCP server's words: what it tells another chat about the
// design and about what Woodchuck's Claude said and did. mcp-tools.test.ts
// calls the tools themselves against a running app.

import { describe as group, expect, it } from "vitest";
import { applyOps, emptyDesign, recordConsoleOps } from "@woodchuck/core";
import { colourCards, describe, designText, itemsAfter, readText, READ_PARTS, summarise, type AppState } from "../src/mcp.js";

group("the Woodchuck MCP server", () => {
  const chat = [
    { id: "u1", kind: "user", text: "Try Wien posts" },
    { id: "t1", kind: "tool", name: "set_finish" },
    { id: "t2", kind: "tool", name: "check_design" },
    { id: "v1", kind: "preview", title: "Dark posts", explanation: "Posts in Wien.", status: "proposed" },
    { id: "a1", kind: "assistant", text: "Here's a darker scheme." },
  ];

  it("reports only what came after your message", () => {
    expect(itemsAfter(chat, "u1").map((c) => c.id)).toEqual(["t1", "t2", "v1", "a1"]);
    expect(itemsAfter(chat, "gone")).toHaveLength(5);
  });

  it("says what Claude said and that a preview is waiting", () => {
    const text = describe(itemsAfter(chat, "u1"), false);
    expect(text).toContain("Here's a darker scheme.");
    expect(text).toContain('showing a preview, "Dark posts"');
    expect(text).toContain("woodchuck_preview");
    expect(text).toContain("drawn on the model in the Woodchuck window");
    expect(text).toContain("It used 2 tools.");
    expect(describe([], true)).toContain("still working. Call woodchuck_reply for the rest once it's done.");
    // A message sent mid-build isn't something Claude said.
    expect(describe([{ id: "u2", kind: "user", text: "Make it oak", during: true }], false)).toBe("Woodchuck's Claude didn't say anything.");
  });

  it("sums up the design's timber and finishes", () => {
    const design = applyOps(applyOps(emptyDesign("t"), recordConsoleOps()), [
      { op: "set_finish", targets: ["material:front_18"], finish: "wien" },
      { op: "set_finish", targets: ["top"], finish: "3044" },
    ]);
    const s: AppState = {
      busy: false,
      waiting: ["preview"],
      design,
      project: { slug: "console", name: "Record console" },
      report: { errors: 1, warnings: 0, ready_to_cut: false },
      chat: [],
    };
    const text = summarise(s);
    expect(text).toContain("Design: Record console");
    expect(text).toContain("1 errors and 0 warnings");
    expect(text).toMatch(/18 mm drawer-front panel \(front_18\): Birch plywood, 1 Wien/);
    expect(text).toContain("- Osmo 3044 Raw: top");
    expect(text).toContain("waiting for an answer to a preview");
    // Issue #66: the joints' ids, for pulling one apart in the window.
    expect(text).toMatch(/^Joints, by id: bottom_in_left, bottom_in_right, .*front_to_box$/m);
  });

  it("caps each list in the design's lines, with how many more there are", () => {
    const ops = Array.from({ length: 30 }, (_, i) => ({ op: "set_param" as const, name: `shelf_${i + 1}`, expr: String(200 + i), unit: "mm" as const }));
    const s: AppState = {
      busy: false,
      waiting: ["question"],
      design: applyOps(emptyDesign("Shelf wall"), ops),
      project: { slug: "shelves", name: "Shelf wall" },
      report: { errors: 0, warnings: 0, ready_to_cut: false },
      chat: [],
    };
    const lines = designText(s).split("\n");
    expect(lines).toContain("Woodchuck's Claude is waiting for an answer to a question.");
    expect(lines).toContain("It has no parts yet.");
    expect(lines).toContain("- shelf_19 = 218 mm");
    expect(lines).not.toContain("- shelf_20 = 219 mm");
    expect(lines).toContain("- and 11 more");
  });

  it("lists both colour cards by number and name", () => {
    const cards = colourCards();
    expect(cards).toContain("- 13 Amsterdam #2b3a3a");
    expect(cards).toContain("- 3044 Raw: Keeps pale timber looking bare, with a matt sheen");
    expect(cards).toMatch(/Osmo Polyx-Oil \(modelled/);
  });
});

group("woodchuck_read's words", () => {
  const s: AppState = {
    busy: false,
    waiting: [],
    design: applyOps(emptyDesign("t"), recordConsoleOps()),
    project: { slug: "console", name: "Record console" },
    report: { errors: 1, warnings: 0, ready_to_cut: false },
    chat: [],
  };
  const lines = (what: (typeof READ_PARTS)[number], part?: string) => readText(s, what, part).split("\n");

  it("reads a part's sheet as the drawing says it, with the sides it's measured from", () => {
    // Issue #81: another chat asked which face a cut was in, and could only guess.
    expect(lines("parts", "right_side")).toEqual([
      "The part sheets in Record console's workshop drawings:",
      "",
      "Sheet 4, part 3: Right side. Make 1 (right_side).",
      "Cut to 400 long × 520 wide × 30 thick, 30 mm carcass panel, grain along the length.",
      "Views: left face, front edge and top end.",
      "1. rabbet 30 wide × 10 deep × 520 long in the left face for bottom. At 0 to 30 along, 0 to 520 up.",
      "2. groove 9 wide × 10 deep × 370 long in the left face for back. At 30 to 400 along, 511 to 520 up.",
      "Along is from the bottom end, up from the front edge and in from the left face.",
    ]);
    // Every part, by its sheet, with one that has nothing to cut saying so.
    const all = lines("parts");
    expect(all.filter((l) => l.startsWith("Sheet "))).toHaveLength(12);
    expect(all).toContain("Sheet 5, part 4: Partition. Make 4 (partition, partition#2, partition#3, partition#4).");
    expect(all).toContain("No machining. Cut it to size.");
  });

  it("narrows to a part by its id, an array copy, its row number or its name", () => {
    expect(readText(s, "parts", "3")).toBe(readText(s, "parts", "right_side"));
    expect(readText(s, "parts", "Right side")).toBe(readText(s, "parts", "right_side"));
    expect(readText(s, "parts", "partition#3")).toContain("Sheet 5, part 4: Partition.");
    expect(lines("joints", "3")).toEqual([
      "Record console's joints, by id:",
      "- bottom_in_right: rabbet, bottom into right_side; depth 10, fit 0, with fit from the library.",
      "- back_in_right: groove, back into right_side; depth 10, fit 0, with fit from the library.",
      "- top_to_right: screws, right_side into top; diameter 4, length 55, count 3, with diameter and length from the library.",
    ]);
    expect(readText(s, "parts", "shelf")).toMatch(/^There's no part "shelf" in Record console\. Parts, by id: left_side, right_side, bottom, /);
    expect(readText(s, "drilling", "right_side")).toBe("right_side has no holes to drill.");
  });

  it("reads the cut list, the cutting plan, the drilling and hardware lists, every check and the file", () => {
    const cut = lines("cut_list");
    expect(cut[0]).toContain("A cut's (x, y, z) is its corner nearest the part's left, bottom and back");
    expect(cut).toContain("3. Right side ×1: 400 × 520 × 30, 30 mm carcass panel, grain along the length. Parts: right_side.");
    expect(cut).toContain("  - groove 9 wide × 10 deep × 370 long in the left face for back at (0,30,0)");
    expect(lines("cutting_plan").slice(0, 2)).toEqual(["Record console's cutting plan:", "Saw kerf 3 mm, sheet trim 10 mm. Parts are named by cut-list row."]);
    expect(lines("drilling")).toContain(
      "- 12. Top ×1: 3 screw holes each for left_side, Ø4, right through, in the top face. Centres: 15 along, 86.7 up; 15 along, 260 up; 15 along, 433.3 up.",
    );
    expect(lines("hardware")[1]).toMatch(/^- Side-mount slide pair, 450 mm: 5/);
    expect(lines("checks")).toEqual([
      "Checks for Record console: 1 error and no warnings, not ready to cut yet:",
      "- Error: 12-inch LPs need at least lp_clear inside each drawer (rule lp_fit)",
    ]);
    const file = lines("file");
    expect(file[0]).toBe("Record console's file, as JSON:");
    expect(JSON.parse(file[1]!)).toEqual(s.design);
  });
});
