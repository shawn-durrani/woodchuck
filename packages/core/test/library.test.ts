import { describe, expect, it } from "vitest";
import {
  applyOp,
  applyOps,
  derive,
  emptyDesign,
  placeBox,
  recordConsoleOps,
  runChecks,
  validateLibraryPart,
  type Design,
} from "../src/index.js";

const slide = (thickness: number) => ({
  id: "acmeco-glide-450",
  name: "AcmeCo Glide 450 side-mount slide",
  kind: "drawer_slide",
  maker: "AcmeCo",
  sources: [{ url: "https://example.com/acmeco-glide", title: "AcmeCo Glide spec sheet" }],
  specs: { length_mm: 450, clearance_per_side_mm: thickness, load_kg: 45 },
  shape: [{ name: "slide", min_mm: [0, 0, 0], max_mm: [450, 45, thickness] }],
});

describe("library parts", () => {
  it("accepts a well-formed part", () => {
    expect(validateLibraryPart(slide(12.7)).specs).toEqual({ length_mm: 450, clearance_per_side_mm: 12.7, load_kg: 45 });
  });

  it("explains what's wrong with a bad one", () => {
    expect(() => validateLibraryPart({ ...slide(12.7), id: "Acme Glide" })).toThrow(/a-z, 0-9 and -/);
    expect(() => validateLibraryPart({ ...slide(12.7), sources: [] })).toThrow(/where the numbers came from/);
    expect(() => validateLibraryPart({ ...slide(12.7), kind: "rocket" })).toThrow(/Use one of/);
    expect(() => validateLibraryPart({ ...slide(12.7), shape: [{ name: "x", min_mm: [0, 0, 0], max_mm: [0, 1, 1] }] })).toThrow(/below its max_mm/);
    expect(() => validateLibraryPart({ ...slide(12.7), sources: [{ url: "ftp://x" }] })).toThrow(/http/);
  });

  it("turns a model so its length runs along any axis", () => {
    const b = { name: "s", min_mm: [0, 0, 0] as [number, number, number], max_mm: [450, 45, 12.7] as [number, number, number] };
    expect(placeBox(b, [30, 100, 32], "z")).toEqual({ min: [30, 100, 32], max: [42.7, 145, 482] });
    expect(placeBox(b, [0, 0, 0], "y")).toEqual({ min: [0, 0, 0], max: [45, 450, 12.7] });
  });
});

describe("placed hardware", () => {
  const withSlide = (thickness: number): Design => {
    const part = validateLibraryPart(slide(thickness));
    return applyOp(applyOps(emptyDesign("t"), recordConsoleOps()), {
      op: "set_hardware",
      id: "slides",
      kind: part.kind,
      name: part.name,
      connects: ["drawer_side_l", "drawer_side_r", "bottom"],
      qty: 1,
      spec: part.specs,
      library_part: part.id,
      shape: part.shape,
      place: { x: "left_side.right", y: "drawer_side_l.bottom + 100", z: "drawer_side_l.front - 450", length_axis: "z" },
    });
  };

  it("sits in the gap beside each drawer, moving with the array", () => {
    const d = withSlide(12.7);
    const r = derive(d);
    const boxes = r.hardware.map((h) => h.boxes[0]!);
    expect(boxes).toHaveLength(5);
    expect(boxes[0]).toEqual({ min: [30, 145, 52], max: [42.7, 190, 502] });
    expect(boxes[1]!.min[0]).toBeCloseTo(432, 6);
    expect(r.hardware[0]!.library_part).toBe("acmeco-glide-450");
    expect(runChecks(d, r).issues.filter((i) => i.code === "hardware_overlap")).toEqual([]);
  });

  it("flags a slide too thick for its gap", () => {
    const d = withSlide(13);
    const hits = runChecks(d, derive(d)).issues.filter((i) => i.code === "hardware_overlap");
    expect(hits[0]!.message).toMatch(/runs into drawer_side_l by 0.3 × 45 × 450 mm/);
  });
});
