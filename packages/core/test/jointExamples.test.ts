import { describe, expect, it } from "vitest";
import { JOINT_TYPES, derive, jointExample, runChecks } from "../src/index.js";

describe("worked joint examples", () => {
  it.each(JOINT_TYPES.map((t) => [t]))("builds a clean %s example", (type) => {
    const d = jointExample(type);
    const r = derive(d);
    expect(r.joints.map((j) => j.type)).toEqual([type]);
    expect(r.parts.every((p) => !p.broken)).toBe(true);
    expect(runChecks(d, r).issues.filter((i) => i.severity === "error").map((i) => i.message)).toEqual([]);
  });
});
