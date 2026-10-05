// Issue #24: the quality benchmark's checks, on designs made here. Each
// check is held to a pass and a fail, so a speed change that lowers quality
// can't slip past it. The record console example starts the console tasks,
// and a small invented bookshelf for Globex stands in for Claude's build.
// No key: the one run through the turn loop uses a scripted Claude.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyOp, applyOps, emptyDesign, type Design, type Op } from "@woodchuck/core";
import { scriptedClient } from "../src/scripted.js";
import { Store } from "../src/store.js";
import {
  configEnv,
  consoleOps,
  costUsd,
  describeConfig,
  drawerFronts,
  drawerInsides,
  envFor,
  estimateUsd,
  extent,
  formatTable,
  goAhead,
  judge,
  lengthsIn,
  median,
  mentionsLength,
  parseBenchArgs,
  QUALITY_TASKS,
  ruleFailures,
  runTask,
  saysWhatChanged,
  shelfCount,
  summarise,
  verdict,
  weakenings,
  type Check,
  type Outcome,
  type QualityTask,
  type RunResult,
} from "../src/quality.js";

const task = (name: string): QualityTask => QUALITY_TASKS.find((t) => t.name === name)!;
const start = (): Design => applyOps(emptyDesign("Initech record console"), consoleOps());
const edit = (d: Design, ...ops: unknown[]): Design => applyOps(d, ops as Op[]);
const outcome = (first: Design, after: Design[], replies: string[] = [""], failed = false): Outcome => ({ start: first, after, replies, failed });

/** The task's checks on an outcome, as name to pass or fail. */
function results(name: string, o: Outcome): Record<string, boolean> {
  return Object.fromEntries(judge(task(name), o).map((c) => [c.name, c.ok]));
}
const failing = (name: string, o: Outcome): Check[] => judge(task(name), o).filter((c) => !c.ok);
const failedNames = (name: string, o: Outcome) => failing(name, o).map((c) => c.name);
const reasonOf = (name: string, o: Outcome, check: string) => judge(task(name), o).find((c) => c.name === check)?.reason;

/** Every material in the console, so a finish covers the whole piece. */
const ALL = ["material:carcass_30", "material:top_30", "material:ply15", "material:ply9", "material:ply6", "material:front_18"];
const oil = (finish: string, targets = ALL) => ({ op: "set_finish", targets, finish });
/** Undermount slides leave 332 mm inside each drawer, so the LP rule passes. */
const undermount = { op: "set_param", name: "slide_gap", expr: "5", unit: "mm" };

describe("reading a design", () => {
  it("measures the console's size, drawers and the room inside them", () => {
    const d = start();
    expect(extent(d)).toEqual({ width_mm: 2040, height_mm: 430, depth_mm: 520 });
    expect(drawerFronts(d).map((p) => p.id)).toEqual(["false_front", "false_front#2", "false_front#3", "false_front#4", "false_front#5"]);
    const insides = drawerInsides(d);
    expect(insides).toHaveLength(5);
    for (const i of insides) {
      expect(i.width_mm).toBeCloseTo(316.6, 6);
      expect(i.height_mm).toBeCloseTo(339, 6);
    }
  });

  it("counts drawers by their fronts, whatever the count", () => {
    expect(drawerFronts(edit(start(), { op: "set_param", name: "drawers", expr: "4", unit: "count" }))).toHaveLength(4);
    expect(drawerFronts(edit(start(), { op: "set_param", name: "drawers", expr: "6", unit: "count" }))).toHaveLength(6);
  });

  it("doesn't count a handle as a drawer, and finds box fronts when there's no false front", () => {
    const handle = {
      op: "add_panel",
      id: "pull",
      name: "Drawer pull",
      material: "front_18",
      thickness_axis: "z",
      grain_axis: "x",
      x: { start: { face: "false_front.left", offset: "150" }, size: "60" },
      y: { start: { face: "false_front.top", offset: "-40" }, size: "20" },
      z: { start: { face: "false_front.front" } },
      tags: ["drawer"],
    };
    expect(drawerFronts(edit(start(), handle))).toHaveLength(5);

    const boxOnly = edit(start(), { op: "update_panel", id: "false_front", decor: true });
    const fronts = drawerFronts(boxOnly);
    expect(fronts.map((p) => p.source)).toEqual(Array(5).fill("drawer_box_front"));
    expect(drawerInsides(boxOnly)[0]!.width_mm).toBeCloseTo(316.6, 6);
  });

  it("checks a rule on every array copy of the parts it reads", () => {
    const d = start();
    expect(ruleFailures(d, { id: "near", expr: "partition.left <= 500", severity: "error", message: "Near the left" })).toEqual([
      "rule near fails on copy 2",
      "rule near fails on copy 3",
      "rule near fails on copy 4",
    ]);
    expect(ruleFailures(d, { id: "gap", expr: "partition.left - left_side.right >= 372", severity: "error", message: "Wide" })).toEqual([]);
    expect(ruleFailures(edit(d, undermount), d.rules[0]!)).toEqual([]);
    expect(ruleFailures(d, d.rules[0]!)).toEqual(["rule lp_fit fails", ...[2, 3, 4, 5].map((k) => `rule lp_fit fails on copy ${k}`)]);
  });
});

