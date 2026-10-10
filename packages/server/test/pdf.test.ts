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
// gap at either end of a row writes its number past the end since #86. The
// Domino example's mortises changed with #89, when every one in the host
// took the play. Since #92 a Domino mortise is placed by its centre, and a
// part laid out evenly along its length by its middle. Since #94 each part
// sheet names its face side and face edge and measures from them.
const BEFORE_SHAPES: Record<string, string> = {
  "record console": "2f3d5709a6b9d9cc7be0fbf868b745ef0c0f66c6a34854a4775b931928e956d7",
  butt: "1eb81e2e7bbe106f2e0eb6315098a4899b90768c65c8d850b5074f054e41caae",
  screws: "f58e01d718745c7a69658f9e8c01bdc9ac9e67c4d29bf3b8593c0d2bc5d9d6d7",
  pocket_screws: "53331144300212ce0d0fc52a16627fb68a36d8257d44e5dbd965ba2d2a87174b",
  dowels: "ac4c68488648a96908d17703e0dbda9257fbcf5a28302ede6ba87c087dffcb61",
  // Added with the joint, after shapes were drawn.
  domino: "1dd603e186bef02a0049e90db48c3f09bdeb1f974bb5489c55d728596cbf3e32",
  dado: "5b343f83c8b10c25ff5f135ac695741ef7f00bc8cdfdd208bca039281e79a973",
  groove: "fab065ae6cf01d2f70130f58cab42efdf5249240456288dffd06464eb6d31ec8",
  rabbet: "38a6b6a39d87fb65c0e6d0d26b241bee8905673b66c97b43ca07a36c453f9a37",
  tongue: "f6c736596da23211a0422b3415562d8640f4269fa6f1b50aab853feeda30c74d",
  // Added with the joint, after shapes were drawn.
  dado_rabbet: "47cdc3f03b83af21902abc464dae2468a8f2886289035b4ef889b284ca7d3ba7",
  mortise_tenon: "989d47e27a9f60c0c519f44a2b82856fe58c4049c70368505808628722c108fd",
  half_lap: "7897cc38e6c96f531ca9500aa72207e7d059a1dccbdd2651688b379bd21b1b8e",
  box_joint: "a1792284ba40589954fb6588e7ca449cd0de1f71b0351bf1b390dd2abf72710a",
  through_slot: "300944dcf0db5c570a4661eb91aa4f05753e57e8e4fc2c9d9d8a3aa0c10ecc50",
};

describe("drawings of a design with no cuts", () => {
  it.each(["record console", ...JOINT_TYPES])("write the %s example's PDF exactly as before shapes were drawn", (name) => {
    const design = name === "record console" ? applyOps(emptyDesign("test"), recordConsoleOps()) : jointExample(name as JointType);
    const sheets = workshopDrawings(design, derive(design), { date: "5 October 2026" });
    const pdf = drawingsPdf(sheets, { title: design.name, now: new Date(Date.UTC(2026, 9, 5)), compress: false });
    expect(createHash("sha256").update(pdf).digest("hex")).toBe(BEFORE_SHAPES[name]);
  });
});
