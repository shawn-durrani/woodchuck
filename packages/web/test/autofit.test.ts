// When the 3D view frames the model again by itself: on a design switch,
// a resize, or a change that takes the model past the frame or shrinks it
// into a corner, and never during a drag.

import { describe, expect, it } from "vitest";
import { autoFit, framing, pastFrame, type FitEvent, type FitMemory } from "../src/autofit.js";

const look = (over: Partial<Extract<FitEvent, { kind: "look" }>> = {}): FitEvent => ({ kind: "look", design: "reading-bench", width: 688, height: 815, overflow: false, ...over });

/** Plays events in turn, returning the fit each one made. */
function play(events: FitEvent[], from: FitMemory | null = null) {
  let m = from;
  const fits = events.map((e) => {
    const r = autoFit(m, e);
    m = r.memory;
    return r.fit;
  });
  return { fits, memory: m! };
}

/** A design that's open and framed, at 1440 × 900 with both panels showing. */
const framed = play([look()]).memory;

describe("fitting the model again by itself", () => {
  it("frames a design when it opens, and leaves it alone when nothing changed", () => {
    expect(play([look()]).fits).toEqual(["design"]);
    expect(play([look(), look(), look()]).fits).toEqual(["design", null, null]);
  });

  it("frames the new design on a switch, and a design's first parts", () => {
    expect(play([look({ design: "bedside-table" })], framed).fits).toEqual(["design"]);
    expect(play([look({ design: "new-design:empty" }), look({ design: "new-design" })]).fits).toEqual(["design", "design"]);
  });

  it("frames again when the view changes size, as when both panels fold", () => {
    expect(play([look({ width: 1396 })], framed).fits).toEqual(["resized"]);
    expect(play([look({ width: 1440, height: 900 })], framed).fits).toEqual(["resized"]);
    // A scrollbar's worth of rounding isn't a resize.
    expect(play([look({ width: 690 })], framed).fits).toEqual([null]);
  });

  it("keeps a view you've turned yourself through a resize, unless the model no longer fits", () => {
    const turned = play([{ kind: "hold" }, { kind: "release", overflow: false, turned: true }], framed).memory;
    expect(turned.moved).toBe(true);
    expect(play([look({ width: 1396 })], turned).fits).toEqual([null]);
    expect(play([look({ width: 528, overflow: true })], turned).fits).toEqual(["resized"]);
  });

  it("frames again when a change takes the model past the frame", () => {
    expect(play([look({ overflow: true })], framed).fits).toEqual(["grew"]);
    // A change that stays inside the frame leaves the camera where it is.
    expect(play([look(), look()], framed).fits).toEqual([null, null]);
  });

  it("frames a model that shrinks into a corner, as after undoing a taller bookcase, unless you've turned the view", () => {
    expect(play([look({ overflow: true }), look({ small: true })], framed).fits).toEqual(["grew", "shrank"]);
    const turned = play([{ kind: "hold" }, { kind: "release", overflow: false, turned: true }], framed).memory;
    expect(play([look({ small: true })], turned).fits).toEqual([null]);
    // Framed again, it stays put.
    expect(play([look({ small: true }), look()], framed).fits).toEqual(["shrank", null]);
  });

  it("doesn't count a model you'd zoomed into as growing", () => {
    const zoomed = play([{ kind: "hold" }, { kind: "release", overflow: true, turned: true }], framed).memory;
    expect(play([look({ overflow: true })], zoomed).fits).toEqual([null]);
  });

  it("never fits during a drag or a turn, and catches up when you let go", () => {
    const held = play([{ kind: "hold" }], framed).memory;
    expect(play([look({ design: "bedside-table" })], held).fits).toEqual([null]);
    expect(play([look({ width: 1396 })], held).fits).toEqual([null]);
    expect(play([look({ overflow: true })], held).fits).toEqual([null]);
    // A new design frames as soon as the drag ends.
    expect(play([look({ design: "bedside-table" }), { kind: "release", overflow: false, turned: true }], held).fits).toEqual([null, "design"]);
    // Growth during a turn frames after it only if the model is still past the edge.
    expect(play([look({ overflow: true }), { kind: "release", overflow: true, turned: true }], held).fits).toEqual([null, "grew"]);
    expect(play([look({ overflow: true }), { kind: "release", overflow: false, turned: true }], held).fits).toEqual([null, null]);
    // A design switch outranks growth that waited with it.
    expect(play([look({ overflow: true }), look({ design: "bedside-table" }), { kind: "release", overflow: false, turned: true }], held).fits).toEqual([null, null, "design"]);
  });

  it("doesn't count a box select as turning the view", () => {
    const boxed = play([{ kind: "hold" }, { kind: "release", overflow: false, turned: false }], framed).memory;
    expect(boxed.moved).toBe(false);
    expect(play([look({ width: 1396 })], boxed).fits).toEqual(["resized"]);
  });

  it("starts afresh after Fit or a camera view", () => {
    const turned = play([{ kind: "hold" }, { kind: "release", overflow: true, turned: true }], framed).memory;
    const refit = play([{ kind: "fitted", design: "reading-bench", width: 688, height: 815 }], turned).memory;
    expect(refit).toMatchObject({ moved: false, overflow: false, pending: null });
    expect(play([look({ width: 1396 })], refit).fits).toEqual(["resized"]);
  });

  it("knows when a model reaches past the frame", () => {
    expect(pastFrame([[0, 0, 0.5], [0.9, -0.9, 0.5]])).toBe(false);
    expect(pastFrame([[0, 0, 0.5], [1.2, 0, 0.5]])).toBe(true);
    expect(pastFrame([[0, -1.05, 0.5]])).toBe(true);
    // A corner behind the camera is past the frame too.
    expect(pastFrame([[0, 0, 1.4]])).toBe(true);
    // A fitted model fills most of the frame one way; one in a corner fills little of it either way.
    expect(framing([[-0.85, -0.5, 0.5], [0.85, 0.5, 0.5]])).toEqual({ overflow: false, small: false });
    expect(framing([[-0.9, 0.1, 0.5], [-0.2, 0.6, 0.5]])).toEqual({ overflow: false, small: true });
    expect(framing([[-1.3, 0.1, 0.5], [-0.2, 0.6, 0.5]])).toEqual({ overflow: true, small: false });
  });
});
