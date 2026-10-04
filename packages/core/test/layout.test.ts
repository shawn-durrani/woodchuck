// Cutting layouts: parts placed on the sheets and lengths you buy,
// with the saw's kerf and the grain respected, the same way every time.

import { describe, expect, it } from "vitest";
import {
  applyOp,
  applyOps,
  cutLayout,
  cutList,
  derive,
  diffDesigns,
  emptyDesign,
  OpError,
  stockSettings,
  type CutLayout,
  type Design,
  type Op,
  type PlacedPart,
} from "../src/index.js";

/** A flat part: its length runs along x, which is the grain. */
const part = (id: string, material: string, length: number, width: number, at = 0): Op => ({
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

const materials: Op[] = [
  { op: "define_material", id: "ply18", name: "18 mm birch ply", kind: "sheet", thickness_mm: 18, grained: true },
  { op: "define_material", id: "mdf16", name: "16 mm MDF", kind: "sheet", thickness_mm: 16, grained: false },
  { op: "define_material", id: "fir", name: "42 mm Douglas fir", kind: "solid", thickness_mm: 42, grained: true },
  { op: "define_material", id: "oak", name: "30 mm oak", kind: "solid", thickness_mm: 30, grained: true },
];

// A bookcase and a bench, for Alex's workshop in Fairhaven.
const pieces: Op[] = [
  part("side_1", "ply18", 1800, 300),
  part("side_2", "ply18", 1800, 300, 2000),
  ...[1, 2, 3, 4].map((k) => part(`shelf_${k}`, "ply18", 764, 300, 4000 + 1000 * k)),
  part("back", "ply18", 1800, 800, 9000),
  ...[1, 2, 3].map((k) => part(`door_${k}`, "mdf16", 1100, 700, 11000 + 2000 * k)),
  ...[1, 2, 3, 4].map((k) => part(`leg_${k}`, "fir", 720, 42, 20000 + 1000 * k)),
  ...[1, 2, 3, 4].map((k) => part(`long_rail_${k}`, "fir", 1200, 90, 30000 + 2000 * k)),
  ...[1, 2].map((k) => part(`short_rail_${k}`, "fir", 500, 90, 40000 + 1000 * k)),
  part("bench_top", "oak", 1200, 600, 50000),
];

const build = (extra: Op[] = []): Design => applyOps(emptyDesign("Fairhaven bench"), [...materials, ...pieces, ...extra]);
const layoutOf = (d: Design): CutLayout => cutLayout(d, cutList(d, derive(d)));
const of = (l: CutLayout, id: string) => l.materials.find((m) => m.material === id)!;

/** How much of the stock a placed part covers, along it and across it. */
const footprint = (p: PlacedPart) => (p.rotated ? [p.width_mm, p.length_mm] : [p.length_mm, p.width_mm]) as [number, number];

describe("cutting layouts", () => {
  it("pins the sheets and lengths to buy for a small piece", () => {
    const l = layoutOf(build());
    expect(l.kerf_mm).toBe(3);
    expect(l.trim_mm).toBe(10);
    expect(l.buy.map((b) => b.text)).toEqual([
      "2 sheets of 18 mm birch ply 2400 × 1200",
      "1 sheet of 16 mm MDF 2400 × 1200",
      "2 lengths of 90 × 42 Douglas fir at 3000",
      "1 length of 42 × 42 Douglas fir at 3000",
      "1 length of 300 × 30 oak at 3000",
    ]);
    expect(of(l, "ply18").stock).toHaveLength(2);
    expect(of(l, "fir").stock.map((s) => `${s.width_mm}:${s.parts.map((p) => p.length_mm).join("+")}`)).toEqual([
      "90:1200+1200+500",
      "90:1200+1200+500",
      "42:720+720+720+720",
    ]);
    // By area: 5800 × 90 of rail from 6000 × 90, and 2880 × 42 of leg from 3000 × 42.
    expect(of(l, "fir").waste_pct).toBe(3.5);
    for (const m of l.materials) expect(m.unplaced).toEqual([]);
  });

  it("keeps a kerf between parts and every part inside the trim", () => {
    for (const extra of [[], [{ op: "set_stock", kerf_mm: 4.5, trim_mm: 15 } as Op]]) {
      const l = layoutOf(build(extra));
      const { kerf_mm: kerf, trim_mm: trim } = l;
      for (const m of l.materials) {
        for (const s of m.stock) {
          const edge = m.kind === "sheet" ? trim : 0;
          const boxes = s.parts.map((p) => {
            const [w, h] = footprint(p);
            return { x0: p.x_mm, y0: p.y_mm, x1: p.x_mm + w, y1: p.y_mm + h };
          });
          for (const b of boxes) {
            expect(b.x0).toBeGreaterThanOrEqual(edge - 0.01);
            expect(b.y0).toBeGreaterThanOrEqual(edge - 0.01);
            expect(b.x1).toBeLessThanOrEqual(s.length_mm - edge + 0.01);
            expect(b.y1).toBeLessThanOrEqual(s.width_mm - edge + 0.01);
          }
          boxes.forEach((a, i) =>
            boxes.slice(i + 1).forEach((b) => {
              const apart = a.x1 + kerf <= b.x0 + 0.01 || b.x1 + kerf <= a.x0 + 0.01 || a.y1 + kerf <= b.y0 + 0.01 || b.y1 + kerf <= a.y0 + 0.01;
              expect(apart, `${m.material}: parts closer than the kerf`).toBe(true);
            }),
          );
        }
      }
    }
  });

  it("keeps the grain along a grained sheet, and turns parts where there's no grain", () => {
    const l = layoutOf(build());
    for (const s of of(l, "ply18").stock) for (const p of s.parts) expect(p.rotated).toBe(false);
    // Three 1100 × 700 doors fit one sheet only if they're turned.
    const mdf = of(l, "mdf16");
    expect(mdf.stock).toHaveLength(1);
    expect(mdf.stock[0]!.parts.every((p) => p.rotated)).toBe(true);
    const grained = layoutOf(build([{ op: "define_material", id: "mdf16", name: "16 mm oak veneer MDF", kind: "sheet", thickness_mm: 16, grained: true }]));
    expect(of(grained, "mdf16").stock).toHaveLength(2);
    expect(of(grained, "mdf16").stock.flatMap((s) => s.parts).every((p) => !p.rotated)).toBe(true);
  });

  it("gives the same layout every time", () => {
    expect(JSON.stringify(layoutOf(build()))).toBe(JSON.stringify(layoutOf(build())));
    const d = build();
    const list = cutList(d, derive(d));
    expect(cutLayout(d, list)).toEqual(cutLayout(d, list));
  });

  it("glues up a solid part wider than a board, and says so", () => {
    const oak = of(layoutOf(build()), "oak");
    expect(oak.stock).toHaveLength(1);
    // Two 1200 boards and a kerf don't fit 2400, so it's one 3000.
    expect(oak.stock[0]!.parts.map((p) => [p.part, p.board, p.length_mm, p.width_mm])).toEqual([
      ["bench_top", [1, 2], 1200, 300],
      ["bench_top", [2, 2], 1200, 300],
    ]);
    expect(oak.notes).toEqual(["bench top is 600 mm wide, more than a 300 mm board, so it's a glue-up of 2 boards 300 mm wide. Glue them up, then cut to width"]);
    expect(oak.stock[0]!.offcuts).toEqual([{ x_mm: 2406, y_mm: 0, length_mm: 594, width_mm: 300 }]);

    // A material that comes in wide boards needs no glue-up.
    const wide = layoutOf(build([{ op: "define_material", id: "oak", name: "30 mm oak", kind: "solid", thickness_mm: 30, grained: true, board_max_width_mm: 650 }]));
    expect(of(wide, "oak").notes).toEqual([]);
    expect(of(wide, "oak").buy.map((b) => b.text)).toEqual(["1 length of 600 × 30 oak at 2400"]);
  });

  it("lists a part too big for any stock, and lays out the rest", () => {
    const l = layoutOf(build([part("plinth", "ply18", 2500, 100, 60000), part("beam", "fir", 6000, 90, 70000)]));
    expect(of(l, "ply18").unplaced.map((u) => [u.part, u.reason])).toEqual([
      ["plinth", "2500 × 100 mm doesn't fit a 2400 × 1200 sheet inside its 10 mm trim with the grain along the sheet"],
    ]);
    expect(of(l, "fir").unplaced.map((u) => [u.part, u.reason])).toEqual([
      ["beam", "6000 mm long, and the longest length is 3600 mm. Join two lengths, or add a longer stock length"],
    ]);
    expect(of(l, "ply18").stock).toHaveLength(2);
  });

  it("uses the design's sheet sizes, lengths, kerf and trim", () => {
    const l = layoutOf(
      build([
        { op: "set_stock", material: "ply18", sheet_mm: [2440, 1220] },
        { op: "set_stock", material: "fir", lengths_mm: [2400, 1800] },
        { op: "set_stock", kerf_mm: 0 },
      ]),
    );
    expect(of(l, "ply18").custom).toBe(true);
    expect(of(l, "ply18").buy.map((b) => b.text)).toEqual(["2 sheets of 18 mm birch ply 2440 × 1220"]);
    expect(of(l, "fir").lengths_mm).toEqual([1800, 2400]);
    // With no kerf, two 1200 boards fill a 2400 exactly.
    expect(of(l, "oak").buy.map((b) => b.text)).toEqual(["1 length of 300 × 30 oak at 2400"]);
    // Three lengths either way, and the two 500s need only an 1800.
    expect(of(l, "fir").buy.map((b) => b.text)).toEqual([
      "2 lengths of 90 × 42 Douglas fir at 2400",
      "1 length of 90 × 42 Douglas fir at 1800",
      "2 lengths of 42 × 42 Douglas fir at 1800",
    ]);
  });

  it("lays out a design saved before stock settings with the defaults", () => {
    const d = build();
    expect(d.stock).toBeUndefined();
    expect(stockSettings(d)).toEqual({ kerf_mm: 3, trim_mm: 10 });
    expect(of(layoutOf(d), "ply18").sheet_mm).toEqual([2400, 1200]);
    expect(of(layoutOf(d), "fir").lengths_mm).toEqual([2400, 3000, 3600]);
  });
});

describe("stock lengths you can carry home", () => {
  // Lengths stop at 3.6 m, and 2.4 m is the commonest at the yard.
  const fir = (ops: Op[]) => layoutOf(applyOps(emptyDesign("Rails"), [materials[2]!, ...ops]));
  const lengths = (l: CutLayout) => of(l, "fir").stock.map((s) => s.length_mm);

  it("never buys longer than 3600 by default", () => {
    const l = fir([1, 2, 3, 4, 5].map((k) => part(`rail_${k}`, "fir", 1700, 90, 2000 * k)));
    expect(Math.max(...lengths(l))).toBe(3600);
  });

  it("buys the least timber first, so two 1700 rails share one 3600 length", () => {
    expect(lengths(fir([1, 2].map((k) => part(`rail_${k}`, "fir", 1700, 90, 2000 * k))))).toEqual([3600]);
  });

  it("takes 2400 lengths when they cost no more timber", () => {
    expect(lengths(fir([1, 2, 3, 4].map((k) => part(`rail_${k}`, "fir", 1170, 90, 2000 * k))))).toEqual([2400, 2400]);
  });
});

describe("the set_stock operation", () => {
  it("sets stock, and null goes back to the default", () => {
    const d = applyOps(build(), [
      { op: "set_stock", kerf_mm: 2.5, trim_mm: 12 },
      { op: "set_stock", material: "fir", lengths_mm: [3600, 2400, 2400] },
    ]);
    expect(d.stock).toEqual({ kerf_mm: 2.5, trim_mm: 12, materials: { fir: { lengths_mm: [2400, 3600] } } });
    const back = applyOps(d, [
      { op: "set_stock", kerf_mm: null, trim_mm: null },
      { op: "set_stock", material: "fir", lengths_mm: null },
    ]);
    expect(back.stock).toBeUndefined();
    expect(JSON.stringify(back)).toBe(JSON.stringify(build()));
  });

  it("refuses stock it can't use, and says how to fix the call", () => {
    const d = build();
    const bad = (op: Omit<Extract<Op, { op: "set_stock" }>, "op">, msg: RegExp) => {
      expect(() => applyOp(d, { op: "set_stock", ...op })).toThrow(OpError);
      expect(() => applyOp(d, { op: "set_stock", ...op })).toThrow(msg);
    };
    bad({}, /needs kerf_mm, trim_mm, or a material/);
    bad({ kerf_mm: -1 }, /kerf_mm must be from 0 to 20 mm/);
    bad({ kerf_mm: 25 }, /kerf_mm must be from 0 to 20 mm/);
    bad({ trim_mm: 150 }, /trim_mm must be from 0 to 100 mm/);
    bad({ kerf_mm: "3" as unknown as number }, /kerf_mm must be a number/);
    bad({ sheet_mm: [2400, 1200] }, /Say which material/);
    bad({ material: "walnut", sheet_mm: [2400, 1200] }, /no material "walnut"/);
    bad({ material: "ply18" }, /Give sheet_mm or lengths_mm for ply18/);
    bad({ material: "ply18", lengths_mm: [2400] }, /ply18 is sheet goods/);
    bad({ material: "fir", sheet_mm: [2400, 1200] }, /fir is solid timber/);
    bad({ material: "ply18", sheet_mm: [2400] as unknown as [number, number] }, /sheet_mm must be \[length along the grain, width\]/);
    bad({ material: "ply18", sheet_mm: [2400, 15] }, /more than twice the 10 mm trim/);
    bad({ material: "fir", lengths_mm: [] }, /lengths_mm must list 1 to 20 lengths/);
    bad({ material: "fir", lengths_mm: [2400, -5] }, /Each length must be above 0/);
  });

  it("drops a material's stock when the material goes or changes kind", () => {
    const d = applyOps(emptyDesign("t"), [
      ...materials,
      { op: "set_stock", material: "ply18", sheet_mm: [2440, 1220] },
      { op: "set_stock", material: "fir", lengths_mm: [2400] },
    ]);
    expect(applyOp(d, { op: "delete_material", id: "ply18" }).stock).toEqual({ materials: { fir: { lengths_mm: [2400] } } });
    const solid = applyOp(d, { op: "define_material", id: "ply18", name: "18 mm birch", kind: "solid", thickness_mm: 18, grained: true });
    expect(solid.stock).toEqual({ materials: { fir: { lengths_mm: [2400] } } });
    // Renaming it keeps the stock.
    const renamed = applyOp(d, { op: "define_material", id: "ply18", name: "18 mm hoop pine ply", kind: "sheet", thickness_mm: 18, grained: true });
    expect(renamed.stock?.materials?.ply18).toEqual({ sheet_mm: [2440, 1220] });
  });

  it("says what changed in the version history", () => {
    const before = build();
    const after = applyOps(before, [
      { op: "set_stock", kerf_mm: 2.5 },
      { op: "set_stock", trim_mm: 0 },
      { op: "set_stock", material: "ply18", sheet_mm: [2440, 1220] },
      { op: "set_stock", material: "fir", lengths_mm: [2400, 3000, 3600] },
    ]);
    expect(diffDesigns(before, after)).toEqual([
      "Changed the saw kerf from 3 to 2.5 mm",
      "Changed the sheet trim from 10 to 0 mm",
      "Changed stock for fir to 2400, 3000 and 3600 mm lengths",
      "Changed stock for ply18 to 2440 × 1220 mm sheets",
    ]);
    const back = applyOp(after, { op: "set_stock", material: "ply18", sheet_mm: null });
    expect(diffDesigns(after, back)).toEqual(["Changed stock for ply18 back to the default"]);
  });
});
