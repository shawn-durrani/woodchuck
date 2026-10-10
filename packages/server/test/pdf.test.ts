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
// drawings gained the cutting plan and the cut list's Board column with #78,
// and named each part's sides as they sit in the piece with #80. A narrow
// gap at either end of a row writes its number past the end since #86.
const BEFORE_SHAPES: Record<string, string> = {
  "record console": "92453dd1db3408727fe81f9d35c8e67e2f8e9aed1b5b668e45ff63b542280c35",
  butt: "e9629fa333142c64ba52a3f2bba474f5026a710145e60da8ce60b3d73fdae830",
  screws: "ce206032ca47506c07879a1703a76d05a5a83a046dd3a7912e39c0a5ad0ae889",
  pocket_screws: "3209c886b2591ef45146ec84a5d75ce45382aa55754542d4d1aa11f28332bf3f",
  dowels: "ffdfa3bf62672f222be29393bb6c0e12459decc62f890bb8cc987f2c6a8a49ed",
  // Added with the joint, after shapes were drawn.
  domino: "93fd1e216e8ede1e6e4bc79b021971935a21ec757f16bee2e690652bdf137294",
  dado: "cf68edb11e2fb40ff1a2475ece4b98e5f42bf3b8edb4fe61e38843957a62a52e",
  groove: "c6fb06fcfff8103fcc7e8a268fa8caed598d6ea150ab3d3dfaa9283b1dff00dc",
  rabbet: "4bbdb1b2d9a242313fa4411ad9a93457a465f39414be6e08a2d68d727af0acc2",
  tongue: "f8664d44315162cd9f38721935dcfb29de8aa65b634ab252f7aa81e976372b8c",
  // Added with the joint, after shapes were drawn.
  dado_rabbet: "bbf3d20679d9b0408864e4d7b94a6aa72633d7604f21adb8d304a55337663095",
  mortise_tenon: "1a324cc4e6b71f8df91ae87e8c4e1373d3f12c17dbd0e8035d89f2d4a5ad229d",
  half_lap: "4ea7edb65591a4a381a32b62550d098d845045b4f81416d60a169f27e7e4ea40",
  box_joint: "fca517d06aac7e821db09010fc4689e5586c65c7a3d6e000376673f5b9a091c8",
  through_slot: "8426c1235bbf5b204c1eda2d2af7d7c6a541a67de24eb33988aa03910465593f",
};

describe("drawings of a design with no cuts", () => {
  it.each(["record console", ...JOINT_TYPES])("write the %s example's PDF exactly as before shapes were drawn", (name) => {
    const design = name === "record console" ? applyOps(emptyDesign("test"), recordConsoleOps()) : jointExample(name as JointType);
    const sheets = workshopDrawings(design, derive(design), { date: "5 October 2026" });
    const pdf = drawingsPdf(sheets, { title: design.name, now: new Date(Date.UTC(2026, 9, 5)), compress: false });
    expect(createHash("sha256").update(pdf).digest("hex")).toBe(BEFORE_SHAPES[name]);
  });
});
