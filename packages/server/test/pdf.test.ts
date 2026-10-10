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
// sheet names its face side and face edge and measures from them. Since
// #96 the notes are left off unless asked, a V marks the face edge, and
// every Domino gets a detail with its machine setup.
const BEFORE_SHAPES: Record<string, string> = {
  "record console": "7918a5c1793c5fb1a9f7fe59f8c0b6523d67d3df58e53d0c6a519d5788a6ee25",
  butt: "4b4558f079b98370a1590f39d834c03a022da49939fbe7290a78847ea86c076b",
  screws: "530e71e5de7bd5fb8bcc0e8a9ca197780df08602fda171b9e696de519fda5f29",
  pocket_screws: "7c73b6dac681e03d1e8760a8127bd39ee03eebcf6dc2c08572c6bd8a1c234e12",
  dowels: "0d2756a3e2731b957d0ac0a0a436ca9d53177e5fd924f06eb948d96c4b9bc0f7",
  // Added with the joint, after shapes were drawn.
  domino: "b2db72240d4ba8947081cfc84317488a25410ba166fb0cb276ee557e9256b281",
  dado: "857c19a6d8cfafc570d53fbcb4bf95002952d9911850686f70b60693f999146d",
  groove: "ebb5aa6a8a415f5c8d9e396598943c17421627c1194ea454c5e0b1af1a796e1d",
  rabbet: "a80cb55d119e906970249237839a64f34261a01f1d5e94ba5242d3978fa4dccc",
  tongue: "7908cd0cb11a8279e36faba4e42acffc5fe4484d08d315b4875f2e516c89995b",
  // Added with the joint, after shapes were drawn.
  dado_rabbet: "365232e64b65a24e4158bd7c03b3032c066483fdabc2910ff256dce389b349bf",
  mortise_tenon: "8fed11c0a7d01751d124b65271157cd964e7c62455ec37d4315c7471df23063d",
  half_lap: "7fb766ca974bd38fce38ef6ead4ac323819472323ec46422df2a4353847e04af",
  box_joint: "7158538de29cdc26216690912de1095d1e52bfa92964aa0d532a5b84a0e7032d",
  through_slot: "e974ef0a8309126bf5caefdf7701eb4709e7f288145f7a0f9512e87e983eda34",
};

describe("drawings of a design with no cuts", () => {
  it.each(["record console", ...JOINT_TYPES])("write the %s example's PDF exactly as before shapes were drawn", (name) => {
    const design = name === "record console" ? applyOps(emptyDesign("test"), recordConsoleOps()) : jointExample(name as JointType);
    const sheets = workshopDrawings(design, derive(design), { date: "5 October 2026" });
    const pdf = drawingsPdf(sheets, { title: design.name, now: new Date(Date.UTC(2026, 9, 5)), compress: false });
    expect(createHash("sha256").update(pdf).digest("hex")).toBe(BEFORE_SHAPES[name]);
  });
});
