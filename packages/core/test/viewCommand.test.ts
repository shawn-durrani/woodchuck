import { describe, expect, it } from "vitest";
import { describeView, ORBIT_SPEED, readViewCommand } from "../src/index.js";

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

  it("starts a slow orbit at the default speed, or the one asked for, and stops it", () => {
    const c = readViewCommand({ orbit: "start", from: "Crossband" });
    expect(c).toEqual({ orbit: "start", orbitSpeed: ORBIT_SPEED.default, from: "Crossband" });
    expect(describeView(c)).toBe("the model turning 12° a second to the right");
    expect(describeView(readViewCommand({ orbit: "start", orbitSpeed: -20, look: "finished" }))).toBe("the Finished look and the model turning 20° a second to the left");
    expect(readViewCommand({ orbit: "start", orbitSpeed: "8" }).orbitSpeed).toBe(8);
    // A camera view with it starts the orbit from there.
    expect(readViewCommand({ orbit: "start", view: "front" })).toEqual({ orbit: "start", orbitSpeed: 12, view: "front" });
    const stop = readViewCommand({ orbit: "stop" });
    expect(stop).toEqual({ orbit: "stop" });
    expect(describeView(stop)).toBe("the model held still");
  });

  it("keeps an orbit's speed within bounds, and out of the plan views and the room photo", () => {
    expect(() => readViewCommand({ orbit: "start", orbitSpeed: 0 })).toThrow(/orbitSpeed must be between 1 and 60/);
    expect(() => readViewCommand({ orbit: "start", orbitSpeed: 400 })).toThrow(/orbitSpeed must be/);
    expect(() => readViewCommand({ orbit: "start", orbitSpeed: "fast" })).toThrow(/orbitSpeed must be/);
    expect(() => readViewCommand({ orbitSpeed: 10 })).toThrow(/goes with orbit "start"/);
    expect(() => readViewCommand({ orbit: "stop", orbitSpeed: 10 })).toThrow(/goes with orbit "start"/);
    expect(() => readViewCommand({ orbit: "spin" })).toThrow(/orbit "spin" isn't one of start, stop/);
    expect(() => readViewCommand({ orbit: "start", mode: "plan" })).toThrow(/can't go with the plan views/);
    expect(() => readViewCommand({ orbit: "start", photo: true })).toThrow(/room photo/);
    // Stopping is fine anywhere.
    expect(readViewCommand({ orbit: "stop", mode: "plan" })).toEqual({ mode: "plan", orbit: "stop" });
  });

  it("refuses values it doesn't know, and an empty request", () => {
    expect(() => readViewCommand({ look: "shiny" })).toThrow(/look "shiny"/);
    expect(() => readViewCommand({ drawer: { joint: "bridle" } })).toThrow(/drawer must be/);
    expect(() => readViewCommand({ select: "shelf_2" })).toThrow(/list of part ids/);
    expect(() => readViewCommand({ from: "Crossband" })).toThrow(/Say what to change/);
  });
});