describe("lengths in Claude's words", () => {
  it("reads a length however it's written", () => {
    expect(lengthsIn("Each opening is 372 mm wide.")).toEqual([372]);
    expect(lengthsIn("372mm")).toEqual([372]);
    expect(lengthsIn("about 372.0 across")).toEqual([372]);
    expect(lengthsIn("37.2 cm")[0]).toBeCloseTo(372, 6);
    expect(lengthsIn("2,040 mm long and 1.8 m tall")).toEqual([2040, 1800]);
    expect(lengthsIn("5 more drawers")).toEqual([5]);
  });

  it("leaves numbers inside ids and longer numbers alone", () => {
    expect(lengthsIn("ply15 and drawer_side_r#2")).toEqual([]);
    expect(mentionsLength("It's 1372 mm", 372)).toBe(false);
    expect(mentionsLength("It's 316.6 mm inside", 372)).toBe(false);
    expect(mentionsLength("about 371.5 mm", 372)).toBe(true);
    expect(mentionsLength("It's 374 mm", 372)).toBe(false);
  });
});

describe("height: make the carcass 50 mm taller", () => {
  it("passes when the height parameter moves 50 mm and nothing else does", () => {
    const d = start();
    const o = outcome(d, [edit(d, { op: "set_param", name: "carcass_height", expr: "450", unit: "mm" })]);
    expect(failing("height", o)).toEqual([]);
    expect(Object.keys(results("height", o))).toEqual([
      "finished",
      "sides-50-taller",
      "overall-50-taller",
      "height-param-moved",
      "footprint-kept",
      "drawers-kept",
      "other-sizes-kept",
      "no-new-errors",
    ]);
  });

  it("fails the wrong amount, one side only, and an unasked change", () => {
    const d = start();
    const twice = outcome(d, [edit(d, { op: "set_param", name: "carcass_height", expr: "500", unit: "mm" })]);
    expect(failedNames("height", twice)).toEqual(["sides-50-taller", "overall-50-taller", "height-param-moved"]);
    expect(reasonOf("height", twice, "height-param-moved")).toBe("carcass_height went from 400 to 500");

    const oneSide = outcome(d, [edit(d, { op: "update_panel", id: "left_side", y: { start: { at: "0" }, size: "carcass_height + 50" } })]);
    expect(failedNames("height", oneSide)).toContain("sides-50-taller");

    const longer = edit(d, { op: "set_param", name: "carcass_height", expr: "450", unit: "mm" }, { op: "set_param", name: "top_length", expr: "2100", unit: "mm" });
    expect(failedNames("height", outcome(d, [longer]))).toEqual(["footprint-kept", "other-sizes-kept"]);
    expect(reasonOf("height", outcome(d, [longer]), "other-sizes-kept")).toBe("changed top_length from 2040 to 2100");
  });

  it("fails a turn that ended in an error, and new check errors", () => {
    const d = start();
    const tall = edit(d, { op: "set_param", name: "carcass_height", expr: "450", unit: "mm" });
    expect(failedNames("height", outcome(d, [tall], [""], true))).toEqual(["finished"]);
    const clash = edit(tall, { op: "set_rule", id: "low", expr: "carcass_height <= 420", severity: "error", message: "Keep it low" });
    expect(failedNames("height", outcome(d, [clash]))).toEqual(["no-new-errors"]);
    expect(reasonOf("height", outcome(d, [clash]), "no-new-errors")).toBe("new errors: rule low fails");
  });
});

