// Issue #78: the Cut layout tab cuts from the boards and sheets you own
// first, says what's left to buy, rips narrow parts from the widths the
// yard sells, and prints a cutting plan. The fixture is an invented potting
// bench for Alex in Fairhaven: 21 mm pine slats and rails, and a 12 mm ply
// shelf. Every size is made up.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { applyOps, cutLayout, cutList, derive, emptyDesign, type Design, type Op, type OwnedStock } from "@woodchuck/core";
import type { ServerState } from "../src/api.js";
import { boardDepthPx, CutLayoutPanel, labelTries } from "../src/components/CutLayout.js";
import {
  addOwned,
  cuttingPlanUrl,
  EMPTY_ROW,
  lengthsLabel,
  nothingToBuy,
  ownedLabel,
  ownedText,
  parseOwnedRow,
  parseSizes,
  removeOwned,
  stockCount,
  widthsLabel,
} from "../src/stockEditor.js";

const part = (id: string, name: string, material: string, length: number, width: number, at: number): Op => ({
  op: "add_panel",
  id,
  name,
  material,
  thickness_axis: "z",
  grain_axis: "x",
  x: { start: { at: String(at) }, size: String(length) },
  y: { start: { at: "0" }, size: String(width) },
  z: { start: { at: "0" } },
});

const bench = (...extra: Op[]): Design =>
  applyOps(emptyDesign("Potting bench"), [
    { op: "define_material", id: "pine", name: "21 mm pine", kind: "solid", thickness_mm: 21, grained: true },
    { op: "define_material", id: "ply", name: "12 mm ply", kind: "sheet", thickness_mm: 12, grained: true },
    ...[1, 2, 3, 4].map((k) => part(`slat_${k}`, "Slat", "pine", 700, 40, 1000 * k)),
    ...[1, 2].map((k) => part(`rail_${k}`, "Rail", "pine", 500, 66, 10000 + 1000 * k)),
    part("shelf", "Shelf", "ply", 600, 350, 20000),
    ...extra,
  ]);

const own = (material: string, owned: OwnedStock[]): Op => ({ op: "set_stock", material, owned });
const layoutOf = (d: Design) => cutLayout(d, cutList(d, derive(d)));

/** The panel as the page would draw it, without a browser. */
function render(d: Design): string {
  const derived = derive(d);
  const state = { design: d, derived, cutlist: cutList(d, derived) } as unknown as ServerState;
  return renderToStaticMarkup(createElement(CutLayoutPanel, { state, onSelect: () => {} }));
}

describe("the sizes typed into Lengths and Widths sold", () => {
  it("reads commas or spaces, smallest first, each once, with a stray mm", () => {
    expect(parseSizes("90, 42 66")).toEqual({ kind: "sizes", sizes_mm: [42, 66, 90] });
    expect(parseSizes("2400mm, 2400, 3000 mm")).toEqual({ kind: "sizes", sizes_mm: [2400, 3000] });
  });

  it("is empty when the box is, and bad for anything that isn't a size above 0", () => {
    expect(parseSizes("  ")).toEqual({ kind: "empty" });
    expect(parseSizes(", ,")).toEqual({ kind: "empty" });
    for (const t of ["90, wide", "0", "-42", "4x2"]) expect(parseSizes(t), t).toEqual({ kind: "bad" });
  });

  it("says each change in plain words to undo it by", () => {
    expect(lengthsLabel("21 mm pine", [2400, 3000])).toBe("Set 21 mm pine to 2400, 3000 mm lengths");
    expect(lengthsLabel("21 mm pine", null)).toBe("Set 21 mm pine back to the usual lengths");
    expect(widthsLabel("21 mm pine", [42, 66, 90])).toBe("Set 21 mm pine to 42, 66, 90 mm widths");
    expect(widthsLabel("21 mm pine", null)).toBe("Set 21 mm pine back to each part's own width");
  });
});

