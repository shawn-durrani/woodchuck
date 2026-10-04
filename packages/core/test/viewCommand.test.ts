import { describe, expect, it } from "vitest";
import { describeView, readViewCommand } from "../src/index.js";

describe("view commands from outside the window", () => {
  it("keeps what it knows and says it in words", () => {
    const c = readViewCommand({ look: "finished", lighting: "evening", view: "front", select: ["shelf_2"], from: "Crossband", extra: 1 });
    expect(c).toEqual({ look: "finished", lighting: "evening", view: "front", select: ["shelf_2"], from: "Crossband" });
    expect(describeView(c)).toBe("the Finished look, evening light, the front view and shelf_2 picked");
    expect(describeView(readViewCommand({ drawer: { joint: "half_lap" } }))).toBe("a worked half lap open");
    expect(describeView(readViewCommand({ fill: false }))).toBe("the panels back");
  });

  it("turns, zooms, switches to the plan views and renders", () => {
    const c = readViewCommand({ mode: "plan", turn: -30, zoom: 1.5, seeThrough: true, photo: false, render: true });
    expect(c).toEqual({ mode: "plan", turn: -30, zoom: 1.5, seeThrough: true, photo: false, render: true });
    expect(describeView(c)).toBe("the plan views, turned 30° to the left, zoomed in, see-through on and the photo put away, then a picture saved");
    expect(describeView(readViewCommand({ render: true }))).toBe("a picture saved");
    expect(() => readViewCommand({ zoom: 50 })).toThrow(/zoom must be/);
    expect(() => readViewCommand({ turn: "lots" })).toThrow(/turn must be/);
  });

  it("refuses values it doesn't know, and an empty request", () => {
    expect(() => readViewCommand({ look: "shiny" })).toThrow(/look "shiny"/);
    expect(() => readViewCommand({ drawer: { joint: "bridle" } })).toThrow(/drawer must be/);
    expect(() => readViewCommand({ select: "shelf_2" })).toThrow(/list of part ids/);
    expect(() => readViewCommand({ from: "Crossband" })).toThrow(/Say what to change/);
  });
});