describe("colour: oil the whole console dark walnut", () => {
  it("passes one dark brown oil on every face, with nothing else changed", () => {
    const d = start();
    expect(failing("colour", outcome(d, [edit(d, oil("porto"))]))).toEqual([]);
    expect(failing("colour", outcome(d, [edit(d, oil("balmoral"))]))).toEqual([]);
  });

  it("fails a black, a light oil, two colours and a bare face", () => {
    const d = start();
    expect(failedNames("colour", outcome(d, [edit(d, oil("tokyo"))]))).toEqual(["walnut-brown"]);
    expect(failedNames("colour", outcome(d, [edit(d, oil("natur"))]))).toEqual(["dark"]);
    expect(failedNames("colour", outcome(d, [edit(d, oil("porto"), oil("balmoral", ["material:top_30"]))]))).toEqual(["one-finish"]);
    const bare = outcome(d, [edit(d, oil("porto", ALL.filter((t) => t !== "material:ply6")))]);
    expect(failedNames("colour", bare)).toEqual(["every-face-finished"]);
    expect(reasonOf("colour", bare, "every-face-finished")).toBe("30 of 234 faces are bare, such as drawer_bottom.left");
  });

  it("fails a walnut look made by changing the timber, or any change of size", () => {
    const d = start();
    const walnut = edit(d, oil("natur"), {
      op: "define_material",
      id: "carcass_30",
      name: "30 mm carcass panel",
      kind: "sheet",
      thickness_mm: 30,
      grained: true,
      species: "walnut",
    });
    expect(failedNames("colour", outcome(d, [walnut]))).toContain("timber-kept");
    expect(reasonOf("colour", outcome(d, [walnut]), "timber-kept")).toBe("carcass_30 shows as walnut, was birch_ply");
    const moved = edit(d, oil("porto"), { op: "set_param", name: "front_gap", expr: "3", unit: "mm" });
    expect(failedNames("colour", outcome(d, [moved]))).toEqual(["geometry-kept"]);
  });
});

describe("lp-fix: make 12-inch LPs fit without weakening the rule", () => {
  const said = "I switched to undermount slides, so slide_gap is 5 mm a side and each drawer is 332 mm inside.";

  it("passes a fix to the drawers that says what changed", () => {
    const d = start();
    expect(failing("lp-fix", outcome(d, [edit(d, undermount)], [said]))).toEqual([]);
  });

  it("fails as weakened when the rule goes, changes or softens, or lp_clear drops", () => {
    const d = start();
    const cases: [unknown[], string][] = [
      [[{ op: "delete_rule", id: "lp_fit" }], "rule lp_fit was deleted"],
      [[{ op: "set_param", name: "lp_clear", expr: "310", unit: "mm" }], "lp_clear lowered from 320 to 310"],
      [[{ op: "set_rule", id: "lp_fit", expr: "drawer_side_r.left - drawer_side_l.right >= lp_clear - 10", severity: "error", message: "LPs fit" }], "rule lp_fit's expression changed"],
      [[{ op: "set_rule", id: "lp_fit", expr: d.rules[0]!.expr, severity: "warning", message: "LPs fit" }], "rule lp_fit became a warning"],
    ];
    for (const [ops, why] of cases) {
      const o = outcome(d, [edit(d, ...ops)], [said]);
      expect(failedNames("lp-fix", o)).toContain("not-weakened");
      expect(reasonOf("lp-fix", o, "not-weakened")).toBe(`weakened the requirement: ${why}`);
      expect(weakenings(d, last(o), "lp_fit")).toEqual([why]);
    }
  });

  it("keeps a stricter requirement, and a rule rewritten with the same expression", () => {
    const d = start();
    const stricter = edit(d, undermount, { op: "set_param", name: "lp_clear", expr: "325", unit: "mm" });
    expect(weakenings(d, stricter, "lp_fit")).toEqual([]);
    const spaced = edit(d, { op: "set_rule", id: "lp_fit", expr: d.rules[0]!.expr.replace(/ /g, "  "), severity: "error", message: "Reworded" });
    expect(weakenings(d, spaced, "lp_fit")).toEqual([]);
  });

  it("fails a fix that drops a drawer, widens the piece unsaid, or says nothing", () => {
    const d = start();
    const four = edit(d, { op: "set_param", name: "drawers", expr: "4", unit: "count" });
    expect(failedNames("lp-fix", outcome(d, [four], ["Four drawers now, so drawers is 4."]))).toEqual(["drawers-kept"]);

    const wider = edit(d, { op: "set_param", name: "top_length", expr: "2100", unit: "mm" });
    expect(failedNames("lp-fix", outcome(d, [wider], ["I changed top_length."]))).toEqual(["width-kept"]);
    expect(failing("lp-fix", outcome(d, [wider], ["I made top_length 2100 mm."]))).toEqual([]);

    expect(failedNames("lp-fix", outcome(d, [edit(d, undermount)], ["Done."]))).toEqual(["says-what-changed"]);
    expect(failedNames("lp-fix", outcome(d, [edit(d, undermount)], [""]))).toEqual(["says-what-changed"]);
  });

  it("takes what changed from parameters, parts, materials or the room inside", () => {
    const d = start();
    const thinner = edit(
      d,
      { op: "define_material", id: "ply12", name: "12 mm birch ply", kind: "sheet", thickness_mm: 12, grained: true, sheet_sizes_mm: [[2440, 1220]] },
      { op: "update_panel", id: "drawer_side_l", material: "ply12" },
      { op: "update_panel", id: "drawer_side_r", material: "ply12" },
    );
    expect(drawerInsides(thinner)[0]!.width_mm).toBeCloseTo(322.6, 6);
    for (const reply of ["I made the drawer sides thinner.", "Each drawer is 322.6 mm inside now.", "The sides are 12 mm ply now."]) {
      expect(saysWhatChanged(d, thinner, reply)).toBe(true);
    }
    expect(saysWhatChanged(d, thinner, "Fixed it.")).toBe(false);
    expect(saysWhatChanged(d, edit(d, undermount), "The slide gap is smaller.")).toBe(true);
    expect(saysWhatChanged(d, edit(d, undermount), "Undermount slides take 5 mm a side.")).toBe(true);
    expect(failing("lp-fix", outcome(d, [thinner], ["I made the drawer sides from 12 mm ply."]))).toEqual([]);
  });

  it("fails an unchanged design: the rule still fails", () => {
    const d = start();
    expect(failedNames("lp-fix", outcome(d, [d], [said]))).toEqual(["lp-fit-passes", "says-what-changed"]);
  });
});

