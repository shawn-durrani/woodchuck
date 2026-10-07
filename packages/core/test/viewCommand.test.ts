import { describe, expect, it } from "vitest";
import { describeView, ORBIT_SPEED, readViewCommand, SIDE_TABS } from "../src/index.js";

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

  it("pulls the piece apart, or one of its joints, and puts it back together (#66)", () => {
    expect(readViewCommand({ explode: 1 })).toEqual({ explode: 1 });
    expect(describeView(readViewCommand({ explode: 1 }))).toBe("the piece pulled apart");
    expect(describeView(readViewCommand({ explode: 0.5 }))).toBe("the piece partly pulled apart");
    expect(describeView(readViewCommand({ explode: 0 }))).toBe("the piece back together");
    expect(readViewCommand({ focusJoint: "shelf_dado#2" })).toEqual({ focusJoint: "shelf_dado#2" });
    expect(describeView(readViewCommand({ focusJoint: "rail_in_leg", explode: 1 }))).toBe("joint rail_in_leg pulled apart, with its section and sizes");
    expect(describeView(readViewCommand({ focusJoint: "" }))).toBe("the whole piece back together");
    expect(describeView(readViewCommand({ focusJoint: "", explode: 1 }))).toBe("the whole piece pulled apart");
    expect(() => readViewCommand({ explode: 2 })).toThrow(/explode must be between 0, together, and 1, fully apart/);
    expect(() => readViewCommand({ focusJoint: "Rail In Leg" })).toThrow(/focusJoint must be a joint id/);
    // The plan views and the room photo show the piece together.
    expect(() => readViewCommand({ explode: 1, mode: "plan" })).toThrow(/can't go with the plan views/);
    expect(() => readViewCommand({ focusJoint: "rail_in_leg", photo: true })).toThrow(/room photo shows the piece together/);
    expect(readViewCommand({ explode: 0, mode: "plan" })).toEqual({ explode: 0, mode: "plan" });
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

  // Seen in a demo: another chat had to ask Woodchuck's Claude for the cut list, since it couldn't open Make.
  it("opens a side panel tab by its name on screen", () => {
    expect(SIDE_TABS).toEqual(["edit", "finish", "make", "check", "history"]);
    const make = readViewCommand({ tab: "make", from: "Crossband" });
    expect(make).toEqual({ tab: "make", from: "Crossband" });
    expect(describeView(make)).toBe("the Make tab open");
    expect(describeView(readViewCommand({ look: "finished", tab: "finish" }))).toBe("the Finished look and the Finish tab open");
    expect(describeView(readViewCommand({ select: ["shelf_2"], tab: "history" }))).toBe("shelf_2 picked and the History tab open");
    expect(() => readViewCommand({ tab: "cut list" })).toThrow('tab "cut list" isn\'t one of edit, finish, make, check, history');
    expect(() => readViewCommand({ tab: "Make" })).toThrow(/tab "Make" isn't one of/);
    // Filling the window hides the side panel, so the two can't go together.
    expect(() => readViewCommand({ tab: "check", fill: true })).toThrow(/can't go with fill/);
    expect(readViewCommand({ tab: "check", fill: false })).toEqual({ fill: false, tab: "check" });
  });

  it("refuses values it doesn't know, and an empty request", () => {
    expect(() => readViewCommand({ look: "shiny" })).toThrow(/look "shiny"/);
    expect(() => readViewCommand({ drawer: { joint: "bridle" } })).toThrow(/drawer must be/);
    expect(() => readViewCommand({ select: "shelf_2" })).toThrow(/list of part ids/);
    expect(() => readViewCommand({ from: "Crossband" })).toThrow(/Say what to change: .*drawer, tab or render/);
  });
});
