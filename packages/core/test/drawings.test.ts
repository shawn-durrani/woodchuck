// Workshop drawings of the record console, drawn from the derived design
// at a standard scale, with every number rounded as the cut list rounds it,
// to 0.1 mm.

import { describe, expect, it } from "vitest";
import {
  applyOp,
  applyOps,
  cutList,
  derive,
  drillingList,
  emptyDesign,
  jointExample,
  recordConsoleOps,
  sheetSvg,
  workshopDrawings,
  type Design,
  type Sheet,
} from "../src/index.js";

function build(): Design {
  return applyOps(emptyDesign("test"), recordConsoleOps());
}

const texts = (s: Sheet) => s.marks.flatMap((m) => (m.kind === "text" ? [m.text] : []));
const dim = (s: Sheet, view: string, along: string, kind: "overall" | "chain") => s.dims.find((x) => x.view === view && x.along === along && x.kind === kind);

describe("workshop drawings", () => {
  const design = build();
  const d = derive(design);
  const sheets = workshopDrawings(design, d, { date: "3 October 2026" });

  it("draws the general arrangement on A4 at 1:20, with 2040 overall and five 372 openings", () => {
    const ga = sheets[0]!;
    expect(ga).toMatchObject({ kind: "arrangement", paper: "A4", scale: 20, width_mm: 297, height_mm: 210 });
    expect(dim(ga, "front", "x", "overall")!.values_mm).toEqual([2040]);
    expect(dim(ga, "front", "x", "chain")).toMatchObject({
      values_mm: [30, 372, 30, 372, 30, 372, 30, 372, 30, 372, 30],
      openings_mm: [372, 372, 372, 372, 372],
    });
    expect(dim(ga, "front", "y", "overall")!.values_mm).toEqual([430]);
    expect(dim(ga, "front", "y", "chain")!.values_mm).toEqual([30, 370, 30]);
    expect(dim(ga, "top", "z", "overall")!.values_mm).toEqual([520]);
    const written = texts(ga);
    expect(written).toContain("2040");
    expect(written.filter((t) => t === "372")).toHaveLength(5);
    expect(written).toEqual(expect.arrayContaining(["Front", "Plan", "Left side"]));
  });

  it("leaves drawer sides hidden behind their fronts out of the chain", () => {
    // 15 mm drawer sides would add 12.7 and 15 to the chain if they counted.
    const chain = dim(sheets[0]!, "front", "x", "chain")!.values_mm;
    expect(chain).not.toContain(15);
    expect(chain.reduce((a, b) => a + b, 0)).toBe(2040);
  });

  it("follows a new top length onto the drawings", () => {
    const longer = applyOp(build(), { op: "set_param", name: "top_length", expr: "2100", unit: "mm" });
    const ga = workshopDrawings(longer, derive(longer), { date: "3 October 2026" })[0]!;
    expect(dim(ga, "front", "x", "overall")!.values_mm).toEqual([2100]);
    expect(dim(ga, "front", "x", "chain")!.openings_mm).toEqual([384, 384, 384, 384, 384]);
  });

  it("makes a sheet for each cut-list row, then the cut list, the cutting plan, and the drilling and hardware lists", () => {
    expect(sheets.map((s) => s.kind)).toEqual(["arrangement", ...Array(12).fill("part"), "cut list", "cutting plan", "cutting plan", "drilling", "hardware"]);
    expect(sheets.every((s) => s.paper === "A4")).toBe(true);
  });

  it("puts a title block, a scale bar and the print note on every sheet", () => {
    sheets.forEach((s, i) => {
      const written = texts(s);
      expect(written).toContain("Record console");
      expect(written).toContain("3 October 2026");
      expect(written).toContain(`Sheet ${i + 1} of 18`);
      expect(written).toContain(s.scale ? `Scale 1:${s.scale}` : "Not to scale");
      expect(written).toContain("Print at 100%, actual size, not fit to page.");
      expect(written.some((t) => / mm$/.test(t))).toBe(true);
    });
  });

  it("says on the arrangement when the design isn't ready to cut", () => {
    expect(texts(sheets[0]!)).toContain("Not ready to cut yet: the checks find 1 error. See the Problems tab.");
  });

  it("draws a part with its quantity, cut size and machining", () => {
    const bottom = sheets.find((s) => s.kind === "part" && s.title === "Part 1: Bottom")!;
    expect(bottom.scale).toBe(10);
    const written = texts(bottom);
    expect(written).toContain("Make 1");
    expect(written).toContain("Cut to 2000 long × 520 wide × 30 thick");
    expect(written).toContain("dado 30 wide × 10 deep × 511 long in the top face for partition. At 382 to 412 along, 9 to 520 up.");
    expect(dim(bottom, "face", "length", "overall")!.values_mm).toEqual([2000]);
    // The partitions sit evenly about the middle, so the chain runs through it, and the sheet gives the end to the middle.
    expect(dim(bottom, "face", "length", "chain")!.values_mm).toEqual([382, 30, 372, 30, 186, 186, 30, 372, 30, 382]);
    expect(bottom.dims).toContainEqual({ view: "face", along: "length", kind: "middle", values_mm: [1000] });
    expect(dim(bottom, "face", "width", "overall")!.values_mm).toEqual([520]);
    expect(dim(bottom, "edge", "thickness", "overall")!.values_mm).toEqual([30]);
  });

  it("gives each part the cut list's own length, width and thickness", () => {
    const rows = cutList(design, d).rows;
    const parts = sheets.filter((s) => s.kind === "part");
    expect(parts.map((s) => s.row)).toEqual(rows.map((r) => r.row));
    for (const r of rows) {
      const sheet = parts.find((s) => s.row === r.row)!;
      expect(texts(sheet)).toContain(`Cut to ${r.length_mm} long × ${r.width_mm} wide × ${r.thickness_mm} thick`);
      expect(texts(sheet)).toContain(`Make ${r.qty}`);
      expect(dim(sheet, "face", "length", "overall")!.values_mm).toEqual([r.length_mm]);
      expect(dim(sheet, "face", "width", "overall")!.values_mm).toEqual([r.width_mm]);
      expect(dim(sheet, "edge", "thickness", "overall")!.values_mm).toEqual([r.thickness_mm]);
    }
  });

  it("rounds to 0.1 mm as the cut list does, so the drawer box front stays 326.6", () => {
    const front = sheets.find((s) => s.title === "Part 8: Drawer box front")!;
    expect(texts(front)).toContain("Cut to 326.6 long × 340 wide × 15 thick");
    expect(texts(front)).toContain("326.6");
    // Hole positions round first, so the gaps between them add up to the width.
    const top = sheets.find((s) => s.title === "Part 12: Top")!;
    const chain = dim(top, "face", "width", "chain")!.values_mm;
    expect(chain).toEqual([86.7, 50.1, 123.2, 132.3, 41, 86.7]);
    expect(chain.reduce((a, b) => a + b, 0)).toBeCloseTo(520, 6);
  });

  it("turns a part over so its machining faces up, as with the right side", () => {
    const right = sheets.find((s) => s.title === "Part 3: Right side")!;
    expect(texts(right)).toContain("groove 9 wide × 10 deep × 370 long in the left face for back. At 30 to 400 along, 511 to 520 up.");
    const left = sheets.find((s) => s.title === "Part 2: Left side")!;
    expect(texts(left)).toContain("groove 9 wide × 10 deep × 370 long in the right face for back. At 30 to 400 along, 0 to 9 up.");
  });

  it("names each view and the sides it measures from, so a part turned over reads the right way round", () => {
    // Both sides' grooves sit at the back. The right side is turned over, so
    // its back edge is at the top of its sheet, and each sheet says which
    // edge it measures up from.
    const right = texts(sheets.find((s) => s.title === "Part 3: Right side")!);
    const left = texts(sheets.find((s) => s.title === "Part 2: Left side")!);
    expect(right).toEqual(expect.arrayContaining(["Left face", "Front edge", "Top end"]));
    expect(left).toEqual(expect.arrayContaining(["Right face", "Back edge", "Top end"]));
    expect(right.join(" ")).toContain("Along is from the bottom end, up from the front edge and in from the left face.");
    expect(left.join(" ")).toContain("Along is from the bottom end, up from the back edge and in from the right face.");
    expect(right.concat(left)).not.toContain("Face");
  });

  it("lists the top's screw holes in the drilling list, with their centres", () => {
    const rows = drillingList(design, d);
    expect(rows.map((r) => `${r.part} ${r.with} ${r.count}×${r.qty}`)).toEqual([
      "Drawer front drawer_box_front 4×5",
      "Top partition 8×1",
      "Top left_side 3×1",
      "Top right_side 3×1",
    ]);
    expect(rows[1]).toMatchObject({
      row: 12,
      holes: "screw holes",
      diameter_mm: 4,
      depth_mm: 30,
      through: true,
      face: "top face",
    });
    expect(rows[1]!.centres.slice(0, 2)).toEqual(["417 along, 136.8 up", "417 along, 392.3 up"]);
    expect(rows[2]!.centres).toEqual(["15 along, 86.7 up", "15 along, 260 up", "15 along, 433.3 up"]);
    const sheet = sheets.find((s) => s.kind === "drilling")!;
    expect(texts(sheet)).toEqual(expect.arrayContaining(["12. Top", "left_side", "through", "15 along, 86.7 up; 15 along, 260 up; 15 along, 433.3 up"]));
  });

  it("lists dowel holes in both parts, and pocket holes as set by the jig", () => {
    const dowels = jointExample("dowels");
    const rows = drillingList(dowels, derive(dowels));
    expect(rows.map((r) => [r.part, r.face, r.count, r.diameter_mm, r.depth_mm])).toEqual([
      ["Top", "bottom face", 2, 8, 16],
      ["Side", "top end", 2, 8, 16],
    ]);
    expect(rows[1]!.centres).toEqual(["45 up, 9 in", "135 up, 9 in"]);
    const pockets = jointExample("pocket_screws");
    const sheet = workshopDrawings(pockets, derive(pockets), { date: "3 October 2026" }).find((s) => s.kind === "drilling")!;
    expect(texts(sheet)).toContain("set by jig");
  });

  it("lists the hardware to buy", () => {
    const sheet = sheets.find((s) => s.kind === "hardware")!;
    expect(texts(sheet)).toEqual(expect.arrayContaining(["Side-mount slide pair, 450 mm", "drawer slide", "5"]));
  });

  it("comes on A3 when asked, at the largest scale that fits there", () => {
    const a3 = workshopDrawings(design, d, { date: "3 October 2026", paper: "A3" });
    expect(a3[0]).toMatchObject({ paper: "A3", scale: 10, width_mm: 420, height_mm: 297 });
    expect(a3.every((s) => s.paper === "A3")).toBe(true);
    expect(dim(a3[0]!, "front", "x", "overall")!.values_mm).toEqual([2040]);
  });

  it("draws an empty design as one sheet saying so, and the cut list", () => {
    const empty = emptyDesign("Nothing yet");
    const set = workshopDrawings(empty, derive(empty), { date: "3 October 2026" });
    expect(set.map((s) => s.kind)).toEqual(["arrangement", "cut list"]);
    expect(texts(set[0]!)).toContain("Nothing to draw yet");
  });

  it("writes each sheet as SVG at true size in millimetres", () => {
    const svg = sheetSvg(sheets[0]!);
    expect(svg).toMatch(/^<svg [^>]*width="297mm" height="210mm" viewBox="0 0 297 210"/);
    expect(svg).toContain(">2040</text>");
  });
});