describe("build: the record console from its spec", () => {
  // The example with undermount slides meets the whole spec, so it stands in for Claude's build.
  const built = () => edit(start(), undermount);

  it("passes a build that meets the spec", () => {
    expect(failing("build", outcome(emptyDesign("Bench build"), [built()]))).toEqual([]);
  });

  it("fails a wrong top, thin panels, a short carcass and the wrong drawers", () => {
    const empty = emptyDesign("Bench build");
    const fails = (...ops: unknown[]) => failedNames("build", outcome(empty, [edit(built(), ...ops)]));
    expect(fails({ op: "set_param", name: "top_depth", expr: "500", unit: "mm" })).toEqual(["top-size"]);
    expect(fails({ op: "define_material", id: "carcass_30", name: "18 mm carcass panel", kind: "sheet", thickness_mm: 18, grained: true })).toContain("carcass-30");
    expect(fails({ op: "set_param", name: "carcass_height", expr: "300", unit: "mm" })).toEqual(["height-in-range", "lps-fit-height"]);
    expect(fails({ op: "set_param", name: "drawers", expr: "6", unit: "count" })).toEqual(["five-drawers", "lp-rule-passes", "lps-fit-width", "no-errors"]);
  });

  it("fails a build that loses the LP requirement", () => {
    expect(failedNames("build", outcome(emptyDesign("Bench build"), [edit(built(), { op: "delete_rule", id: "lp_fit" })]))).toEqual(["lp-rule", "lp-rule-passes"]);
  });

  it("fails an empty design on every count", () => {
    const empty = emptyDesign("Bench build");
    expect(failedNames("build", outcome(empty, [empty]))).toEqual([
      "top-size",
      "carcass-30",
      "height-in-range",
      "five-drawers",
      "one-row",
      "lp-rule",
      "lp-rule-passes",
      "lps-fit-width",
      "lps-fit-height",
    ]);
  });
});

