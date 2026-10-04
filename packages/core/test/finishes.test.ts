import { describe, expect, it } from "vitest";
import {
  PALETTES,
  PIGMENT_FLOOR,
  SPECIES_IDS,
  applyFinish,
  fitFinish,
  applyOp,
  applyOps,
  derive,
  diffDesigns,
  emptyDesign,
  finishLabel,
  finishOn,
  finishSchedule,
  finishedColour,
  finishesWithin,
  guessSpecies,
  speciesOf,
  normaliseFinish,
  recordConsoleOps,
  runChecks,
  toHex,
  toLinear,
  type Design,
} from "../src/index.js";

const console_ = applyOps(emptyDesign("t"), recordConsoleOps());

describe("the Satin Wood Oil palette", () => {
  const p = PALETTES[0]!;

  it("has the 64 numbered colours and four more", () => {
    expect(p.colours).toHaveLength(68);
    expect(p.colours.filter((c) => c.number).map((c) => c.number)).toEqual(Array.from({ length: 64 }, (_, i) => i + 1));
    expect(new Set(p.colours.map((c) => c.id)).size).toBe(68);
  });

  it("gives back each photographed colour on Douglas fir", () => {
    const fir = toLinear(p.colours.find((c) => c.id === "natur")!.swatch!);
    for (const c of p.colours) {
      const got = toLinear(toHex(applyFinish(fir, c)));
      const want = toLinear(c.swatch!);
      got.forEach((v, i) => expect(Math.abs(v - want[i]!), c.name).toBeLessThan(0.01));
    }
  });
});

// CIELAB, to judge colours as the eye does: L is lightness and the chroma
// is how colourful a colour is, 0 for grey.
function lab(hex: string): [number, number, number] {
  const [r, g, b] = toLinear(hex);
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const chroma = (hex: string) => Math.hypot(lab(hex)[1], lab(hex)[2]);
const deltaE = (a: string, b: string) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]!));

