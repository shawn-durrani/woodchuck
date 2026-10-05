import { describe, expect, it } from "vitest";
import { evaluate, gapPartsOf, literalValue, parse, refsOf } from "../src/expr.js";

const names: Record<string, number> = { a: 10, b: 4, "left_side.right": 30, "partition#2.left": 758 };
const resolve = (n: string) => {
  if (!(n in names)) throw new Error(`unknown ${n}`);
  return names[n]!;
};

describe("expressions", () => {
  it("does arithmetic with the usual precedence", () => {
    expect(evaluate("1 + 2 * 3", resolve).value).toBe(7);
    expect(evaluate("(1 + 2) * 3", resolve).value).toBe(9);
    expect(evaluate("-a + 2", resolve).value).toBe(-8);
    expect(evaluate("a / b", resolve).value).toBe(2.5);
  });

  it("resolves part faces and array copies", () => {
    expect(evaluate("partition#2.left - left_side.right", resolve).value).toBe(728);
    expect(refsOf("partition#2.left - left_side.right + a")).toEqual(["partition#2.left", "left_side.right", "a"]);
  });

  it("compares and combines true/false values", () => {
    expect(evaluate("a >= 10 && b < 5", resolve).value).toBe(true);
    expect(evaluate("a == 10.0000001", resolve).value).toBe(true);
    expect(evaluate("!(a > b)", resolve).value).toBe(false);
  });

  it("has rounding helpers with steps", () => {
    expect(evaluate("round(12.34, 0.5)", resolve).value).toBe(12.5);
    expect(evaluate("floor(17, 5)", resolve).value).toBe(15);
    expect(evaluate("max(a, b, 3)", resolve).value).toBe(10);
  });

  it("writes a trace with each name's value", () => {
    expect(evaluate("partition#2.left - left_side.right", resolve).text).toBe("partition#2.left (758) - left_side.right (30)");
    expect(evaluate("(a - b) * 2", resolve).text).toBe("(a (10) - b (4)) * 2");
  });

  it("explains mistakes", () => {
    expect(() => parse("1 +")).toThrow(/ends too early/);
    expect(() => parse("foo(1)")).toThrow(/Unknown function/);
    expect(() => evaluate("a / 0", resolve)).toThrow(/Division by zero/);
    expect(() => evaluate("a + (b > 1)", resolve)).toThrow(/needs a number/);
  });

  it("measures between two parts with gap_x, gap_y and gap_z, given the shapes", () => {
    const gap = (axis: "x" | "y" | "z", a: string, b: string) => (axis === "y" && a === "shelf" && b === "side#2" ? 11.5 : NaN);
    expect(evaluate("gap_y(shelf, side#2) - a >= 1", resolve, gap)).toEqual({ value: true, text: "gap_y(shelf, side#2) (11.5) - a (10) >= 1" });
    expect(parse("GAP_Y(shelf, side#2)")).toEqual({ kind: "gap", axis: "y", a: "shelf", b: "side#2" });
    // The parts it measures aren't names with values, so they come back on their own.
    expect(refsOf("gap_y(shelf, side#2) >= a")).toEqual(["a"]);
    expect(gapPartsOf("gap_y(shelf, side#2) >= max(a, gap_x(shelf, back))")).toEqual(["shelf", "side#2", "back"]);
    expect(gapPartsOf("left_side.right - a")).toEqual([]);
  });

  it("refuses a gap without two part names, or before the shapes are known", () => {
    expect(() => parse("gap_y(shelf.top, side)")).toThrow(/gap_y\(\) takes two part names, such as gap_y\(shelf, side_l\)/);
    expect(() => parse("gap_x(shelf, 3)")).toThrow(/takes two part names/);
    expect(() => parse("gap_z(shelf)")).toThrow(/Expected ","/);
    expect(() => parse("gap_y(shelf, shelf)")).toThrow(/gap_y\(\) needs two different parts, not shelf twice/);
    expect(() => evaluate("gap_y(shelf, side)", resolve)).toThrow(/gap_y measures the parts' shapes, which are worked out after every size, so only a rule can use it/);
    expect(() => parse("gap_w(a, b)")).toThrow(/Allowed: min, max, abs, sqrt, round, floor, ceil, gap_x, gap_y, gap_z/);
  });

  it("spots plain numbers for sliders", () => {
    expect(literalValue(" 12.7 ")).toBe(12.7);
    expect(literalValue("12.7 + 1")).toBeNull();
  });
});