describe("questions", () => {
  it("passes the bay in any spelling, worked out from the design", () => {
    const d = start();
    for (const reply of ["Each opening is 372 mm wide.", "372mm", "They're 372.0 across", "37.2 cm each"]) {
      expect(failing("question-bay", outcome(d, [d], [reply]))).toEqual([]);
    }
    const wider = edit(d, { op: "set_param", name: "top_length", expr: "2100", unit: "mm" });
    expect(failing("question-bay", outcome(wider, [wider], ["384 mm"]))).toEqual([]);
  });

  it("fails the wrong number, and a design changed by a question", () => {
    const d = start();
    expect(failedNames("question-bay", outcome(d, [d], ["Each drawer is 316.6 mm inside."]))).toEqual(["answer-gives-bay"]);
    expect(reasonOf("question-bay", outcome(d, [d], ["316.6 mm inside, for 320"]), "answer-gives-bay")).toBe("the reply doesn't give 372 mm: it gives 316.6, 320");
    const touched = edit(d, undermount);
    expect(failedNames("question-bay", outcome(d, [touched], ["372 mm"]))).toEqual(["design-unchanged"]);
    expect(reasonOf("question-bay", outcome(d, [touched], ["372 mm"]), "design-unchanged")).toBe("changed params");
  });

  it("passes the overall height, and fails the carcass height", () => {
    const d = start();
    expect(failing("question-height", outcome(d, [d], ["It's 430 mm to the top."]))).toEqual([]);
    expect(failing("question-height", outcome(d, [d], ["43 cm"]))).toEqual([]);
    expect(failedNames("question-height", outcome(d, [d], ["The carcass is 400 mm."]))).toEqual(["answer-gives-height"]);
  });
});

// A bookshelf for Globex, built in the turns the task sends.
const birch = { op: "define_material", id: "birch18", name: "18 mm birch ply", kind: "sheet", thickness_mm: 18, grained: true, sheet_sizes_mm: [[2440, 1220]] };
const upright = (id: string, name: string, x: object) => ({
  op: "add_panel",
  id,
  name,
  material: "birch18",
  thickness_axis: "x",
  grain_axis: "y",
  x,
  y: { start: { at: "0" }, size: "height" },
  z: { start: { at: "0" }, size: "depth" },
  tags: ["carcass", "side"],
});
const across = (id: string, name: string, y: object, tags: string[]) => ({
  op: "add_panel",
  id,
  name,
  material: "birch18",
  thickness_axis: "y",
  grain_axis: "x",
  x: { start: { face: "left_side.right" }, end: { face: "right_side.left" } },
  y,
  z: { start: { at: "0" }, size: "depth" },
  tags,
});
const sagRule = { op: "set_rule", id: "shelf_sag", expr: "shelf.length <= 870", severity: "error", message: "18 mm birch ply sags under 30 kg past 870 mm" };

function bookshelf(): Design[] {
  const first = applyOps(emptyDesign("Globex bookshelf"), [
    { op: "set_param", name: "width", expr: "900", unit: "mm" },
    { op: "set_param", name: "height", expr: "1800", unit: "mm" },
    { op: "set_param", name: "depth", expr: "250", unit: "mm" },
    { op: "set_param", name: "shelves", expr: "3", unit: "count" },
    birch,
    upright("left_side", "Left side", { start: { at: "0" } }),
    upright("right_side", "Right side", { end: { at: "width" } }),
    across("bottom", "Bottom", { start: { at: "0" } }, ["carcass"]),
    across("top", "Top", { end: { at: "height" } }, ["carcass"]),
    across("shelf", "Shelf", { start: { at: "400" } }, ["shelf"]),
    { op: "set_array", id: "shelf_row", parts: ["shelf"], axis: "y", count: "shelves", pitch: "300" },
    sagRule,
  ] as Op[]);
  const more = applyOp(first, { op: "set_param", name: "shelves", expr: "5", unit: "count" });
  const deeper = applyOp(more, { op: "set_param", name: "depth", expr: "300", unit: "mm" });
  const oiled = applyOp(deeper, { op: "set_finish", targets: ["material:birch18"], finish: "natur" });
  return [first, more, deeper, oiled];
}

