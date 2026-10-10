// Issue #86: a long, narrow part drawn small enough to fit printed its
// small sizes on top of each other. Where a row of dimensions would, the
// part's sheet draws that spot again larger as a detail. Issue #92: a
// Domino mortise is set out by its centre, and a part laid out evenly along
// its length from its middle. The pieces are invented. A record rack's rail,
// 1500 long and 45 wide in 19 mm pine, houses three pairs of 6 mm ply fins
// 4 mm apart. A hall frame's rails take a stile at each end and three
// braces between, each on one Domino.

import { describe, expect, it } from "vitest";
import {
  applyOps,
  derive,
  emptyDesign,
  jointExample,
  JOINT_TYPES,
  recordConsoleOps,
  textWidth_mm,
  workshopDrawings,
  type Design,
  type Mark,
  type Op,
  type Sheet,
} from "../src/index.js";

const frame: Op[] = [
  { op: "define_material", id: "pine19", name: "19 mm pine", kind: "solid", thickness_mm: 19, grained: true },
  { op: "add_panel", id: "top_rail", name: "Top rail", material: "pine19", thickness_axis: "y", grain_axis: "x", x: { start: { at: "0" }, size: "1500" }, y: { start: { at: "881" } }, z: { start: { at: "0" }, size: "45" } },
  { op: "add_panel", id: "bottom_rail", name: "Bottom rail", material: "pine19", thickness_axis: "y", grain_axis: "x", x: { start: { at: "0" }, size: "1500" }, y: { start: { at: "0" } }, z: { start: { at: "0" }, size: "45" } },
  { op: "add_panel", id: "stile_l", name: "Stile", material: "pine19", thickness_axis: "x", grain_axis: "y", x: { start: { at: "0" } }, y: { start: { face: "bottom_rail.top" }, end: { face: "top_rail.bottom" } }, z: { start: { at: "0" }, size: "45" } },
  { op: "add_panel", id: "stile_r", name: "Stile", material: "pine19", thickness_axis: "x", grain_axis: "y", x: { end: { at: "1500" } }, y: { start: { face: "bottom_rail.top" }, end: { face: "top_rail.bottom" } }, z: { start: { at: "0" }, size: "45" } },
  ...["370", "730", "1090"].map(
    (at, i): Op => ({ op: "add_panel", id: `brace_${i + 1}`, name: "Brace", material: "pine19", thickness_axis: "z", grain_axis: "y", x: { start: { at }, size: "40" }, y: { start: { face: "bottom_rail.top" }, end: { face: "top_rail.bottom" } }, z: { start: { at: "4" } } }),
  ),
  ...["top_rail", "bottom_rail"].flatMap((host) =>
    ["stile_l", "stile_r", "brace_1", "brace_2", "brace_3"].map((guest): Op => ({ op: "add_joint", id: `${guest}_${host}`, type: "domino", host, guest, thickness: "5", length: "30", depth: "12", count: 1 })),
  ),
];

const rack: Op[] = [
  { op: "define_material", id: "ply6", name: "6 mm birch ply", kind: "sheet", thickness_mm: 6, grained: true },
  { op: "define_material", id: "pine19", name: "19 mm pine", kind: "solid", thickness_mm: 19, grained: true },
  { op: "add_panel", id: "rail", name: "Rail", material: "pine19", thickness_axis: "y", grain_axis: "x", x: { start: { at: "0" }, size: "1500" }, y: { start: { at: "0" } }, z: { start: { at: "0" }, size: "45" } },
  ...["370", "730", "1090"].flatMap((at, i): Op[] => [
    { op: "add_panel", id: `fin_${i}a`, name: "Fin", material: "ply6", thickness_axis: "x", grain_axis: "y", x: { start: { at } }, y: { start: { face: "rail.top" }, size: "200" }, z: { start: { at: "0" }, size: "45" } },
    { op: "add_panel", id: `fin_${i}b`, name: "Fin", material: "ply6", thickness_axis: "x", grain_axis: "y", x: { start: { face: `fin_${i}a.right`, offset: "4" } }, y: { start: { face: "rail.top" }, size: "200" }, z: { start: { at: "0" }, size: "45" } },
    { op: "add_joint", id: `fin_${i}a_in`, type: "dado", host: "rail", guest: `fin_${i}a` },
    { op: "add_joint", id: `fin_${i}b_in`, type: "dado", host: "rail", guest: `fin_${i}b` },
  ]),
];