describe("Satin Wood Oil on other timber", () => {
  const p = PALETTES[0]!;
  const natur = p.colours.find((c) => c.id === "natur")!;
  const fir = toLinear(natur.swatch!);
  const fitted = p.colours.filter((c) => c.cover > 0);
  const on = (species: string, id: string) => finishedColour(species, `${p.id}/${id}`);
  // The dark oils, whose photos have a lightness under 30 of 100.
  const dark = p.colours.filter((c) => lab(c.swatch!)[0] < 30);
  const pale = ["birch_ply", "hoop_pine_ply", "tasmanian_oak", "radiata_pine"];

  it("keeps each tint and pigment as fitFinish makes them", () => {
    for (const c of fitted) {
      expect(fitFinish(c.swatch!, c.cover, natur.swatch!), `${c.name}: run npx tsx scripts/fit-oil-colours.ts`).toEqual({
        tint: c.tint,
        pigment: c.pigment,
      });
    }
  });

  it("matches each photo on the app's own Douglas fir", () => {
    for (const c of fitted) expect(deltaE(on("douglas_fir", c.id), c.swatch!), c.name).toBeLessThan(2);
    // Natur is the clear oil, so it shows the app's oiled fir, a shade off Linolie's board.
    expect(deltaE(on("douglas_fir", "natur"), natur.swatch!)).toBeLessThan(4);
  });

  it("never tints against the photo's own colour", () => {
    // Kyoto's tint was [0.047, 0.113, 0.475]: blue, to cancel the fir's orange.
    for (const c of fitted) {
      const s = toLinear(c.swatch!);
      for (const i of [0, 1, 2])
        for (const j of [0, 1, 2]) {
          if (s[i]! < s[j]!) continue;
          // A channel the photo has more of passes at least as much light...
          expect(c.tint[i]!, `${c.name} ${i}${j}`).toBeGreaterThanOrEqual(c.tint[j]! - 1e-4);
          // ...and the tint is no more colourful than the photo.
          expect(c.tint[i]! * s[j]!, `${c.name} ${i}${j}`).toBeLessThanOrEqual(c.tint[j]! * s[i]! + 1e-4);
        }
    }
  });

  it("leaves the pigment at least 30% of every channel of the photo", () => {
    for (const c of fitted) {
      const s = toLinear(c.swatch!);
      const pigment = toLinear(c.pigment);
      s.forEach((v, i) => expect(pigment[i]! * c.cover, c.name).toBeGreaterThanOrEqual(PIGMENT_FLOOR * v - 0.0005));
    }
  });

  it("gives no dark oil a colour on pale timber that its photo lacks", () => {
    expect(dark.map((c) => c.id)).toEqual(expect.arrayContaining(["kyoto", "tokyo", "dublin", "aarhus", "paris", "dusseldorf"]));
    for (const c of dark)
      for (const s of pale) expect(chroma(on(s, c.id)), `${c.name} on ${s}`).toBeLessThan(chroma(c.swatch!) + 3);
  });

  it("keeps any cast of a dark oil small on every timber", () => {
    // Walnut and jarrah are darkest, and they show the pigment most.
    for (const c of dark)
      for (const s of SPECIES_IDS) expect(chroma(on(s, c.id)), `${c.name} on ${s}`).toBeLessThan(chroma(c.swatch!) + 5);
  });

  it("shows Kyoto near-black on every timber", () => {
    for (const s of SPECIES_IDS) {
      const [l] = lab(on(s, "kyoto"));
      expect(l, s).toBeLessThan(25);
      expect(chroma(on(s, "kyoto")), s).toBeLessThan(10);
    }
    expect(on("birch_ply", "kyoto")).toBe("#33363a");
  });

  it("keeps the tint clear where the photo leaves room for all the grain", () => {
    for (const c of fitted) {
      const s = toLinear(c.swatch!);
      const room = s.every((v, i) => fir[i]! * (1 - c.cover) <= (1 - PIGMENT_FLOOR) * v);
      if (room) expect(c.tint, c.name).toEqual([1, 1, 1]);
    }
    expect(p.colours.find((c) => c.id === "oslo")!.tint).toEqual([1, 1, 1]);
  });

  it("lets the grain through the see-through browns and reds about as before", () => {
    // The old split let 70% of each of these photos through the timber.
    const lum = (v: readonly number[]) => 0.2126 * v[0]! + 0.7152 * v[1]! + 0.0722 * v[2]!;
    for (const id of ["horsens", "puerto_rico", "kobenhavn", "nairobi", "bilbao", "rom", "pompeji", "porto"]) {
      const c = p.colours.find((x) => x.id === id)!;
      const through = lum(fir.map((v, i) => v * c.tint[i]! * (1 - c.cover))) / lum(toLinear(c.swatch!));
      expect(through, c.name).toBeGreaterThan(0.55);
    }
  });

  it("leaves the Osmo oils as they were", () => {
    const osmo = PALETTES.find((x) => x.id === "osmo_polyx")!;
    expect(osmo.colours.map((c) => [c.id, c.tint, c.cover, c.pigment])).toEqual([
      ["raw_3044", [1, 1, 1], 0.06, "#f5f2ec"],
      ["white_3040", [1, 1, 1], 0.2, "#f5f2ec"],
      ["clear_satin_3032", [1, 1, 1], 0, "#000000"],
    ]);
    expect(["birch_ply", "douglas_fir"].map((s) => finishedColour(s, "osmo_polyx/raw_3044"))).toEqual(["#f1e4d1", "#ead8bf"]);
    expect(finishedColour("birch_ply", "osmo_polyx/white_3040")).toBe("#f1e7d5");
  });

  it("refuses a colour with no pigment, which is the sample itself", () => {
    expect(() => fitFinish(natur.swatch!, 0, natur.swatch!)).toThrow(/cover/);
  });
});

describe("naming a finish", () => {
  it("takes a name, a number or the full id", () => {
    expect(normaliseFinish("Amsterdam")).toBe("satin_wood_oil/amsterdam");
    expect(normaliseFinish("satin_wood_oil/13")).toBe("satin_wood_oil/amsterdam");
    expect(normaliseFinish("Ella Ø")).toBe("satin_wood_oil/ella_o");
    expect(normaliseFinish("tokyo lys")).toBe("satin_wood_oil/tokyo_lys");
    expect(normaliseFinish("raw")).toBe("raw");
    expect(normaliseFinish("mauve")).toBeNull();
  });
});

