// The workshop drawings' PDF writer: a well-formed file, at true size, with
// its text in Helvetica. A shape with holes fills by the even-odd rule, and
// a design with no cuts writes the same bytes it did before shapes.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyOps, derive, emptyDesign, jointExample, JOINT_TYPES, recordConsoleOps, workshopDrawings, type JointType, type Sheet } from "@woodchuck/core";
import { drawingsPdf, paperOf } from "../src/pdf.js";

const design = applyOps(emptyDesign("test"), recordConsoleOps());
const sheets = workshopDrawings(design, derive(design), { date: "3 October 2026" });

describe("the drawings PDF", () => {
  it("points every cross-reference entry at its object", () => {
    const pdf = drawingsPdf(sheets, { title: "Record console", now: new Date(Date.UTC(2026, 9, 3)) }).toString("latin1");
    const start = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(pdf)![1]);
    expect(pdf.slice(start, start + 4)).toBe("xref");
    const entries = pdf.slice(start).split("\n").slice(3, 3 + 6 + sheets.length * 2 - 1);
    entries.forEach((e, i) => {
      expect(e).toMatch(/^\d{10} 00000 n $/);
      expect(pdf.slice(Number(e.slice(0, 10))).startsWith(`${i + 1} 0 obj\n`)).toBe(true);
    });
    expect(pdf).toContain("/Info 5 0 R");
    expect(pdf).toContain("/Title (Record console) /Producer (Woodchuck) /CreationDate (D:20261003000000Z)");
    expect(pdf).toContain("/PrintScaling /None");
  });

  it("draws in points at true size, with text in Helvetica", () => {
    const sheet: Sheet = {
      kind: "part",
      title: "Test",
      paper: "A4",
      width_mm: 297,
      height_mm: 210,
      scale: 1,
      dims: [],
      marks: [
        { kind: "line", x1_mm: 0, y1_mm: 0, x2_mm: 25.4, y2_mm: 0, stroke_mm: 0.25 },
        { kind: "text", x_mm: 10, y_mm: 20, size_mm: 2.5, text: "Ø 4 × 30 (through)", bold: true },
      ],
    };
    const pdf = drawingsPdf([sheet], { title: "Test", compress: false }).toString("latin1");
    // 25.4 mm is 72 points, and y runs up from the bottom of the A4 page.
    expect(pdf).toContain("0 595.276 m 72 595.276 l S");
    expect(pdf).toContain("/F2 7.087 Tf 1 0 0 1 28.346 538.583 Tm (\\330 4 \\327 30 \\(through\\)) Tj ET");
    expect(pdf).toContain("/BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding");
  });

  it("takes A4 or A3 from a request, and nothing else", () => {
    expect(paperOf("A4")).toEqual({ paper: "A4" });
    expect(paperOf("A3")).toEqual({ paper: "A3" });
    expect(paperOf("letter")).toEqual({});
    expect(paperOf(null)).toEqual({});
  });
  it("fills a shape with holes by the even-odd rule, so the holes stay open", () => {
    const sheet: Sheet = {
      kind: "part",
      title: "Test",
      paper: "A4",
      width_mm: 297,
      height_mm: 210,
      scale: 1,
      dims: [],
      marks: [
        {
          kind: "shape",
          points_mm: [
            [0, 0],
            [25.4, 0],
            [25.4, 25.4],
          ],
          holes_mm: [
            [
              [10, 5],
              [20, 15],
              [20, 5],
            ],
          ],
          stroke_mm: 0.35,
          fill: "#ffffff",
        },
        { kind: "shape", points_mm: [[0, 0], [10, 0], [10, 10]], holes_mm: [[[2, 1], [8, 7], [8, 1]]], stroke_mm: 0, fill: "#ffffff" },
        { kind: "shape", points_mm: [[0, 0], [10, 0], [10, 10]], stroke_mm: 0.35, fill: "#ffffff" },
      ],
    };
    const pdf = drawingsPdf([sheet], { title: "Test", compress: false }).toString("latin1");
    // The outline and the hole are one path, two loops, filled and stroked by the even-odd rule.
    expect(pdf).toContain("1 1 1 rg 0 595.276 m 72 595.276 l 72 523.276 l h 28.346 581.102 m 56.693 552.756 l 56.693 581.102 l h B*");
    expect(pdf).toMatch(/ h f\*\n/);
    // A shape with no holes keeps the plain operator.
    expect(pdf).toMatch(/28\.346 566\.929 l h B\n/);
  });
});

// The PDF of every example, as main wrote it before shapes were drawn. The
// drawings gained the cutting plan and the cut list's Board column with #78.
const BEFORE_SHAPES: Record<string, string> = {
  "record console": "3c4c397516dab7672744358e1769e9846918c5890b3c24a4c4b5e4175a697b30",
  butt: "de00b6b4477e0d2725db2ef471240d124ca403220b1116eb3c9039f9b140e913",
  screws: "2f022b320531dc96197d739b961633d156338c772c1e83c2617c3af51e897463",
  pocket_screws: "5c8c52cff0a3883c008cd7669b58e7cd78ee2ec541cc478b8350ed4a7c89c141",
  dowels: "5c9fa58732ce37bf05cf9a6acea9e5f9855f545c63f8e69b4f048961d2424cb1",
  // Added with the joint, after shapes were drawn.
  domino: "b4f8dbaee0d6a6b719227fd300f5caa8c6d73d329e141ff3e063515dbf8cba33",
  dado: "f499535dd54f049cda1dd180599fd0c3310c446784ac2c862464cd6648af0f5e",
  groove: "082be5ef6b0792279fed84d968b32ad520536cd2fe430ded968dd1f124291926",
  rabbet: "9c87c53bddbb63f48981d3f4cb21a72418c5f73c7c97e95e102843dbfdb71f1f",
  tongue: "3d7aab804a83760d62c479d2c914b9d5fa163502448f15d934d6a18421d710ea",
  // Added with the joint, after shapes were drawn.
  dado_rabbet: "67d99c63c2656df10996658391d0c6f5778534ccf2b8ecc6e5b50fde3570e70b",
  mortise_tenon: "fbaddbf01dcae488b198ad93de6dd6e24843481d4ea2843987f81edfcf16f08e",
  half_lap: "e0aaa08d4b2851584135db7e9e930bbc4c09b61f68e8f624afe40190175cc74f",
  box_joint: "4425c7514ded48670b352dbf06032cf57d219559a78f18b4e2b28d7b24d9a2b9",
  through_slot: "52addace9b1b7db8d5f8c63f1cceac54ddbe802c313efca8007c4ed069ef7f1e",
};

describe("drawings of a design with no cuts", () => {
  it.each(["record console", ...JOINT_TYPES])("write the %s example's PDF exactly as before shapes were drawn", (name) => {
    const design = name === "record console" ? applyOps(emptyDesign("test"), recordConsoleOps()) : jointExample(name as JointType);
    const sheets = workshopDrawings(design, derive(design), { date: "5 October 2026" });
    const pdf = drawingsPdf(sheets, { title: design.name, now: new Date(Date.UTC(2026, 9, 5)), compress: false });
    expect(createHash("sha256").update(pdf).digest("hex")).toBe(BEFORE_SHAPES[name]);
  });
});
