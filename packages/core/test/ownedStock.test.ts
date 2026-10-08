// Issue #78: the stock you already own is cut first, and only the
// shortfall is bought. A part narrower than a board is ripped from it, two
// side by side when they fit, and a material can name the widths the yard
// sells. The fixture is an invented hall stand for Mateo in Cedar Hollow:
// 21 mm pine stiles and rails, and an 18 mm ply back. Every size is made up.

import { describe, expect, it } from "vitest";
import {
  applyOp,
  applyOps,
  boardsOfRow,
  cutLayout,
  cutList,
  cuttingPlan,
  cuttingPlanText,
  derive,
  diffDesigns,
  emptyDesign,
  ripped,
  rowBoards,
  sheetSvg,
  stockLabel,
  workshopDrawings,
  type CutLayout,
  type Design,
  type Op,
  type OwnedStock,
  type Sheet,
} from "../src/index.js";

const part = (id: string, material: string, length: number, width: number, at: number): Op => ({
  op: "add_panel",
  id,
  name: id.replace(/_\d+$/, "").replace(/_/g, " "),
  material,
  thickness_axis: "z",
  grain_axis: "x",
  x: { start: { at: String(at) }, size: String(length) },
  y: { start: { at: "0" }, size: String(width) },
  z: { start: { at: "0" } },
});

const stand = (...extra: Op[]): Design =>
  applyOps(emptyDesign("Hall stand"), [
    { op: "define_material", id: "pine", name: "21 mm pine", kind: "solid", thickness_mm: 21, grained: true },
    { op: "define_material", id: "ply", name: "18 mm birch ply", kind: "sheet", thickness_mm: 18, grained: true },
    ...[1, 2, 3, 4].map((k) => part(`stile_${k}`, "pine", 600, 44, 1000 * k)),
    ...[1, 2].map((k) => part(`rail_${k}`, "pine", 400, 44, 10000 + 1000 * k)),
    part("back", "ply", 560, 380, 20000),
    ...extra,
  ]);
const own = (material: string, owned: OwnedStock[]): Op => ({ op: "set_stock", material, owned });
const layoutOf = (d: Design): CutLayout => cutLayout(d, cutList(d, derive(d)));
const pine = (l: CutLayout) => l.materials.find((m) => m.material === "pine")!;

describe("the stock you already own", () => {
  it("cuts from your boards first, ripping two narrow parts side by side, and buys nothing more", () => {
    const l = layoutOf(stand(own("pine", [{ length_mm: 1800, width_mm: 92, qty: 1 }])));
    const m = pine(l);
    expect(m.buy).toEqual([]);
    expect(m.from_stock.map((b) => b.text)).toEqual(["1 of your 92 × 21 pine board at 1800"]);
    const [board] = m.stock;
    expect(board).toMatchObject({ label: "A", owned: true, length_mm: 1800, width_mm: 92 });
    expect(board!.parts).toHaveLength(6);
    expect(board!.parts.every((p) => ripped(board!, p, "solid"))).toBe(true);
    // Two strips: the stiles and rails sit in two rows across the board, a kerf apart.
    expect(new Set(board!.parts.map((p) => p.y_mm))).toEqual(new Set([0, 47]));
    // In cutting order, along the board.
    const xs = board!.parts.map((p) => p.x_mm);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
  });

  it("buys only the shortfall, at each part's width when the material names no widths", () => {
    const l = layoutOf(stand(own("pine", [{ length_mm: 1300, width_mm: 92, qty: 1 }])));
    const m = pine(l);
    expect(m.stock.filter((s) => s.owned)).toHaveLength(1);
    expect(m.from_stock.map((b) => b.text)).toEqual(["1 of your 92 × 21 pine board at 1300"]);
    expect(m.buy.map((b) => b.text)).toEqual(["1 length of 44 × 21 pine at 2400"]);
    const placed = m.stock.flatMap((s) => s.parts.map((p) => p.part)).sort();
    expect(placed).toEqual(["rail_1", "rail_2", "stile_1", "stile_2", "stile_3", "stile_4"]);
  });

  it("says which of your boards are left over", () => {
    const m = pine(layoutOf(stand(own("pine", [{ length_mm: 1800, width_mm: 92, qty: 3 }]))));
    expect(m.from_stock.map((b) => b.text)).toEqual(["1 of your 92 × 21 pine board at 1800"]);
    expect(m.left_in_stock.map((b) => b.text)).toEqual(["2 of your 92 × 21 pine boards at 1800"]);
  });

  it("leaves a part none of yours can hold to buy, and cuts the rest from yours", () => {
    const m = pine(layoutOf(stand(own("pine", [{ length_mm: 500, width_mm: 30, qty: 4 }]))));
    // 30 mm is narrower than every part, so nothing is cut from it.
    expect(m.from_stock).toEqual([]);
    expect(m.left_in_stock.map((b) => b.text)).toEqual(["4 of your 30 × 21 pine boards at 500"]);
    expect(m.buy.length).toBeGreaterThan(0);
  });

  it("uses your own sheets before buying one, with no trim on them", () => {
    const l = layoutOf(stand(own("ply", [{ length_mm: 600, width_mm: 400, qty: 1 }])));
    const ply = l.materials.find((m) => m.material === "ply")!;
    expect(ply.buy).toEqual([]);
    expect(ply.from_stock.map((b) => b.text)).toEqual(["1 of your 18 mm birch ply sheet 600 × 400"]);
    expect(ply.stock[0]!.parts[0]).toMatchObject({ x_mm: 0, y_mm: 0 });
  });

  it("keeps every part inside its board and a kerf from the next", () => {
    const l = layoutOf(stand(own("pine", [{ length_mm: 1800, width_mm: 92, qty: 1 }]), { op: "set_stock", kerf_mm: 4 }));
    for (const s of pine(l).stock) {
      const boxes = s.parts.map((p) => ({ x0: p.x_mm, y0: p.y_mm, x1: p.x_mm + p.length_mm, y1: p.y_mm + p.width_mm }));
      for (const b of boxes) expect(b.x1 <= s.length_mm + 0.01 && b.y1 <= s.width_mm + 0.01).toBe(true);
      boxes.forEach((a, i) =>
        boxes.slice(i + 1).forEach((b) => {
          expect(a.x1 + 4 <= b.x0 + 0.01 || b.x1 + 4 <= a.x0 + 0.01 || a.y1 + 4 <= b.y0 + 0.01 || b.y1 + 4 <= a.y0 + 0.01).toBe(true);
        }),
      );
    }
  });

  it("gives the same plan every time", () => {
    const d = stand(own("pine", [{ length_mm: 1300, width_mm: 92, qty: 2 }]));
    expect(JSON.stringify(layoutOf(d))).toBe(JSON.stringify(layoutOf(d)));
  });
});