describe("setting finishes", () => {
  const part = (d: Design, id: string) => derive(d).parts.find((p) => p.id === id)!;

  it("lets a face beat its part, and a part beat its material", () => {
    const d = applyOps(console_, [
      { op: "set_finish", targets: ["material:front_18"], finish: "natur" },
      { op: "set_finish", targets: ["false_front#2"], finish: "13" },
      { op: "set_finish", targets: ["false_front.front"], finish: "oslo" },
    ]);
    expect(finishOn(d, part(d, "false_front"), "back")).toBe("satin_wood_oil/natur");
    expect(finishOn(d, part(d, "false_front"), "front")).toBe("satin_wood_oil/oslo");
    expect(finishOn(d, part(d, "false_front#2"), "back")).toBe("satin_wood_oil/amsterdam");
    expect(finishOn(d, part(d, "false_front#2"), "front")).toBe("satin_wood_oil/oslo");
    expect(finishOn(d, part(d, "left_side"), "front")).toBeUndefined();
  });

  it("lets a colour on a material or piece replace the colours inside it", () => {
    let d = applyOps(console_, [
      { op: "set_finish", targets: ["false_front", "false_front#2.front", "top.top"], finish: "oslo" },
      { op: "set_finish", targets: ["material:front_18"], finish: "wien" },
    ]);
    expect(d.finishes).toEqual({ "top.top": "satin_wood_oil/oslo", "material:front_18": "satin_wood_oil/wien" });
    d = applyOps(d, [
      { op: "set_finish", targets: ["false_front#3.front"], finish: "13" },
      { op: "set_finish", targets: ["false_front#3"], finish: "natur" },
      { op: "set_finish", targets: ["top"], finish: "natur" },
    ]);
    expect(d.finishes).toEqual({ "material:front_18": "satin_wood_oil/wien", "false_front#3": "satin_wood_oil/natur", top: "satin_wood_oil/natur" });
  });

  it("finishes an array's original alone with #1", () => {
    const d = applyOp(console_, { op: "set_finish", targets: ["false_front#1"], finish: "wien" });
    expect(finishOn(d, part(d, "false_front"), "front")).toBe("satin_wood_oil/wien");
    expect(finishOn(d, part(d, "false_front#2"), "front")).toBeUndefined();
    expect(runChecks(d, derive(d)).issues.some((i) => i.code === "finish_target")).toBe(false);
  });

  it("can leave a face raw and clear a finish", () => {
    let d = applyOps(console_, [
      { op: "set_finish", targets: ["top"], finish: "wien" },
      { op: "set_finish", targets: ["top.bottom"], finish: "raw" },
    ]);
    expect(finishOn(d, part(d, "top"), "bottom")).toBeUndefined();
    d = applyOp(d, { op: "set_finish", targets: ["top", "top.bottom"], finish: null });
    expect(d.finishes).toBeUndefined();
  });

  it("refuses unknown finishes, faces and parts", () => {
    expect(() => applyOp(console_, { op: "set_finish", targets: ["top"], finish: "mauve" })).toThrow(/isn't known/);
    expect(() => applyOp(console_, { op: "set_finish", targets: ["top.side"], finish: "wien" })).toThrow(/must be/);
    expect(() => applyOp(console_, { op: "set_finish", targets: ["nope"], finish: "wien" })).toThrow(/no part "nope"/);
    expect(() => applyOp(console_, { op: "set_finish", targets: ["material:nope"], finish: "wien" })).toThrow(/no material/);
  });

  it("drops a deleted part's finishes", () => {
    const d = applyOps(console_, [
      { op: "set_finish", targets: ["drawer_bottom", "drawer_bottom#3.top", "top"], finish: "wien" },
      { op: "delete_part", id: "drawer_bottom" },
    ]);
    expect(d.finishes).toEqual({ top: "satin_wood_oil/wien" });
  });

  it("warns about a finish on an array copy that's gone", () => {
    const d = applyOp(console_, { op: "set_finish", targets: ["false_front#9"], finish: "wien" });
    const report = runChecks(d, derive(d));
    expect(report.issues.some((i) => i.code === "finish_target")).toBe(true);
  });

  it("refuses an unknown species", () => {
    const m = console_.materials[0]!;
    expect(() => applyOp(console_, { op: "define_material", ...m, species: "unobtainium" })).toThrow(/Species/);
    const d = applyOp(console_, { op: "define_material", ...m, species: "jarrah" });
    expect(d.materials[0]!.species).toBe("jarrah");
  });

  it("says what changed in a version, one line per colour", () => {
    const d = applyOp(console_, { op: "set_finish", targets: ["top"], finish: "13" });
    expect(diffDesigns(console_, d)).toEqual(["Finished top with 13 Amsterdam"]);
    const many = applyOp(d, { op: "set_finish", targets: ["material:front_18"], finish: "wien" });
    const more = applyOp(many, { op: "set_finish", targets: ["false_front", "false_front#2", "false_front#3", "false_front#4"], finish: "oslo" });
    expect(diffDesigns(many, more)).toEqual(["Finished false_front, false_front#2 and 2 more with 21 Oslo"]);
    expect(diffDesigns(more, applyOp(more, { op: "set_finish", targets: ["material:front_18"], finish: "wien" }))).toEqual([
      "Took the finish off false_front, false_front#2 and 2 more",
    ]);
  });
});

describe("how much oil", () => {
  it("adds up every finished face", () => {
    let d = applyOps(emptyDesign("t"), [
      { op: "define_material", id: "ply", name: "ply", kind: "sheet", thickness_mm: 18, grained: true },
      {
        op: "add_panel",
        id: "panel",
        name: "Panel",
        material: "ply",
        thickness_axis: "y",
        grain_axis: "x",
        x: { start: { at: "0" }, size: "1000" },
        y: { start: { at: "0" } },
        z: { start: { at: "0" }, size: "500" },
      },
      { op: "set_finish", targets: ["material:ply"], finish: "natur" },
    ]);
    // Two big faces, two long edges and two short ones.
    expect(finishSchedule(d, derive(d).parts)).toEqual([
      { finish: "satin_wood_oil/natur", label: "Natur", area_m2: 1.05, litres: 0.15 },
    ]);
    d = applyOp(d, { op: "set_finish", targets: ["panel.bottom"], finish: "raw" });
    expect(finishSchedule(d, derive(d).parts)[0]!.area_m2).toBe(0.55);
  });
});

describe("timber from a material's name", () => {
  it("reads common names, most specific first", () => {
    expect(guessSpecies("Douglas fir (Oregon), dressed 42 mm")).toBe("douglas_fir");
    expect(guessSpecies("Birch plywood 18 mm")).toBe("birch_ply");
    expect(guessSpecies("17 mm hoop pine ply")).toBe("hoop_pine_ply");
    expect(guessSpecies("Tas oak 19 × 42")).toBe("tasmanian_oak");
    expect(guessSpecies("American white oak")).toBe("white_oak");
    expect(guessSpecies("90 × 45 pine")).toBe("radiata_pine");
    expect(guessSpecies("30 mm carcass panel")).toBeUndefined();
  });

  it("lets a set species win over the name", () => {
    expect(speciesOf({ kind: "solid", name: "Douglas fir", species: "jarrah" }).id).toBe("jarrah");
    expect(speciesOf({ kind: "solid", name: "Douglas fir" }).id).toBe("douglas_fir");
    expect(speciesOf({ kind: "sheet", name: "carcass panel" }).id).toBe("birch_ply");
  });
});

describe("finishes within a material", () => {
  it("finds the piece and face finishes that would hide a material finish", () => {
    const d = applyOp(console_, { op: "set_finish", targets: ["false_front#2", "false_front.front", "top", "material:front_18"], finish: "wien" });
    expect(finishesWithin(d, ["front_18"]).sort()).toEqual(["false_front#2", "false_front.front"]);
  });
});

describe("Osmo Polyx-Oil", () => {
  const lum = (hex: string) => {
    const [r, g, b] = toLinear(hex);
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };

  it("is found by its number or name", () => {
    expect(normaliseFinish("3044")).toBe("osmo_polyx/raw_3044");
    expect(normaliseFinish("osmo_polyx/white")).toBe("osmo_polyx/white_3040");
    expect(finishLabel("osmo_polyx/raw_3044")).toBe("Osmo 3044 Raw");
    expect(finishLabel("satin_wood_oil/amsterdam")).toBe("13 Amsterdam");
  });

  it("keeps birch ply looking bare with Raw, a touch whiter, and whiter still with White", () => {
    const bare = lum(finishedColour("birch_ply", "raw"));
    const raw3044 = lum(finishedColour("birch_ply", "osmo_polyx/raw_3044"));
    const white3040 = lum(finishedColour("birch_ply", "osmo_polyx/white_3040"));
    const clear = lum(finishedColour("birch_ply", "osmo_polyx/clear_satin_3032"));
    expect(clear).toBeLessThan(bare);
    expect(raw3044).toBeGreaterThan(bare);
    expect(raw3044 - bare).toBeLessThan(0.05);
    expect(white3040).toBeGreaterThan(raw3044);
  });

  it("draws bare Douglas fir much paler than oiled", () => {
    expect(lum(finishedColour("douglas_fir", "raw"))).toBeGreaterThan(lum(finishedColour("douglas_fir", "natur")) * 1.6);
  });
});