const sheetsOf = (d: Design) => workshopDrawings(d, derive(d), { date: "10 October 2026" });
const texts = (s: Sheet) => s.marks.flatMap((m) => (m.kind === "text" ? [m.text] : []));
const chains = (s: Sheet) => s.dims.filter((x) => x.kind === "chain").map(({ view, along, values_mm, scale }) => ({ view, along, values_mm, ...(scale ? { scale } : {}) }));

describe("details of the spots too small to read", () => {
  const sheets = sheetsOf(applyOps(emptyDesign("Record rack"), rack));
  const sheet = (title: string) => sheets.find((s) => s.title === title)!;

  it("draws each crowded spot of a long rail again larger, with all its sizes", () => {
    const rail = sheet("Part 1: Rail");
    expect(rail.scale).toBe(10);
    // Each pair of housings is 6, 4 and 6 mm, too small to read at 1:10. The main view keeps where each pair starts.
    expect(chains(rail)).toEqual([
      { view: "face", along: "length", values_mm: [370, 360, 360, 410] },
      { view: "detail A", along: "length", values_mm: [6, 4, 6], scale: 5 },
      { view: "detail A", along: "width", values_mm: [45], scale: 5 },
    ]);
    // The three pairs are drawn the same, so they share one detail, circled three times.
    expect(texts(rail)).toContain("Detail A, 1:5, 3 places");
    expect(texts(rail).filter((t) => t === "A")).toHaveLength(3);
    expect(rail.marks.filter((m) => m.kind === "circle" && m.dashed)).toHaveLength(3);
  });

  it("leaves a sheet whose numbers all read as it was", () => {
    expect(sheet("Part 2: Fin").dims.some((x) => x.view.startsWith("detail"))).toBe(false);
  });

  it("writes a narrow end gap's number past the row's end, with no detail", () => {
    // The drawer side's dados leave 10 then 5 at each end, which printed over each other.
    const rc = applyOps(emptyDesign("Record console"), recordConsoleOps());
    const side = sheetsOf(rc).find((s) => s.title === "Part 6: Drawer side, left")!;
    expect(chains(side)).toContainEqual({ view: "face", along: "length", values_mm: [10, 5, 443, 5, 10] });
    expect(side.dims.some((x) => x.view.startsWith("detail"))).toBe(false);
    // Each 10 sits on the line past its end of the row, and the 5 beside it is lifted.
    const row = side.marks
      .filter((m): m is Extract<Mark, { kind: "text" }> => m.kind === "text" && !m.vertical && ["10", "5", "443"].includes(m.text))
      .sort((p, q) => p.x_mm - q.x_mm);
    const line = row.find((m) => m.text === "443")!.y_mm;
    expect(row.map((m) => [m.text, Math.round((line - m.y_mm) * 10) / 10])).toEqual([
      ["10", 0],
      ["5", 3],
      ["443", 0],
      ["5", 3],
      ["10", 0],
    ]);
  });
});