describe("requirement-kept: a bookshelf over four turns", () => {
  const empty = emptyDesign("Globex bookshelf");

  it("passes when every follow-up lands and the sag rule stays", () => {
    const steps = bookshelf();
    expect(shelfCount(steps[0]!)).toEqual({ named: 3, flat: 5 });
    expect(shelfCount(steps[1]!)).toEqual({ named: 5, flat: 7 });
    expect(failing("requirement-kept", outcome(empty, steps, ["", "", "", ""]))).toEqual([]);
  });

  it("fails a sag requirement that was never kept, or dropped on the way", () => {
    const lost = bookshelf().map((d) => applyOp(d, { op: "delete_rule", id: "shelf_sag" }));
    expect(failedNames("requirement-kept", outcome(empty, lost))).toEqual(["load-rule", "load-rule-every-turn", "load-rule-passes"]);
    const dropped = bookshelf().map((d, i) => (i === 2 ? applyOp(d, { op: "delete_rule", id: "shelf_sag" }) : d));
    expect(failedNames("requirement-kept", outcome(empty, dropped))).toEqual(["load-rule-every-turn"]);
    expect(reasonOf("requirement-kept", outcome(empty, dropped), "load-rule-every-turn")).toBe("no load rule after message 3");
  });

  it("fails a failing sag rule, unless it's a warning Claude flagged", () => {
    const strict = { ...sagRule, expr: "shelf.length <= 800" };
    const failingRule = bookshelf().map((d) => applyOp(d, strict as Op));
    expect(failedNames("requirement-kept", outcome(empty, failingRule))).toEqual(["load-rule-passes", "no-errors"]);
    const warned = bookshelf().map((d) => applyOp(d, { ...strict, severity: "warning" } as Op));
    expect(failedNames("requirement-kept", outcome(empty, warned, ["", "", "", ""]))).toEqual(["load-rule-passes"]);
    expect(failing("requirement-kept", outcome(empty, warned, ["These shelves will sag a little at 30 kg.", "", "", ""]))).toEqual([]);
  });

  it("fails a follow-up that didn't land, and a size the follow-ups lost", () => {
    const steps = bookshelf();
    const oneShelf = [steps[0]!, applyOp(steps[0]!, { op: "set_param", name: "shelves", expr: "4", unit: "count" })];
    const short = [...oneShelf, applyOp(oneShelf[1]!, { op: "set_param", name: "depth", expr: "300", unit: "mm" })];
    const all = [...short, applyOp(short[2]!, { op: "set_finish", targets: ["material:birch18"], finish: "natur" })];
    expect(failedNames("requirement-kept", outcome(empty, all))).toEqual(["two-more-shelves"]);
    expect(reasonOf("requirement-kept", outcome(empty, all), "two-more-shelves")).toBe("shelves went 3 to 4 to 4, flat panels 5 to 6 to 6");

    const wide = steps.map((d, i) => (i >= 2 ? applyOp(d, { op: "set_param", name: "width", expr: "1000", unit: "mm" }) : d));
    expect(failedNames("requirement-kept", outcome(empty, wide))).toEqual(["width-900", "load-rule-passes", "no-errors"]);
    const shallow = steps.map((d, i) => (i >= 2 ? applyOp(d, { op: "set_param", name: "depth", expr: "280", unit: "mm" }) : d));
    expect(failedNames("requirement-kept", outcome(empty, shallow))).toEqual(["depth-300"]);
  });

  it("fails a dark oil, and panels that aren't 18 mm birch ply", () => {
    const steps = bookshelf();
    const dark = [...steps.slice(0, 3), applyOp(steps[3]!, { op: "set_finish", targets: ["material:birch18"], finish: "porto" })];
    expect(failedNames("requirement-kept", outcome(empty, dark))).toEqual(["light"]);
    const pine = steps.map((d) => applyOp(d, { ...birch, name: "18 mm radiata pine", kind: "solid" } as Op));
    expect(failedNames("requirement-kept", outcome(empty, pine))).toEqual(["birch-ply-18"]);
  });

  it("lets a hardwood stiffener under a shelf be something other than ply", () => {
    const oak = { op: "define_material", id: "oak19", name: "19 mm Tasmanian oak", kind: "solid", thickness_mm: 19, grained: true };
    const stiffener = {
      op: "add_panel",
      id: "shelf_stiffener",
      name: "Shelf stiffener",
      material: "oak19",
      thickness_axis: "y",
      grain_axis: "x",
      x: { start: { face: "left_side.right" }, end: { face: "right_side.left" } },
      y: { end: { face: "shelf.bottom" } },
      z: { end: { at: "depth" }, size: "40" },
    };
    const stiff = bookshelf().map((d, i) => {
      const e = applyOps(d, [oak, stiffener] as Op[]);
      return i === 3 ? applyOp(e, { op: "set_finish", targets: ["material:oak19"], finish: "natur" }) : e;
    });
    expect(failing("requirement-kept", outcome(empty, stiff))).toEqual([]);
  });
});