describe("the widths the yard sells", () => {
  it("rips each part from the narrowest width that holds it, two side by side when they fit", () => {
    const narrow = (w: number): Op[] => [1, 2].map((k) => part(`slat_${k}`, "pine", 900, w, 30000 + 1000 * k));
    const plain = pine(layoutOf(stand(...narrow(30))));
    expect(plain.buy.map((b) => b.text)).toContain("1 length of 30 × 21 pine at 2400");
    const sold = pine(layoutOf(stand(...narrow(30), { op: "set_stock", material: "pine", widths_mm: [66, 92] })));
    expect(sold.buy.every((b) => b.width_mm === 66 || b.width_mm === 92)).toBe(true);
    const slats = sold.stock.find((s) => s.parts.some((p) => p.part === "slat_1"))!;
    expect(slats.width_mm).toBe(66);
    expect(slats.parts.filter((p) => p.part.startsWith("slat_")).map((p) => p.y_mm).sort()).toEqual([0, 33]);
  });

  it("refuses a part wider than every width, saying what to add", () => {
    const m = pine(layoutOf(stand(part("top", "pine", 600, 120, 40000), { op: "set_stock", material: "pine", widths_mm: [66] })));
    expect(m.notes.join(" ")).toContain("glue-up of 2 boards 60 mm wide");
  });
});

describe("labels and the cut list", () => {
  it("letters every board and sheet across the plan, yours first", () => {
    const l = layoutOf(stand(own("pine", [{ length_mm: 1300, width_mm: 92, qty: 1 }])));
    expect(l.materials.flatMap((m) => m.stock.map((s) => s.label))).toEqual(["A", "B", "C"]);
    expect(stockLabel(25)).toBe("Z");
    expect(stockLabel(26)).toBe("AA");
    const list = cutList(stand(), derive(stand()));
    const stiles = list.rows.find((r) => r.name === "stile")!;
    expect(boardsOfRow(l, stiles.row)).toEqual(["A"]);
    // The cut lists say the width each is ripped to.
    expect(rowBoards(l, stiles.row)).toEqual(["A, rip 44"]);
    const plain = layoutOf(stand());
    expect(rowBoards(plain, stiles.row)).toEqual(["A"]);
  });
});