describe("a long rail set out by its Dominos' centres, from its middle", () => {
  const sheets = sheetsOf(applyOps(emptyDesign("Hall frame"), frame));
  const sheet = (title: string) => sheets.find((s) => s.title === title)!;

  it("places each mortise by its centre, with the rail's middle to set out from", () => {
    const top = sheet("Part 1: Top rail");
    // A stile's mortise 9.5 in from each end, and the braces 360 apart either side of the middle.
    expect(chains(top)).toEqual([
      { view: "face", along: "length", values_mm: [9.5, 380.5, 360, 360, 380.5, 9.5] },
      { view: "face", along: "width", values_mm: [22.5, 9, 13.5] },
    ]);
    expect(top.dims).toContainEqual({ view: "face", along: "length", kind: "middle", values_mm: [750] });
    expect(top.dims.some((x) => x.view.startsWith("detail"))).toBe(false);
    expect(texts(top)).toContain("Domino mortise 5 wide × 24.8 long × 12 deep, 6 mm play, in the bottom face for brace_1. Centre at 390 along, 31.5 up, its length running along.");
  });

  it("measures the bottom rail's centres up from its own back edge", () => {
    // The top rail is turned over for its mortises, so its width runs up from the front.
    expect(chains(sheet("Part 2: Bottom rail"))).toContainEqual({ view: "face", along: "width", values_mm: [13.5, 9, 22.5] });
  });

  it("gives a part with work only at its ends no middle", () => {
    const rc = applyOps(emptyDesign("Record console"), recordConsoleOps());
    const side = sheetsOf(rc).find((s) => s.title === "Part 6: Drawer side, left")!;
    expect(side.dims.some((x) => x.kind === "middle")).toBe(false);
  });
});

/** Where a text mark sits on the paper, roughly, from its font's widths. */
function box(m: Extract<Mark, { kind: "text" }>) {
  const w = textWidth_mm(m.text, m.size_mm, m.bold);
  const s0 = m.anchor === "middle" ? -w / 2 : m.anchor === "end" ? -w : 0;
  const up = 0.72 * m.size_mm;
  const down = 0.18 * m.size_mm;
  if (!m.vertical) return { x0: m.x_mm + s0, x1: m.x_mm + s0 + w, y0: m.y_mm - up, y1: m.y_mm + down };
  // Vertical text reads from the bottom up.
  return { x0: m.x_mm - up, x1: m.x_mm + down, y0: m.y_mm - s0 - w, y1: m.y_mm - s0 };
}

describe("every example's part sheets", () => {
  const designs: [string, Design][] = [
    ["record console", applyOps(emptyDesign("Record console"), recordConsoleOps())],
    ...JOINT_TYPES.map((t): [string, Design] => [t, jointExample(t)]),
    ["hall frame", applyOps(emptyDesign("Hall frame"), frame)],
    ["record rack", applyOps(emptyDesign("Record rack"), rack)],
  ];
  const parts = designs.flatMap(([name, d]) => sheetsOf(d).filter((s) => s.kind === "part").map((s) => [name, s] as const));

  it("print no number or label over another", () => {
    const overlaps: string[] = [];
    for (const [name, s] of parts) {
      const marks = s.marks.filter((m): m is Extract<Mark, { kind: "text" }> => m.kind === "text");
      const boxes = marks.map(box);
      boxes.forEach((a, i) =>
        boxes.slice(i + 1).forEach((b, j) => {
          if (a.x0 < b.x1 - 0.05 && b.x0 < a.x1 - 0.05 && a.y0 < b.y1 - 0.05 && b.y0 < a.y1 - 0.05) overlaps.push(`${name}, ${s.title}: "${marks[i]!.text}" and "${marks[i + j + 1]!.text}"`);
        }),
      );
    }
    expect(overlaps).toEqual([]);
  });

  it("never leave two narrow gaps side by side in a row, but the first two or the last two", () => {
    const crowded: string[] = [];
    for (const [name, s] of parts) {
      for (const dim of s.dims.filter((x) => x.kind === "chain")) {
        const scale = dim.scale ?? s.scale!;
        const narrow = dim.values_mm.map((v) => textWidth_mm(String(v), 2.5) > v / scale - 1);
        const n = narrow.length;
        for (let i = 1; i < n; i++) if (narrow[i - 1] && narrow[i] && i !== 1 && i !== n - 1) crowded.push(`${name}, ${s.title}, ${dim.view} ${dim.along}: ${dim.values_mm.join(", ")}`);
      }
    }
    expect(crowded).toEqual([]);
  });
});