describe("running a task through the turn loop", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "woodchuck-quality-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const call = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });

  it("keeps the design and Claude's words after each message, and the turn's numbers", async () => {
    const client = scriptedClient([
      [call("t1", "set_param", { name: "carcass_height", expr: "450", unit: "mm" })],
      [{ type: "text", text: "The carcass is 450 mm now, so the console stands 480 mm." }],
    ]);
    const { outcome: o, usage } = await runTask(task("height"), new Store(dir), client, () => Buffer.from("png"));
    expect(o.after).toHaveLength(1);
    expect(o.replies).toEqual(["The carcass is 450 mm now, so the console stands 480 mm."]);
    expect(o.failed).toBe(false);
    expect(judge(task("height"), o).filter((c) => !c.ok)).toEqual([]);
    expect(usage).toMatchObject({ turns: 1, rounds: 2, tool_calls: 1, edits: 0 });
  });

  it("applies a waiting preview on the go-ahead, as the Apply button does", async () => {
    const client = scriptedClient([
      [call("p1", "preview_change", { title: "Undermount slides", explanation: "They leave 332 mm inside.", ops: [undermount] })],
      [{ type: "text", text: "Applied: slide_gap is 5 mm now." }],
    ]);
    const store = new Store(dir);
    const { outcome: o, usage } = await runTask(task("lp-fix"), store, client, () => Buffer.from("png"));
    expect(o.after[0]!.params.find((p) => p.name === "slide_gap")?.expr).toBe("5");
    expect(o.replies[0]).toContain("Undermount slides");
    expect(store.project.chat.find((c) => c.kind === "preview")).toMatchObject({ status: "applied" });
    expect(judge(task("lp-fix"), o).filter((c) => !c.ok)).toEqual([]);
    expect(usage.turns).toBe(2);
  });

  it("approves a waiting plan on the go-ahead", () => {
    const store = new Store(dir);
    const project = store.create("Bench plan");
    project.change("claude", "Plan", [{ op: "set_plan", plan: { status: "proposed", summary: "A shelf", parts: [], key_dims: [], joints: [], assumptions: [] } }]);
    project.pending = { held: [], waiting: [{ tool_use_id: "x", kind: "plan" }] };
    expect(goAhead(project)).toBe("Yes, go ahead with what you suggest.");
    expect(project.design.plan?.status).toBe("approved");
  });
});

describe("settings, arguments and the report", () => {
  it("reads the arguments, with two repeats and the current settings by default", () => {
    const a = parseBenchArgs(["--live"]);
    expect("error" in a).toBe(false);
    if ("error" in a) return;
    expect(a).toMatchObject({ live: true, dry: false, repeat: 2, configs: ["current"], child: null });
    expect(a.tasks).toHaveLength(QUALITY_TASKS.length);

    const b = parseBenchArgs(["--live", "--repeat", "3", "--configs=routing,no-routing,medium", "--tasks", "height,lp-fix"]);
    if ("error" in b) throw new Error(b.error);
    expect(b.repeat).toBe(3);
    expect(b.configs).toEqual(["routing", "no-routing", "medium"]);
    expect(b.tasks.map((t) => t.name)).toEqual(["height", "lp-fix"]);

    expect(parseBenchArgs(["--tasks", "sideboard"])).toEqual({ error: expect.stringContaining("no task called sideboard") });
    expect(parseBenchArgs(["--configs", "fastest"])).toEqual({ error: expect.stringContaining("no config called fastest") });
    expect(parseBenchArgs(["--repeat", "0"])).toEqual({ error: expect.stringContaining("--repeat") });
    expect(parseBenchArgs(["--configs", "medium,medium"])).toEqual({ error: "Each config can be named once." });
    expect(parseBenchArgs(["--live", "--dry-run"])).toEqual({ error: "Pick one of --live and --dry-run." });
    expect(parseBenchArgs(["--fast"])).toEqual({ error: "There's no option called --fast." });
  });

  it("sets each config's effort and routing for its own process", () => {
    const base = { WOODCHUCK_EFFORT: "xhigh", WOODCHUCK_EFFORT_ROUTING: "off", PATH: "/bin" };
    expect(envFor("current", base)).toEqual(base);
    expect(envFor("routing", base)).toEqual({ WOODCHUCK_EFFORT: "xhigh", PATH: "/bin" });
    expect(envFor("no-routing", {})).toEqual({ WOODCHUCK_EFFORT_ROUTING: "off" });
    expect(envFor("medium", base)).toEqual({ WOODCHUCK_EFFORT: "medium", WOODCHUCK_EFFORT_ROUTING: "off", PATH: "/bin" });
    expect(envFor("routing-max", base)).toEqual({ WOODCHUCK_EFFORT: "max", PATH: "/bin" });
    expect(configEnv("routing-fast")).toBeNull();
    expect(describeConfig("routing", {})).toBe("up to high, routed");
    expect(describeConfig("medium", {})).toBe("medium on every turn");
  });

  it("prices tokens and estimates a run from each task's range", () => {
    const tokens = { input: 1e6, cached: 1e6, written: 1e6, output: 1e6 };
    expect(costUsd(tokens, "claude-sonnet-5-5", "1h")).toBeCloseTo(2 + 0.2 + 4 + 10, 6);
    expect(costUsd(tokens, "claude-opus-5-5", "5m")).toBeCloseTo((2 + 0.2 + 2.5 + 10) * 2, 6);
    const [low, high] = estimateUsd(QUALITY_TASKS, 2, 3, "claude-sonnet-5-5");
    expect(low).toBeCloseTo(QUALITY_TASKS.reduce((s, t) => s + t.usd[0], 0) * 6, 6);
    expect(high).toBeGreaterThan(low);
  });

  it("sums runs into a row per config and task, and a verdict per config", () => {
    const run = (config: string, task: string, n: number, failed: string[], secs: number): RunResult => ({
      config,
      task,
      run: n,
      passed: failed.length === 0,
      checks: [{ name: "finished", ok: true }, ...failed.map((name) => ({ name, ok: false, reason: "invented" }))],
      secs,
      turns: 1,
      rounds: 3,
      tool_calls: 2,
      edits: 0,
      efforts: "high",
      tokens: { input: 0, cached: 0, written: 0, output: 0 },
      usd: 0.25,
    });
    const rows = summarise([
      run("routing", "lp-fix", 1, [], 10),
      run("routing", "lp-fix", 2, ["not-weakened"], 30),
      run("medium", "lp-fix", 1, [], 20),
      run("medium", "lp-fix", 2, [], 40),
    ]);
    expect(rows.map((r) => [r.config, r.passed, r.runs, r.failed, r.median_secs])).toEqual([
      ["routing", 1, 2, { "not-weakened": 1 }, 20],
      ["medium", 2, 2, {}, 30],
    ]);
    const table = formatTable(rows);
    expect(table[0]).toMatch(/^config\s+task\s+passed\s+failed checks\s+secs\s+rounds\s+US\$$/);
    expect(table[1]).toMatch(/^routing\s+lp-fix\s+1\/2\s+not-weakened 1\s+20\.0\s+3\s+0\.25$/);
    expect(verdict("medium", rows)).toBe("medium: all quality checks passed in 2/2 runs, US$0.50.");
    expect(verdict("routing", rows)).toBe("routing: 1/2 runs passed, US$0.50. Failed lp-fix not-weakened 1/2.");
    expect(median([3, 1, 2])).toBe(2);
    expect(median([])).toBe(0);
  });
});

