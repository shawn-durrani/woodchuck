// Issue #94: each part is marked out and measured from a face side and a
// face edge, chosen from its front, the side facing someone standing in
// front of the piece. The parts are invented boxes in a piece whose middle
// is 500 from its left.

import { describe, expect, it } from "vitest";
import { referenceFaces, type Axis } from "../src/index.js";

type Shape = Parameters<typeof referenceFaces>[0];
const part = (thickness_axis: Axis, width_axis: Axis, x0 = 400, x1 = 600, profile?: unknown): Shape =>
  ({ thickness_axis, width_axis, nominal: { min: [x0, 0, 0], max: [x1, 100, 100] }, profile }) as unknown as Shape;

describe("a part's face side and face edge", () => {
  it("take a part's front as its face side when its front is a broad face", () => {
    // A door or a brace: the top edge, or the left edge when it stands upright.
    expect(referenceFaces(part("z", "y"), 500)).toEqual({ side: "front", edge: "top" });
    expect(referenceFaces(part("z", "x"), 500)).toEqual({ side: "front", edge: "left" });
  });

  it("take a part's front as its face edge when its front is an edge", () => {
    // A rail lying flat: its top face.
    expect(referenceFaces(part("y", "z"), 500)).toEqual({ side: "top", edge: "front" });
    // An upright side or stile: its outside face, away from the middle of the piece.
    expect(referenceFaces(part("x", "z", 0, 19), 500)).toEqual({ side: "left", edge: "front" });
    expect(referenceFaces(part("x", "z", 981, 1000), 500)).toEqual({ side: "right", edge: "front" });
  });

  it("take a drawer side's top edge and outside face, since its front is an end", () => {
    expect(referenceFaces(part("x", "y", 900, 915), 500)).toEqual({ side: "right", edge: "top" });
  });

  it("move the face edge off an edge a slope cuts, to the straight edge opposite", () => {
    const sloped = { outline_mm: [[0, 0], [380, 0], [380, 80], [0, 150]], edge_faces: ["bottom", "right", "top", "left"] };
    expect(referenceFaces(part("z", "y", 400, 600, sloped), 500)).toEqual({ side: "front", edge: "bottom" });
    const square = { outline_mm: [[0, 0], [380, 0], [380, 150], [0, 150]], edge_faces: ["bottom", "right", "top", "left"] };
    expect(referenceFaces(part("z", "y", 400, 600, square), 500)).toEqual({ side: "front", edge: "top" });
  });
});