describe("setting the stock you own", () => {
  it("merges sizes, keeps the other stock settings, and null clears it", () => {
    const d = applyOps(stand(), [
      { op: "set_stock", material: "pine", lengths_mm: [2400] },
      own("pine", [
        { length_mm: 1800, width_mm: 92, qty: 1 },
        { length_mm: 2400, width_mm: 92, qty: 2 },
        { length_mm: 1800, width_mm: 92, qty: 2 },
      ]),
      { op: "set_stock", material: "pine", widths_mm: [92, 66, 92] },
    ]);
    expect(d.stock?.materials?.pine).toEqual({
      lengths_mm: [2400],
      widths_mm: [66, 92],
      owned: [
        { length_mm: 2400, width_mm: 92, qty: 2 },
        { length_mm: 1800, width_mm: 92, qty: 3 },
      ],
    });
    // Sent twice, it's the same design.
    const again = applyOp(d, own("pine", d.stock!.materials!.pine!.owned!));
    expect(JSON.stringify(again)).toBe(JSON.stringify(d));
    const cleared = applyOps(d, [own("pine", []), { op: "set_stock", material: "pine", widths_mm: null }]);
    expect(cleared.stock?.materials?.pine).toEqual({ lengths_mm: [2400] });
    expect(diffDesigns(stand(), d)).toEqual([
      "Changed stock for pine to 2400 mm lengths",
      "Changed the board widths for pine to 66 and 92 mm",
      "Set your own stock of pine to 5 pieces",
    ]);
    expect(diffDesigns(d, cleared)).toEqual(["Took the board widths off pine", "Cleared your own stock of pine"]);
  });
});

describe("the printed cutting plan", () => {
  const d = stand(own("pine", [{ length_mm: 1300, width_mm: 92, qty: 1 }]));
  const texts = (s: Sheet) => s.marks.flatMap((m) => (m.kind === "text" ? [m.text] : []));

  it("fits one page, with what to buy, what's yours, and each part's row, length and rip", () => {
    const plan = cuttingPlan(d, derive(d), { date: "8 October 2026" });
    expect(plan).toHaveLength(1);
    const [sheet] = plan;
    expect(sheet).toMatchObject({ kind: "cutting plan", title: "Cutting plan", paper: "A4" });
    const written = texts(sheet!);
    expect(written).toContain("Sheet 1 of 1");
    expect(written.join(" ")).toContain("From your stock: 1 of your 92 × 21 pine board at 1300.");
    expect(written.join(" ")).toContain("To buy: 1 length of 44 × 21 pine at 2400, 1 sheet of 18 mm birch ply 2400 × 1200.");
    expect(written).toEqual(expect.arrayContaining(["A", "B", "C", "yours", "to buy", "1300 × 92"]));
    // The stiles on your board are ripped from it, and say so.
    const stile = cutList(d, derive(d)).rows.find((r) => r.name === "stile")!.row;
    expect(written).toContain(`#${stile} · 600 · rip 44`);
    for (const m of sheet!.marks) {
      const pts = m.kind === "line" ? [[m.x1_mm, m.y1_mm], [m.x2_mm, m.y2_mm]] : m.kind === "shape" ? m.points_mm : m.kind === "circle" ? [[m.cx_mm, m.cy_mm]] : [[m.x_mm, m.y_mm]];
      for (const [x, y] of pts) expect(x! >= 0 && x! <= sheet!.width_mm && y! >= 0 && y! <= sheet!.height_mm).toBe(true);
    }
    expect(sheetSvg(sheet!)).toMatch(/^<svg /);
  });

  it("is in the workshop drawings after the cut list, which names each row's boards", () => {
    const set = workshopDrawings(d, derive(d), { date: "8 October 2026" });
    const at = set.findIndex((s) => s.kind === "cutting plan");
    expect(set[at - 1]!.kind).toBe("cut list");
    expect(texts(set[at - 1]!)).toContain("Board");
  });

  it("goes on to a second page when the boards don't fit one", () => {
    const many = stand(...Array.from({ length: 30 }, (_, k) => part(`slat_${k}`, "pine", 2000, 44 + k, 50000 + 3000 * k)));
    const plan = cuttingPlan(many, derive(many), { date: "8 October 2026" });
    expect(plan.length).toBeGreaterThan(1);
    expect(plan[1]!.title).toBe("Cutting plan (continued)");
  });
});

describe("the plan in words", () => {
  it("says each board in cutting order, with its rips, what's yours and what to buy", () => {
    const d = stand(own("pine", [{ length_mm: 1800, width_mm: 92, qty: 2 }]));
    const lines = cuttingPlanText(layoutOf(d));
    expect(lines[0]).toBe("Saw kerf 3 mm, sheet trim 10 mm. Parts are named by cut-list row.");
    expect(lines).toContain("From your stock: 1 of your 92 × 21 pine board at 1800.");
    expect(lines).toContain("To buy: 1 sheet of 18 mm birch ply 2400 × 1200.");
    expect(lines.find((l) => l.startsWith("A: yours, 21 mm pine 1800 × 92."))).toMatch(/stile 600, rip to 44/);
    expect(lines).toContain("Not needed: 1 of your 92 × 21 pine board at 1800.");
  });
});