describe("the Your stock editor", () => {
  it("turns the add row into a size you own, one when the count is empty", () => {
    expect(parseOwnedRow({ length: "1500", width: "90", qty: "3" }, "solid")).toEqual({ length_mm: 1500, width_mm: 90, qty: 3 });
    expect(parseOwnedRow({ length: " 1200 mm", width: "600", qty: "" }, "sheet")).toEqual({ length_mm: 1200, width_mm: 600, qty: 1 });
    expect(parseOwnedRow(EMPTY_ROW, "solid")).toEqual({ error: "Give the length and width in mm, such as 2400 × 90" });
  });

  it("says what's wrong with a row it can't use", () => {
    expect(parseOwnedRow({ length: "1500", width: "", qty: "1" }, "sheet")).toEqual({ error: "Give the length and width in mm, such as 2400 × 1200" });
    expect(parseOwnedRow({ length: "1500", width: "-90", qty: "1" }, "solid")).toHaveProperty("error");
    for (const qty of ["0", "1.5", "201", "two"]) {
      expect(parseOwnedRow({ length: "1500", width: "90", qty }, "solid"), qty).toEqual({ error: "The number of boards is a whole number from 1 to 200" });
    }
  });

  it("adds a size you already have to its count, and keeps the longest first", () => {
    const had: OwnedStock[] = [{ length_mm: 1500, width_mm: 90, qty: 2 }];
    expect(addOwned(had, { length_mm: 1500, width_mm: 90, qty: 1 })).toEqual([{ length_mm: 1500, width_mm: 90, qty: 3 }]);
    expect(addOwned(had, { length_mm: 2100, width_mm: 66, qty: 1 })).toEqual([
      { length_mm: 2100, width_mm: 66, qty: 1 },
      { length_mm: 1500, width_mm: 90, qty: 2 },
    ]);
    // The list it was given stays as it was, since it's the design's.
    expect(had).toEqual([{ length_mm: 1500, width_mm: 90, qty: 2 }]);
  });

  it("removes one size by its row", () => {
    const had: OwnedStock[] = [
      { length_mm: 2100, width_mm: 66, qty: 1 },
      { length_mm: 1500, width_mm: 90, qty: 2 },
    ];
    expect(removeOwned(had, 0)).toEqual([{ length_mm: 1500, width_mm: 90, qty: 2 }]);
    expect(removeOwned(removeOwned(had, 0), 0)).toEqual([]);
  });

  it("names each row and each change in boards or sheets", () => {
    expect(ownedText({ length_mm: 1500, width_mm: 90, qty: 3 }, "solid")).toBe("1500 × 90 mm, 3 boards");
    expect(ownedText({ length_mm: 1200, width_mm: 600, qty: 1 }, "sheet")).toBe("1200 × 600 mm, 1 sheet");
    const two: OwnedStock[] = [
      { length_mm: 2100, width_mm: 66, qty: 1 },
      { length_mm: 1500, width_mm: 90, qty: 2 },
    ];
    expect(ownedLabel("21 mm pine", "solid", two)).toBe("Set your own 21 mm pine to 3 boards");
    expect(ownedLabel("12 mm ply", "sheet", [{ length_mm: 1200, width_mm: 600, qty: 1 }])).toBe("Set your own 12 mm ply to 1 sheet");
    expect(ownedLabel("21 mm pine", "solid", [])).toBe("Cleared your own stock of 21 mm pine");
  });
});

describe("what the panel says about the stock", () => {
  it("counts the sheets or lengths, and how many are yours", () => {
    expect(stockCount("solid", [{}, {}])).toBe("2 lengths");
    expect(stockCount("solid", [{ owned: true }, {}, {}])).toBe("3 lengths, 1 of them yours");
    expect(stockCount("sheet", [{ owned: true }])).toBe("1 sheet, yours");
    expect(stockCount("sheet", [{ owned: true }, { owned: true }])).toBe("2 sheets, all yours");
  });

  it("says your own stock covers it only when nothing is left off", () => {
    const covered = layoutOf(bench(own("pine", [{ length_mm: 1500, width_mm: 90, qty: 2 }]), own("ply", [{ length_mm: 1200, width_mm: 600, qty: 1 }])));
    expect(covered.buy).toEqual([]);
    expect(nothingToBuy(covered)).toBe("Nothing to buy: your own stock covers it.");
    const tooBig = layoutOf(bench(own("pine", [{ length_mm: 1500, width_mm: 90, qty: 2 }]), own("ply", [{ length_mm: 1200, width_mm: 600, qty: 1 }]), part("top", "Top", "ply", 3000, 500, 30000)));
    expect(tooBig.buy).toEqual([]);
    expect(nothingToBuy(tooBig)).toBe("Nothing to buy.");
    expect(nothingToBuy({ from_stock: [], materials: [] })).toBe("Nothing fits the stock yet.");
  });

  it("prints the cutting plan alone, on the paper asked for", () => {
    expect(cuttingPlanUrl("A4")).toBe("/api/cutting-plan.pdf?paper=A4");
    expect(cuttingPlanUrl("A3")).toBe("/api/cutting-plan.pdf?paper=A3");
  });
});

