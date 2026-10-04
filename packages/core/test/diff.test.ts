import { describe, expect, it } from "vitest";
import { applyOp, applyOps, diffDesigns, emptyDesign, recordConsoleOps } from "../src/index.js";

describe("what changed between versions", () => {
  const before = applyOps(emptyDesign("t"), recordConsoleOps());

  it("says nothing when nothing changed", () => {
    expect(diffDesigns(before, before)).toEqual([]);
  });

  it("names a parameter change with its old and new values", () => {
    const after = applyOp(before, { op: "set_param", name: "drawers", expr: "4", unit: "count" });
    expect(diffDesigns(before, after)).toEqual(["Changed drawers from 5 to 4"]);
  });

  it("lists added and removed parts and joints", () => {
    const after = applyOps(before, [
      { op: "delete_joint", id: "front_to_box" },
      { op: "add_joint", id: "front_to_box", type: "pocket_screws", host: "false_front", guest: "drawer_box_front" },
      { op: "rename_design", name: "Console 2" },
    ]);
    expect(diffDesigns(before, after)).toEqual(['Renamed "Record console" to "Console 2"', "Changed joint front_to_box: count, type"]);
  });

  it("covers a whole new design", () => {
    const lines = diffDesigns(emptyDesign("Record console"), before);
    expect(lines).toContain("Added part left_side (Left side)");
    expect(lines).toContain("Added parameter drawers = 5");
  });
});
