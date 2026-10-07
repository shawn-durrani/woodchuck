// What another chat reads with a screenshot of the window: what it's
// looking at, in words, so it knows the angle, what's apart and what's
// picked. The design's name is invented.

import { describe, expect, it } from "vitest";
import { describeWindow, type WindowView } from "../src/screenshot.js";

const base: WindowView = {
  design: "Fairhaven bench",
  mode: "3d",
  view: "iso",
  planView: "front",
  look: "plain",
  seeThrough: false,
  explode: null,
  joint: null,
  section: null,
  picked: [],
  inPhoto: false,
  withPhoto: false,
};

describe("the words with a screenshot", () => {
  it("say the window shows the model from the woodworker's own angle", () => {
    expect(describeWindow(base)).toBe("The Fairhaven bench window shows the 3D model in the Plain look, from the woodworker's own camera angle, starting from the iso view.");
  });

  it("say what's apart, what's picked, see-through and the room photo", () => {
    expect(describeWindow({ ...base, explode: 1, seeThrough: true, picked: ["leg_fl", "rail_front"], look: "finished" })).toBe(
      "The Fairhaven bench window shows the 3D model in the Finished look, from the woodworker's own camera angle, starting from the iso view, the piece pulled apart, see-through on and leg_fl, rail_front picked.",
    );
    expect(describeWindow({ ...base, explode: 0.4 })).toContain("the piece partly pulled apart");
    expect(describeWindow({ ...base, picked: ["a", "b", "c", "d", "e"] })).toContain("a, b, c and 2 more picked");
    expect(describeWindow({ ...base, inPhoto: true })).toContain("placed in the room photo, which is left out of the picture");
    expect(describeWindow({ ...base, inPhoto: true, withPhoto: true })).toMatch(/placed in the room photo\.$/);
  });

  it("say a joint is pulled apart on its own, and that its section is the second picture", () => {
    const s = describeWindow({ ...base, explode: 1, joint: "rail_in_leg", section: "rail_in_leg" });
    expect(s).toContain("joint rail_in_leg pulled apart on its own, with the rest faded");
    expect(s).not.toContain("the piece pulled apart");
    expect(s).toMatch(/The second picture is joint rail_in_leg cut through, with its sizes, as the drawer beside the model shows it\.$/);
  });

  it("name the plan view in 2D", () => {
    expect(describeWindow({ ...base, mode: "2d", planView: "top" })).toBe("The Fairhaven bench window shows the top plan view, a 2D drawing with its sizes.");
  });
});