function last(o: Outcome): Design {
  return o.after.at(-1) ?? o.start;
}

describe("the benchmark script", () => {
  const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "woodchuck-bench-script-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("refuses to run without --live", () => {
    expect(() => execFileSync(path.join(ROOT, "node_modules/.bin/tsx"), [path.join(ROOT, "scripts/bench.ts")], { encoding: "utf8", stdio: "pipe" })).toThrow(/--live/);
  });

  it("runs each config in its own process with its own settings, on a dry run", () => {
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: dir, WOODCHUCK_EFFORT: "high" };
    for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE", "WOODCHUCK_EFFORT_ROUTING"]) delete env[k];
    const args = [path.join(ROOT, "scripts/bench.ts"), "--dry-run", "--tasks", "question-height", "--repeat", "1", "--configs", "routing,medium"];
    const out = execFileSync(path.join(ROOT, "node_modules/.bin/tsx"), args, { encoding: "utf8", env });

    expect(out).toContain("routing: up to high, routed");
    expect(out).toContain("medium: medium on every turn");
    expect(out).toMatch(/^routing\s+question-height\s+0\/1\s+answer-gives-height 1/m);
    expect(out).toContain("medium: 0/1 runs passed, US$0.00. Failed question-height answer-gives-height 1/1.");
    // The stand-in's words never reach the report.
    expect(out).not.toContain("no more replies");

    const file = /Results: (.+\.json)/.exec(out)![1]!;
    expect(path.dirname(file)).toBe(dir);
    const results = JSON.parse(readFileSync(file, "utf8")) as { runs: RunResult[] };
    expect(results.runs.map((r) => [r.config, r.task, r.efforts])).toEqual([
      ["routing", "question-height", "low"],
      ["medium", "question-height", "medium"],
    ]);
    // Of the benchmark's own files, only the results are left behind. tsx keeps a cache there too.
    expect(readdirSync(dir).filter((f) => f.startsWith("woodchuck-"))).toEqual([path.basename(file)]);
  }, 60_000);
});
