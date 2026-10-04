import { describe, expect, it } from "vitest";
import { facesOf, finishTargets, partsInRect } from "../src/select.js";

// A straight-on front view: 1 mm is 1 px, and y runs down the screen.
const front = (p: [number, number, number]) => ({ x: p[0], y: 1000 - p[1], behind: p[2] > 5000 });
const box = (id: string, min: [number, number, number], max: [number, number, number]) => ({ id, nominal: { min, max } });

const parts = [
  box("left", [0, 0, 0], [18, 600, 300]),
  box("shelf", [18, 300, 0], [582, 318, 300]),
  box("right", [582, 0, 0], [600, 600, 300]),
  box("far", [100, 100, 6000], [200, 200, 6100]),
];

describe("box select", () => {
  it("picks the parts whose middle is inside the box, dragged either way", () => {
    expect(partsInRect(parts, front, { x0: -10, y0: 1010, x1: 320, y1: 600 })).toEqual(["left", "shelf"]);
    expect(partsInRect(parts, front, { x0: 320, y0: 600, x1: -10, y1: 1010 })).toEqual(["left", "shelf"]);
  });

  it("skips parts behind the camera", () => {
    expect(partsInRect(parts, front, { x0: 0, y0: 0, x1: 1000, y1: 1000 })).not.toContain("far");
  });

  it("treats a click as no box", () => {
    expect(partsInRect(parts, front, { x0: 300, y0: 690, x1: 302, y1: 691 })).toEqual([]);
  });
});

describe("faces", () => {
  it("takes every face of the parts in a box", () => {
    expect(facesOf(["shelf"])).toEqual(["shelf.left", "shelf.right", "shelf.bottom", "shelf.top", "shelf.back", "shelf.front"]);
  });

  it("names an array's original on its own as #1", () => {
    const parts = [
      { id: "side", source: "side", copy: 1 },
      { id: "front", source: "front", copy: 1 },
      { id: "front#2", source: "front", copy: 2 },
    ];
    expect(finishTargets(["side", "front", "front#2.top", "front.left"], parts)).toEqual(["side", "front#1", "front#2.top", "front#1.left"]);
  });
});
