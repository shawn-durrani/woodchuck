// Issue #40: edits that read what was meant without changing it. A number
// may come as a JSON number or wrapped in one pair of quotes, and nothing
// looser. The same add sent again changes nothing, and a different one under
// the same id is refused with what's there. A thickness axis given two ends
// says what to send instead, and every field of the wrong shape quotes an
// example of the right one. The fixture is an invented plant stand: a 45 mm
// ash leg under a 12 mm ply top, and a stand-in pot.

import { describe, expect, it } from "vitest";
import { applyOp, applyOps, emptyDesign, exprInput, SHAPES, type Design, type Op, type Plan } from "../src/index.js";

const ash: Op = { op: "define_material", id: "ash45", name: "45 mm ash", kind: "solid", thickness_mm: 45, grained: true };
const ply: Op = { op: "define_material", id: "ply12", name: "12 mm birch ply", kind: "sheet", thickness_mm: 12, grained: true, sheet_sizes_mm: [[2440, 1220]] };
const height: Op = { op: "set_param", name: "height", expr: "600", unit: "mm" };
const leg = {
  op: "add_panel",
  id: "leg",
  name: "Leg",
  material: "ash45",
  thickness_axis: "x",
  grain_axis: "y",
  x: { start: { at: "0" } },
  y: { start: { at: "0" }, end: { at: "height" } },
  z: { start: { at: "0" }, size: "45" },
} as Op;
const top = {
  op: "add_panel",
  id: "top",
  name: "Top",
  material: "ply12",
  thickness_axis: "y",
  grain_axis: "x",
  x: { start: { at: "0" }, size: "400" },
  y: { start: { face: "leg.top" } },
  z: { start: { at: "0" }, size: "300" },
} as Op;
const screws: Op = { op: "add_joint", id: "top_leg", type: "screws", host: "top", guest: "leg" };
const pot: Op = { op: "add_unverified_box", id: "pot", name: "Pot", min_mm: [50, 612, 50], max_mm: [250, 812, 250], reason: "No tool for pots yet" };
const tall: Op = { op: "set_rule", id: "tall", expr: "top.top >= 500", severity: "error", message: "The top should be at least 500 mm up" };

