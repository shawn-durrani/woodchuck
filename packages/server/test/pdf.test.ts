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

// The PDF of every example, as main wrote it before shapes were drawn.
const BEFORE_SHAPES: Record<string, string> = {
  "record console": "2a9d5cee04b4a6eb8c4f51dfe180522a961fb797280c37250647bcbe96f26c3f",
  butt: "f1eb6f19df7728df7d8a068382ab391d123907ebacec70743157f88cf509f747",
  screws: "803d2a16259953f7b9d262efccdc427f25ab6f4251c829ed00d4eee04b10618e",
  pocket_screws: "c52d7783874fd4deeb5a6a501f97bd2449e455b4ec083077b65dbedacf2eb543",
  dowels: "1dcd13588e9c21e47f040f571eadca47de6e1febc4f9509dac10723fcc5805fd",
  dado: "108ebad37c7e5af5ba3a0f1338f22778ac5a59bfda8228023f05fb076d0ab50e",
  groove: "f1f5ce2d1cb076a2a949509cb355f4c95af0aae5ff614113632b80d40c96648b",
  rabbet: "4f3d853234c6f3e3e3b1ebd7df7abf11e18d692b4022b183d307170550861b29",
  tongue: "152c43fbe011bbfd93a1c734b2ae553c8cbcf796bbc7d2b32cd94c35a4dbe4da",
  mortise_tenon: "ec57d93f73afe2af11f91d981111dc6dca5ebbdc981608d0625eb25c617cd641",
  half_lap: "f1489b86cde32e44d5457b486de6405fe4b427e7a20d36d71d02b6c1c2c766f7",
  box_joint: "911218f4bd54b5bca2cf0dc8587dde1d6d5ee7d812891aaa20d16004774f0219",
  through_slot: "dccfd7a46485623649848722a9ebed8287ccbcd1bbd94f389bd6fb84628fb9d4",
};

describe("drawings of a design with no cuts", () => {
  it.each(["record console", ...JOINT_TYPES])("write the %s example's PDF exactly as before shapes were drawn", (name) => {
    const design = name === "record console" ? applyOps(emptyDesign("test"), recordConsoleOps()) : jointExample(name as JointType);
    const sheets = workshopDrawings(design, derive(design), { date: "5 October 2026" });
    const pdf = drawingsPdf(sheets, { title: design.name, now: new Date(Date.UTC(2026, 9, 5)), compress: false });
    expect(createHash("sha256").update(pdf).digest("hex")).toBe(BEFORE_SHAPES[name]);
  });
});