describe("the drawings of a ripped board", () => {
  it("tries the rip before the size alone, then the name, then the row", () => {
    expect(labelTries("Slat", ["700, rip 40", "700"], 3)).toEqual([["Slat", "700, rip 40"], ["Slat 700, rip 40"], ["Slat", "700"], ["Slat 700"], ["Slat"], ["#3"]]);
    expect(labelTries("Back rail", ["500"], 2)).toEqual([["Back rail", "500"], ["Back rail 500"], ["Back", "rail", "500"], ["Back rail"], ["Back", "rail"], ["#2"]]);
  });

  it("draws a board at the usual depth until it's ripped into narrow strips, and never past three times that", () => {
    expect(boardDepthPx(90, [90])).toBe(34);
    expect(boardDepthPx(90, [66])).toBe(34);
    expect(boardDepthPx(90, [40, 40])).toBe(54);
    expect(boardDepthPx(140, [20])).toBe(102);
    // A board with nothing on it yet keeps the usual depth.
    expect(boardDepthPx(90, [])).toBe(34);
  });
});

describe("the Cut layout tab", () => {
  const page = render(bench(own("pine", [{ length_mm: 1500, width_mm: 90, qty: 3 }])));

  it("opens the cutting plan to print in a new tab", () => {
    expect(page).toContain('href="/api/cutting-plan.pdf?paper=A4" target="_blank"');
    expect(page).toContain("Print cutting plan");
    expect(page).toContain("Every board and sheet to cut, your own first and then what to buy");
  });

  it("lists what comes from your stock and what's left to buy", () => {
    expect(page).toContain("From your stock");
    expect(page).toContain("2 of your 90 × 21 pine boards at 1500");
    expect(page).toContain("To buy");
    expect(page).toContain("1 sheet of 12 mm ply 2400 × 1200");
  });

  it("letters each board, tags yours, and says the rip on a ripped part", () => {
    expect(page).toContain("<strong>Length A</strong>");
    expect(page).toContain('<span class="badge yours">yours</span>');
    expect(page).toContain("<strong>Sheet C</strong>");
    expect(page).toContain(">700, rip 40</text>");
    expect(page).toContain("ripped from a 90 mm board");
  });

  it("edits your stock, and says what isn't needed", () => {
    expect(page).toContain("Your stock");
    expect(page).toContain("1500 × 90 mm, 3 boards");
    expect(page).toContain('aria-label="Remove 1500 × 90 mm, 3 boards"');
    expect(page).toContain('aria-label="Length of the boards to add, in mm"');
    expect(page).toContain('aria-label="Length of the sheets to add, in mm"');
    expect(page).toContain("Not needed: 1 of your 90 × 21 pine board at 1500.");
  });

  it("offers the widths sold for solid timber only", () => {
    expect(page.match(/aria-label="Board widths sold, in mm"/g)).toHaveLength(1);
    expect(page).toContain('placeholder="Each part&#x27;s own width"');
    expect(page).toContain("Narrower parts are ripped from the narrowest width that holds them.");
  });

  it("says your own stock covers it when nothing's left to buy", () => {
    const covered = render(bench(own("pine", [{ length_mm: 1500, width_mm: 90, qty: 2 }]), own("ply", [{ length_mm: 1200, width_mm: 600, qty: 1 }])));
    expect(covered).toContain("Nothing to buy: your own stock covers it.");
    expect(covered).toContain("1 sheet, yours");
  });
});
