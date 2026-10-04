// The record console acceptance test in docs/TESTING.md, built only from the
// deterministic operations.

import { describe, expect, it } from "vitest";
import {
  applyOp,
  applyOps,
  cutList,
  derive,
  emptyDesign,
  explain,
  recordConsoleOps,
  runChecks,
  type Design,
} from "../src/index.js";

function build(): Design {
  return applyOps(emptyDesign("test"), recordConsoleOps());
}

const inside = (d: Design, k = 1) => {
  const r = derive(d);
  const suffix = k === 1 ? "" : `#${k}`;
  return r.evaluate(`drawer_side_r${suffix}.left - drawer_side_l${suffix}.right`).value as number;
};

describe("record console", () => {
  it("has five 372 mm openings", () => {
    const d = derive(build());
    expect(d.params.bay).toMatchObject({ value: 372 });
    expect(d.evaluate("partition.left - left_side.right").value).toBe(372);
    expect(d.evaluate("partition#2.left - partition.right").value).toBe(372);
    expect(d.evaluate("right_side.left - partition#4.right").value).toBe(372);
  });

  it("leaves 316.6 mm inside each drawer with side-mount slides, so the LP check fails", () => {
    const design = build();
    for (let k = 1; k <= 5; k++) expect(inside(design, k)).toBeCloseTo(316.6, 6);
    const report = runChecks(design, derive(design));
    const lp = report.issues.find((i) => i.code === "rule_failed");
    expect(lp?.severity).toBe("error");
    expect(lp?.trace).toBe("drawer_side_r.left (374.3) - drawer_side_l.right (57.7) >= lp_clear (320)");
    expect(report.ready_to_cut).toBe(false);
  });

  it("has no other problems", () => {
    const design = build();
    const report = runChecks(design, derive(design));
    expect(report.issues.filter((i) => i.code !== "rule_failed")).toEqual([]);
  });

  it("passes with undermount slides, and only the drawer boxes change", () => {
    const before = build();
    const after = applyOp(before, { op: "set_param", name: "slide_gap", expr: "5", unit: "mm" });
    expect(inside(after)).toBeCloseTo(332, 6);
    const report = runChecks(after, derive(after));
    expect(report.errors).toBe(0);
    expect(report.ready_to_cut).toBe(true);

    const rows = (d: Design) => cutList(d, derive(d)).rows.map((r) => `${r.name} ${r.qty} ${r.length_mm}x${r.width_mm}x${r.thickness_mm}`);
    const changed = rows(after).filter((r) => !rows(before).includes(r));
    expect(changed.sort()).toEqual([
      "Drawer bottom 5 453x342x6",
      "Drawer box back 5 342x340x15",
      "Drawer box front 5 342x340x15",
    ]);
  });

  it("follows a new top length through every opening and part", () => {
    const d = applyOp(build(), { op: "set_param", name: "top_length", expr: "2100", unit: "mm" });
    const r = derive(d);
    expect(r.params.bay).toMatchObject({ value: 384 });
    expect(r.evaluate("right_side.left - partition#4.right").value).toBe(384);
    expect(inside(d, 5)).toBeCloseTo(328.6, 6);
  });

  it("lengthens housed parts and lists the housings on their hosts", () => {
    const r = derive(build());
    const bottom = r.byId.get("bottom")!;
    expect(bottom.finished.length).toBe(1980);
    expect(bottom.cut.length).toBe(2000);
    const partition = r.byId.get("partition#3")!;
    expect(partition.cut.length).toBe(380);
    expect(r.byId.get("bottom")!.machining.filter((m) => m.type === "dado")).toHaveLength(4);
    expect(explain(build(), r, "bottom")).toContain("Cut length 2000 = visible 1980 + 10 into left_side (bottom_in_left) + 10 into right_side (bottom_in_right)");
  });

  it("groups identical parts and keeps mirror images apart", () => {
    const d = build();
    const list = cutList(d, derive(d));
    const byName = (n: string) => list.rows.filter((r) => r.name === n);
    expect(byName("Partition")).toMatchObject([{ qty: 4, length_mm: 380, width_mm: 511, thickness_mm: 30 }]);
    expect(byName("Left side")).toHaveLength(1);
    expect(byName("Right side")).toHaveLength(1);
    expect(byName("Drawer front")).toMatchObject([{ qty: 5, length_mm: 368, width_mm: 366 }]);
    expect(list.hardware).toMatchObject([{ kind: "drawer_slide", qty: 5 }]);
  });

  it("changes the number of drawers by one parameter", () => {
    const d = applyOp(build(), { op: "set_param", name: "drawers", expr: "4", unit: "count" });
    const r = derive(d);
    expect(r.parts.filter((p) => p.source === "false_front")).toHaveLength(4);
    expect(r.parts.filter((p) => p.source === "partition")).toHaveLength(3);
    expect(runChecks(d, r).issues.filter((i) => i.code !== "rule_failed" && i.code !== "stock_too_small")).toEqual([]);
  });
});
