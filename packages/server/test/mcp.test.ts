// The Woodchuck MCP server's words: what it tells another chat about the
// design and about what Woodchuck's Claude said and did. mcp-tools.test.ts
// calls the tools themselves against a running app.

import { describe as group, expect, it } from "vitest";
import { applyOps, emptyDesign, recordConsoleOps } from "@woodchuck/core";
import { colourCards, describe, designText, itemsAfter, summarise, type AppState } from "../src/mcp.js";

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
