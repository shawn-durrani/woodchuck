// Issue #86: a long, narrow part drawn small enough to fit printed its
// small sizes on top of each other. Where a row of dimensions would, the
// part's sheet draws that spot again larger as a detail. The frame is
// invented: rails 1500 long and 45 wide in 19 mm pine, with a stile at
// each end and three braces between, each on one Domino.

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

const sheetsOf = (d: Design) => workshopDrawings(d, derive(d), { date: "10 October 2026" });
const texts = (s: Sheet) => s.marks.flatMap((m) => (m.kind === "text" ? [m.text] : []));
const chains = (s: Sheet) => s.dims.filter((x) => x.kind === "chain").map(({ view, along, values_mm, scale }) => ({ view, along, values_mm, ...(scale ? { scale } : {}) }));

describe("details of the spots too small to read", () => {
  const sheets = sheetsOf(applyOps(emptyDesign("Hall frame"), frame));
  const sheet = (title: string) => sheets.find((s) => s.title === title)!;

  it("draws each crowded spot of a long rail again larger, with all its sizes", () => {
    const top = sheet("Part 1: Top rail");
    expect(top.scale).toBe(10);
    // The main view keeps where each spot starts, and its overall width.
    expect(chains(top)).toEqual([
      { view: "face", along: "length", values_mm: [7, 373.6, 360, 360, 387.4, 12] },
      { view: "detail A", along: "length", values_mm: [7, 5], scale: 2 },
      { view: "detail A", along: "width", values_mm: [13.1, 18.8, 13.1], scale: 2 },
      { view: "detail B", along: "length", values_mm: [18.8], scale: 2 },
      { view: "detail B", along: "width", values_mm: [29, 5, 11], scale: 2 },
      { view: "detail C", along: "length", values_mm: [5, 7], scale: 2 },
      { view: "detail C", along: "width", values_mm: [13.1, 18.8, 13.1], scale: 2 },
    ]);
    expect(top.dims).toContainEqual({ view: "face", along: "width", kind: "overall", values_mm: [45] });
    // The three braces' mortises are drawn the same, so they share one detail, circled three times.
    expect(texts(top)).toEqual(expect.arrayContaining(["Detail A, 1:2", "Detail B, 1:2, 3 places", "Detail C, 1:2"]));
    expect(texts(top).filter((t) => t === "B")).toHaveLength(3);
    expect(top.marks.filter((m) => m.kind === "circle" && m.dashed)).toHaveLength(5);
  });

  it("measures each detail from its own sheet's edges, so the bottom rail's braces read from the back", () => {
    // The top rail is turned over for its mortises, so its width runs up from the front.
    expect(chains(sheet("Part 2: Bottom rail"))).toContainEqual({ view: "detail B", along: "width", values_mm: [11, 5, 29], scale: 2 });
  });

  it("leaves a sheet whose numbers all read as it was", () => {
    expect(sheet("Part 3: Stile").dims.some((x) => x.view.startsWith("detail"))).toBe(false);
    expect(chains(sheet("Part 3: Stile"))).toContainEqual({ view: "face", along: "width", values_mm: [13.1, 18.8, 13.1] });
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