const stand = (): Design => applyOps(emptyDesign("Plant stand"), [ash, ply, height, leg, top, screws, pot, tall]);
const refused = (d: Design, op: unknown) => {
  try {
    applyOp(d, op as Op);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("not refused");
};
const part = (d: Design, id: string) => d.parts.find((p) => p.id === id)!;
const hole = (diameter: unknown, x: unknown = "200") => ({ op: "set_cutout", id: "top", cut: "hole", shape: "circle", centre: { x: { at: x }, z: { at: "150" } }, diameter }) as unknown as Op;
const cutOf = (d: Design) => part(d, "top").cuts![0]!;

describe("an expression given as a number", () => {
  it("reads a JSON number as its digits, in every kind of field", () => {
    const d = applyOps(emptyDesign("Plant stand"), [
      ash,
      ply,
      { op: "set_param", name: "height", expr: 600 },
      { ...leg, y: { start: { at: 0 }, end: { at: "height" } }, z: { start: { at: 0 }, size: 45 } },
      { ...top, y: { start: { face: "leg.top", offset: -2 } } },
      { op: "add_joint", id: "top_leg", type: "dowels", host: "top", guest: "leg", diameter: 8, length: 30 },
      { op: "set_array", id: "legs", parts: ["leg"], axis: "x", count: 2, pitch: 355 },
      { op: "set_cutout", id: "top", cut: "slot", shape: "rect", x: { start: { at: 100 }, size: 120 }, z: { start: { at: 40 }, size: 20 }, radius: 10 },
    ] as unknown as Op[]);
    expect(d.params[0]!.expr).toBe("600");
    expect(part(d, "leg").y).toEqual({ start: { at: "0" }, end: { at: "height" } });
    expect(part(d, "leg").z).toEqual({ start: { at: "0" }, size: "45" });
    expect(part(d, "top").y).toEqual({ start: { face: "leg.top", offset: "-2" } });
    expect(d.joints[0]).toMatchObject({ diameter: "8", length: "30" });
    expect(d.arrays[0]).toMatchObject({ count: "2", pitch: "355" });
    expect(cutOf(d)).toMatchObject({ x: { start: { at: "100" }, size: "120" }, radius: "10" });
  });

  it("reads a number in one pair of matching quotes as the number inside", () => {
    let d = applyOp(stand(), hole('"20"', "'200'"));
    expect(cutOf(d)).toMatchObject({ centre: { x: { at: "200" } }, diameter: "20" });
    d = applyOp(stand(), { ...top, id: "shelf", y: { start: { at: "'-12.5'" } } } as Op);
    expect(part(d, "shelf").y).toEqual({ start: { at: "-12.5" } });
    d = applyOp(stand(), { op: "set_param", name: "height", expr: '"640"', unit: "mm" });
    expect(d.params[0]!.expr).toBe("640");
    const plan: Plan = { status: "proposed", summary: "A plant stand.", parts: [], key_dims: [{ label: "Height", expr: "'600'", expected_mm: 600 }], joints: [], assumptions: [] };
    d = applyOp(stand(), { op: "set_plan", plan });
    expect(d.plan!.key_dims[0]!.expr).toBe("600");
  });

  it("refuses anything looser, rather than guess", () => {
    const junk: unknown[] = ['"20', "'20\"", '""20""', '"height"', '"20 + 5"', "20mm", true, { at: "20" }, [20], Number.NaN, Number.POSITIVE_INFINITY];
    for (const v of junk) expect(refused(stand(), hole(v))).toMatch(/^(Couldn't read .* for top cut hole diameter|top cut hole diameter needs a number or a formula)/);
    expect(refused(stand(), hole('"20"', '"bay"'))).toBe('Couldn\'t read ""bay"" for top cut hole centre.x: unexpected character """ at position 1');
    expect(refused(stand(), hole(true))).toBe('top cut hole diameter needs a number or a formula, such as "600" or "bay - 2 * 18"');
  });

  it("strips the quotes from a number and nothing else", () => {
    expect(exprInput(20)).toBe("20");
    expect(exprInput(-2.5)).toBe("-2.5");
    expect(exprInput('"20"')).toBe("20");
    expect(exprInput(" '.5' ")).toBe(".5");
    expect(exprInput("bay - 18")).toBe("bay - 18");
    expect(exprInput('"bay"')).toBe('"bay"');
    expect(exprInput("'20\"")).toBe("'20\"");
    expect(exprInput('""20""')).toBe('""20""');
    expect(exprInput(Number.NaN)).toBeNull();
    expect(exprInput(null)).toBeNull();
    expect(exprInput({ at: "20" })).toBeNull();
  });
});

describe("the same add again", () => {
  it("changes nothing, for every kind, and hands back the design itself", () => {
    const d = stand();
    for (const op of [ash, ply, height, leg, top, screws, pot, tall]) expect(applyOp(d, op)).toBe(d);
  });

  it("matches however its numbers are written", () => {
    const d = stand();
    const same = { ...leg, x: { start: { at: 0 } }, y: { start: { at: "'0'" }, end: { at: "height" } }, z: { size: 45, start: { at: '"0"' } } } as unknown as Op;
    expect(applyOp(d, same)).toBe(d);
    expect(applyOp(d, { ...screws, note: undefined } as Op)).toBe(d);
  });

  it("leaves a panel's cuts alone, since add_panel brings none", () => {
    const d = applyOp(stand(), hole("20"));
    expect(applyOp(d, top)).toBe(d);
    expect(part(d, "top").cuts).toHaveLength(1);
  });

  it("lets a list of edits run on past it", () => {
    const d = applyOps(stand(), [leg, screws, { op: "set_param", name: "height", expr: "650", unit: "mm" }]);
    expect(d.params[0]!.expr).toBe("650");
  });

  it("refuses a different part, joint or stand-in under the same id, and shows the one there", () => {
    expect(refused(stand(), { ...leg, z: { start: { at: "0" }, size: "40" } })).toBe(
      'Part "leg" already exists, and this one differs in z. It\'s {"name": "Leg", "material": "ash45", "thickness_axis": "x", "grain_axis": "y", ' +
        '"x": {"start": {"at": "0"}}, "y": {"start": {"at": "0"}, "end": {"at": "height"}}, "z": {"start": {"at": "0"}, "size": "45"}}. ' +
        "Use update_panel to change it, or pick a new id",
    );
    expect(refused(stand(), { ...screws, count: 4 })).toBe(
      'Joint "top_leg" already exists, and this one differs in count. It\'s {"type": "screws", "host": "top", "guest": "leg"}. To change it, delete_joint it and add it again, or pick a new id',
    );
    expect(refused(stand(), { ...pot, max_mm: [250, 900, 250] })).toBe(
      'Stand-in box "pot" already exists, and this one differs in max_mm. It\'s {"name": "Pot", "min_mm": [50, 612, 50], "max_mm": [250, 812, 250], "reason": "No tool for pots yet"}. ' +
        "To change it, delete_part it and add it again, or pick a new id",
    );
    // One that can't be read at all is still named as taken, with what's there.
    expect(refused(stand(), { ...screws, type: "glue" })).toMatch(/^Joint "top_leg" already exists\. It's \{"type": "screws"/);
    expect(refused(stand(), { ...leg, id: "pot" })).toBe('Part "pot" already exists as a stand-in box. delete_part it first to replace it, or pick a new id');
    expect(refused(stand(), { ...pot, id: "leg" })).toBe('Part "leg" already exists as a panel. Pick a new id');
  });

  it("still changes a material, a parameter or a rule, which their tools create or change", () => {
    const d = applyOps(stand(), [
      { ...ash, name: "45 mm white ash" } as Op,
      { op: "set_param", name: "height", expr: "640", unit: "mm" },
      { ...tall, expr: "top.top >= 550" } as Op,
    ]);
    expect(d.materials[0]!.name).toBe("45 mm white ash");
    expect(d.params[0]!.expr).toBe("640");
    expect(d.rules[0]!.expr).toBe("top.top >= 550");
  });
});

describe("a thickness axis given more than one end", () => {
  const legWith = (x: unknown) => ({ ...leg, id: "leg_b", x }) as Op;

  it("says what to send instead, in the caller's own values, and what sets the size", () => {
    expect(refused(stand(), legWith({ start: { at: "400" }, end: { at: "445" } }))).toBe(
      "leg_b.x is the thickness axis, so its size is the 45 mm thickness of material ash45, and it takes exactly one of start or end. It was given start and end. " +
        'Send {"x": {"start": {"at": "400"}}}, or {"x": {"end": {"at": "445"}}} to place it by its right face. For another thickness, give the part a material that thick',
    );
  });

  it("keeps the end that was given, and offers a start when none was", () => {
    expect(refused(stand(), legWith({ end: { face: "top.right" }, size: "45" }))).toContain('It was given end and size. Send {"x": {"end": {"face": "top.right"}}}.');
    expect(refused(stand(), legWith({ size: 45 }))).toContain('It was given size. Send {"x": {"start": {"at": "0"}}}.');
    expect(refused(stand(), legWith({}))).toContain('It was given neither. Send {"x": {"start": {"at": "0"}}}.');
  });
});

describe("a field of the wrong shape", () => {
  const hardware = (extra: Record<string, unknown>) => ({ op: "set_hardware", id: "glides", kind: "glide", name: "Glides", connects: ["leg"], ...extra }) as unknown as Op;
  const model = [{ name: "body", min_mm: [0, 0, 0], max_mm: [20, 10, 20] }];
  const cases: Record<keyof typeof SHAPES, unknown> = {
    sheet_sizes_mm: { ...ply, sheet_sizes_mm: [2440, 1220] },
    sheet_mm: { op: "set_stock", material: "ply12", sheet_mm: ["2440", "1220"] },
    lengths_mm: { op: "set_stock", material: "ash45", lengths_mm: [] },
    widths_mm: { op: "set_stock", material: "ash45", widths_mm: [] },
    owned: { op: "set_stock", material: "ash45", owned: [{ length_mm: "2400", width_mm: 90 }] },
    tags: { ...leg, id: "leg_b", tags: "legs" },
    parts: { op: "set_array", id: "legs", parts: "leg", axis: "x", count: "2", pitch: "355" },
    connects: hardware({ connects: "leg" }),
    spec: hardware({ spec: [30] }),
    place: hardware({ shape: model, place: [0, 0, 0] }),
    min_mm: { ...pot, id: "bowl", min_mm: [0, 0] },
    max_mm: { ...pot, id: "bowl", max_mm: { x: 1, y: 1, z: 1 } },
    targets: { op: "set_finish", targets: "leg", finish: "natur" },
    stop: { op: "add_joint", id: "top_dado", type: "dado", host: "leg", guest: "top", stop: "10" },
  };

  it("quotes an example of the right shape for every list or object field", () => {
    for (const [field, op] of Object.entries(cases)) {
      const { rule, example } = SHAPES[field as keyof typeof SHAPES];
      const message = refused(stand(), op);
      expect(message.endsWith(` ${rule}. Example: "${field}": ${example}`), message).toBe(true);
    }
    expect(refused(stand(), cases.sheet_sizes_mm)).toBe('sheet_sizes_mm must be a list of [length along the grain, width] pairs in mm. Example: "sheet_sizes_mm": [[2440, 1220]]');
  });

  it("quotes a bound written both ways, with a face on the bound's own axis", () => {
    expect(refused(stand(), { ...top, id: "shelf", y: { start: "200" } })).toBe(
      'shelf.y.start must be {"at": expression} or {"face": "part.face", "offset": expression}. Example: {"at": "0"} or {"face": "base.top", "offset": "2"}',
    );
    expect(refused(stand(), { ...top, id: "shelf", x: { start: {}, size: "400" } })).toContain('Example: {"at": "0"} or {"face": "left_side.right", "offset": "2"}');
    // A field left over would be dropped without a word, so it's refused.
    expect(refused(stand(), { ...top, id: "shelf", y: { start: { at: "200", offset: "-2" } } })).toBe(
      'shelf.y.start must be {"at": expression} or {"face": "part.face", "offset": expression}, so offset can\'t go with at. Example: {"at": "0"} or {"face": "base.top", "offset": "2"}',
    );
    expect(refused(stand(), { ...top, id: "shelf", y: { start: { face: "leg.top", ofset: "-2" } } })).toContain("so ofset can't go with face. Example:");
    expect(refused(stand(), { ...top, id: "shelf", y: { start: { face: "leg.top", at: "0" } } })).toContain("so face can't go with at. Example:");
  });

  it("quotes a span, and one end alone on a thickness axis", () => {
    expect(refused(stand(), { ...top, id: "shelf", z: [0, 300] })).toBe('shelf.z must be an object of two of start, end and size. Example: {"start": {"at": "0"}, "size": "600"}');
    expect(refused(stand(), { ...top, id: "shelf", z: { from: "0", size: "300" } })).toBe('shelf.z takes only start, end and size, not from. Example: {"start": {"at": "0"}, "size": "600"}');
    expect(refused(stand(), { ...top, id: "shelf", y: "200" })).toBe('shelf.y must be an object of start or end. Example: {"start": {"at": "0"}}');
    expect(refused(stand(), { op: "set_cutout", id: "top", cut: "slot", shape: "rect", x: "100..220", z: { start: { at: "40" }, size: "20" } })).toBe(
      'top cut slot.x must be an object of two of start, end and size. Example: {"start": {"at": "0"}, "size": "600"}',
    );
  });
});
