// The Check tab's ways to fix a problem: the words Ask Claude to fix puts
// in the chat box, the parts Show me picks and frames, and the rule Edit
// the rule opens.

import { describe, expect, it } from "vitest";
import type { Issue } from "@woodchuck/core";
import { boxOf, fixesFor, fixRequest, problemWords, ruleOf, ruleParts, showMeParts } from "../src/checkFixes.js";
import { partNamer } from "../src/names.js";
import { bench, stateOf } from "./bench.js";

// The book shelf too high for books, a seat too low, and gaps that aren't the ones Dave asked for.
const s = stateOf(
  bench([
    { op: "set_param", name: "shelf_top", expr: "140", unit: "mm" },
    { op: "set_param", name: "seat_height", expr: "400", unit: "mm" },
    { op: "set_param", name: "slat_gap", expr: "10", unit: "mm" },
  ]),
);
const name = partNamer(s.derived.parts);
const issue = (rule: string): Issue => s.report.issues.find((i) => i.message.endsWith(`(rule ${rule})`))!;
const floating = s.report.issues.find((i) => i.code === "floating")!;
const SLATS = ["shelf_slat", "shelf_slat#2", "shelf_slat#3", "shelf_slat#4"];

describe("which problems come from a rule", () => {
  it("finds the design's rule behind a rule's problem", () => {
    expect(ruleOf(issue("book_room"), s.design.rules)?.id).toBe("book_room");
    expect(ruleOf(issue("seat_height_ok"), s.design.rules)?.id).toBe("seat_height_ok");
    expect(ruleOf(floating, s.design.rules)).toBeNull();
  });

  it("finds a rule that can't be worked out, too", () => {
    const broken = stateOf(bench([{ op: "set_rule", id: "shelf_number", expr: "shelf_top", severity: "warning", message: "Shelf height" }]));
    const i = broken.report.issues.find((x) => x.code === "rule_error")!;
    expect(i.message).toBe("Rule shelf_number must be true or false, but it gives a number");
    expect(ruleOf(i, broken.design.rules)?.id).toBe("shelf_number");
  });

  it("reads a rule's words without its id on the end", () => {
    expect(problemWords(issue("book_room").message)).toEqual({ text: "Under the front rail needs at least 240 mm above the shelf for books.", rule: "book_room" });
    expect(problemWords(floating.message)).toEqual({ text: floating.message, rule: null });
  });
});

describe("Ask Claude to fix", () => {
  it("asks in plain words, naming the problem and its rule", () => {
    expect(fixRequest(issue("book_room"), ruleOf(issue("book_room"), s.design.rules), name)).toBe(
      'Please fix this problem from Check: "Under the front rail needs at least 240 mm above the shelf for books". It comes from the design\'s rule book_room.',
    );
  });

  it("names the parts a problem is about, by their names", () => {
    expect(fixRequest(floating, null, name)).toBe(`Please fix this problem from Check: "${floating.message}". It's about ${name(floating.parts[0]!)}.`);
    const many = { ...floating, parts: ["leg_fl", "leg_fr", "leg_bl", "leg_br", "seat"] };
    expect(fixRequest(many, null, name)).toMatch(/It's about Leg, front left, Leg, front right, Leg, back left and 2 more\.$/);
    expect(fixRequest({ ...floating, parts: [] }, null, name)).toBe(`Please fix this problem from Check: "${floating.message}".`);
  });
});

describe("Show me", () => {
  it("picks the parts a problem names", () => {
    expect(showMeParts(floating, s.design, s.derived.parts)).toEqual(floating.parts);
  });

  it("for a rule, picks the parts it reads: the front rail, and the shelf that sits at shelf_top", () => {
    expect(ruleParts(s.design.rules.find((r) => r.id === "book_room")!, s.design).sort()).toEqual(["rail_front_low", "rail_front_top", "shelf_slat"]);
    expect(showMeParts(issue("book_room"), s.design, s.derived.parts).sort()).toEqual(["rail_front_low", "rail_front_top", ...SLATS].sort());
  });

  it("for a rule about a size alone, picks the parts that size sets", () => {
    expect(showMeParts(issue("seat_height_ok"), s.design, s.derived.parts).sort()).toEqual(["leg_bl", "leg_br", "leg_fl", "leg_fr", "rail_front_top", "seat"]);
  });

  it("for a rule about an array's spacing, picks every copy", () => {
    expect(showMeParts(issue("slat_gap_12"), s.design, s.derived.parts).sort()).toEqual([...SLATS].sort());
  });

  it("follows a size made from other sizes down to the parts it reads", () => {
    const d = bench([
      { op: "set_param", name: "book_gap", expr: "rail_front_top.bottom - shelf_top", unit: "mm" },
      { op: "set_rule", id: "book_gap_ok", expr: "book_gap >= 260", severity: "warning", message: "Leave 260 mm for tall books." },
    ]);
    expect(ruleParts(d.rules.find((r) => r.id === "book_gap_ok")!, d)).toContain("rail_front_top");
  });

  it("has nothing to show for a problem that names no parts and comes from no rule", () => {
    expect(showMeParts({ code: "finish_target", message: "The finish on shelf#9 has nothing to go on", parts: [] }, s.design, s.derived.parts)).toEqual([]);
  });

  it("frames the box round the parts it picks", () => {
    expect(boxOf(s.derived.parts, ["leg_fl", "leg_fr"])).toEqual({ min: [0, 0, 320], max: [1100, 382, 360] });
    expect(boxOf(s.derived.parts, ["no_such_part"])).toBeNull();
  });
});

describe("Edit the rule", () => {
  it("is offered for a rule's problem, opening that rule", () => {
    const f = fixesFor(issue("book_room"), s.design, s.derived.parts, name);
    expect(f.rule).toEqual(s.design.rules.find((r) => r.id === "book_room"));
    expect(f.show.length).toBe(6);
    expect(f.ask).toContain("rule book_room");
  });

  it("isn't offered for any other problem", () => {
    expect(fixesFor(floating, s.design, s.derived.parts, name).rule).toBeNull();
  });
});
