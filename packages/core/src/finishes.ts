// Finishes: what goes on the wood, and where. A finish is set on a
// material, a whole part or one face of a part. A face beats its part,
// and a part beats its material. Anything with no finish is raw timber.
//
// Linolie's Satin Wood Oil colours were sampled on 3 October 2026 from
// the photos on its product page, which all show the oil on Douglas fir.
// Each colour is split into two parts. A tint darkens the wood like a
// dye and lets the grain through. A pigment covers the wood, and `cover`
// says how much. How much grain shows in each photo sets the cover.
// `fitFinish` splits each photo into a tint and a pigment that add back
// up to it on the fir in Natur's photo, and on other species the result
// is an estimate, so order a wet sample before you commit. The tint and
// pigment below are its output: after changing a swatch or a cover, run
// `npx tsx scripts/fit-oil-colours.ts` to write them again.

import { SPECIES, type Species } from "./species.js";
import { FACES, type Design, type Face } from "./types.js";
import type { DerivedPart } from "./derive.js";
import { faceAreas } from "./profile.js";

export interface FinishColour {
  id: string;
  /** The number in the maker's colour card. */
  number?: number;
  name: string;
  /** The colour as the maker photographed it, on its palette's sample timber. */
  swatch?: string;
  /**
   * What the finish starts from: the timber darkened by oil (the usual), or
   * the bare timber, for finishes made to keep wood looking untreated.
   */
  base?: "oiled" | "raw";
  /** How shiny it dries. Satin unless it says otherwise. */
  sheen?: "matt" | "satin";
  /** A line on what it's for, when the name doesn't say. */
  note?: string;
  /** How much of each of red, green and blue light the oil lets through, in linear light. */
  tint: [number, number, number];
  /** How much the pigment covers the wood, from 0 to 1. */
  cover: number;
  /** The covering pigment's colour. */
  pigment: string;
}

export interface FinishPalette {
  id: string;
  maker: string;
  name: string;
  url: string;
  /** Area one litre covers with the usual number of coats. */
  m2_per_litre: number;
  coats: number;
  /** The species its swatches were photographed on, when there are photos. */
  photographed_on?: string;
  /** Where its colours come from, in a sentence. */
  source: string;
  colours: FinishColour[];
}

const SATIN_WOOD_OIL: FinishColour[] = [
  { id: "wien", number: 1, name: "Wien", swatch: "#28312e", tint: [0.0336, 0.0487, 0.0433], cover: 0.3, pigment: "#284d52" },
  { id: "brighton", number: 2, name: "Brighton", swatch: "#54683c", tint: [0.1406, 0.2195, 0.0716], cover: 0.3, pigment: "#549d68" },
  { id: "osby", number: 3, name: "Øsby", swatch: "#c4b16b", tint: [1, 1, 1], cover: 0.902, pigment: "#c3b56e" },
  { id: "hanoi", number: 4, name: "Hanoi", swatch: "#969073", tint: [1, 1, 1], cover: 0.839, pigment: "#879279" },
  { id: "london", number: 5, name: "London", swatch: "#635646", tint: [0.3532, 0.3532, 0.3532], cover: 0.608, pigment: "#465852" },
  { id: "verona", number: 6, name: "Verona", swatch: "#6d8063", tint: [0.638, 0.9006, 0.5206], cover: 0.734, pigment: "#47806e" },
  { id: "haderslev", number: 7, name: "Haderslev", swatch: "#afb69c", tint: [1, 1, 1], cover: 0.86, pigment: "#a9bca5" },
  { id: "ella_o", number: 8, name: "Ella Ø", swatch: "#8e9c87", tint: [1, 1, 1], cover: 0.748, pigment: "#6ca295" },
  { id: "budapest", number: 9, name: "Budapest", swatch: "#768872", tint: [0.7005, 0.952, 0.6507], cover: 0.713, pigment: "#4e8a80" },
  { id: "mombasa", number: 10, name: "Mombasa", swatch: "#a19b8d", tint: [1, 1, 1], cover: 0.853, pigment: "#979e95" },
  { id: "nordkap", number: 11, name: "Nordkap", swatch: "#345951", tint: [0.0778, 0.2263, 0.1864], cover: 0.51, pigment: "#276a6b" },
  { id: "rio_de_janeiro", number: 12, name: "Rio de Janeiro", swatch: "#023d31", tint: [0.001, 0.074, 0.0487], cover: 0.3, pigment: "#025f56" },
  { id: "amsterdam", number: 13, name: "Amsterdam", swatch: "#2b3a3a", tint: [0.0383, 0.0671, 0.0671], cover: 0.3, pigment: "#2b5a65" },
  { id: "namche_bazar", number: 14, name: "Namche Bazar", swatch: "#8baaa1", tint: [1, 1, 1], cover: 0.832, pigment: "#77b0ac" },
  { id: "dublin", number: 15, name: "Dublin", swatch: "#1d1e22", tint: [0.0195, 0.0206, 0.0254], cover: 0.3, pigment: "#1d323f" },
  { id: "tokyo", number: 16, name: "Tokyo", swatch: "#14181c", tint: [0.0111, 0.0145, 0.0184], cover: 0.3, pigment: "#142935" },
  { id: "lissabon", number: 17, name: "Lissabon", swatch: "#222a2c", tint: [0.0254, 0.0367, 0.0399], cover: 0.3, pigment: "#22434f" },
  { id: "ankara", number: 18, name: "Ankara", swatch: "#295d6a", tint: [0.0639, 0.3155, 0.4155], cover: 0.615, pigment: "#1b6580" },
  { id: "athen", number: 19, name: "Athen", swatch: "#629aa0", tint: [0.6051, 1, 1], cover: 0.776, pigment: "#3d9fb0" },
  { id: "paris", number: 20, name: "Paris", swatch: "#162434", tint: [0.0127, 0.028, 0.0544], cover: 0.3, pigment: "#163a5b" },
  { id: "oslo", number: 21, name: "Oslo", swatch: "#c6c9c5", tint: [1, 1, 1], cover: 0.804, pigment: "#c3d5d7" },
  { id: "svinklov", number: 22, name: "Svinkløv", swatch: "#c6b4a5", tint: [1, 1, 1], cover: 0.769, pigment: "#c3bfb6" },
  { id: "ribe", number: 23, name: "Ribe", swatch: "#3f3e3a", tint: [0.0788, 0.0788, 0.0788], cover: 0.3, pigment: "#3f6064" },
  { id: "kyoto", number: 24, name: "Kyoto", swatch: "#302e34", tint: [0.0469, 0.0469, 0.0469], cover: 0.3, pigment: "#30485c" },
  { id: "tel_aviv", number: 25, name: "Tel Aviv", swatch: "#dcc6b6", tint: [1, 1, 1], cover: 0.629, pigment: "#e3e1da" },
  { id: "nuuk", number: 26, name: "Nuuk", swatch: "#dfc1a7", tint: [1, 1, 1], cover: 0.569, pigment: "#eae1cf" },
  { id: "thorshavn", number: 27, name: "Thorshavn", swatch: "#72645a", tint: [0.4104, 0.4104, 0.4104], cover: 0.545, pigment: "#566c70" },
  { id: "glasgow", number: 28, name: "Glasgow", swatch: "#666762", tint: [0.4213, 0.4301, 0.3873], cover: 0.65, pigment: "#466d73" },
  { id: "berlin", number: 29, name: "Berlin", swatch: "#4f4943", tint: [0.1675, 0.1675, 0.1675], cover: 0.482, pigment: "#3e575b" },
  { id: "gent", number: 30, name: "Gent", swatch: "#465a6e", tint: [0.1368, 0.2283, 0.3482], cover: 0.503, pigment: "#366c91" },
  { id: "helsinki", number: 31, name: "Helsinki", swatch: "#98b4bb", tint: [1, 1, 1], cover: 0.881, pigment: "#8eb9c4" },
  { id: "delft", number: 32, name: "Delft", swatch: "#242b44", tint: [0.028, 0.0383, 0.0916], cover: 0.3, pigment: "#244575" },
  { id: "blavand", number: 33, name: "Blåvand", swatch: "#739caf", tint: [1, 1, 1], cover: 0.867, pigment: "#599fb9" },
  { id: "aarhus", number: 34, name: "Aarhus", swatch: "#272834", tint: [0.0322, 0.0336, 0.0544], cover: 0.3, pigment: "#27405b" },
  { id: "toulouse", number: 35, name: "Toulouse", swatch: "#656879", tint: [0.4126, 0.4389, 0.6063], cover: 0.65, pigment: "#456e8e" },
  { id: "cairo", number: 36, name: "Cairo", swatch: "#939aac", tint: [1, 1, 1], cover: 0.839, pigment: "#839db8" },
  { id: "mombai", number: 37, name: "Mombai", swatch: "#322c2d", tint: [0.0506, 0.0506, 0.0506], cover: 0.3, pigment: "#32434f" },
  { id: "dubrovnik", number: 38, name: "Dubrovnik", swatch: "#b7a9b8", tint: [1, 1, 1], cover: 0.832, pigment: "#b1afc5" },
  { id: "floriana", number: 39, name: "Floriana", swatch: "#cb3b5e", tint: [1, 0.6225, 1], cover: 0.797, pigment: "#ca2362" },
  { id: "honolulu", number: 40, name: "Honolulu", swatch: "#3e2e2d", tint: [0.0764, 0.0764, 0.0764], cover: 0.3, pigment: "#3e3e4d" },
  { id: "prag", number: 41, name: "Prag", swatch: "#c3b5b6", tint: [1, 1, 1], cover: 0.867, pigment: "#c1bbc0" },
  { id: "katmandu", number: 42, name: "Katmandu", swatch: "#b89497", tint: [1, 1, 1], cover: 0.846, pigment: "#b396a0" },
  { id: "nice", number: 43, name: "Nice", swatch: "#dfb6a9", tint: [1, 1, 1], cover: 0.839, pigment: "#e2bdb4" },
  { id: "sofia", number: 44, name: "Sofia", swatch: "#836c68", tint: [1, 1, 1], cover: 0.797, pigment: "#63646e" },
  { id: "havana", number: 45, name: "Havana", swatch: "#cd978b", tint: [1, 1, 1], cover: 0.888, pigment: "#cd9991" },
  { id: "beijing", number: 46, name: "Beijing", swatch: "#bc5b44", tint: [1, 0.8467, 0.7746], cover: 0.643, pigment: "#b03e45" },
  { id: "moskva", number: 47, name: "Moskva", swatch: "#d5202e", tint: [1, 0.1192, 0.1923], cover: 0.65, pigment: "#d81334" },
  { id: "bilbao", number: 48, name: "Bilbao", swatch: "#964739", tint: [0.4835, 0.2573, 0.2165], cover: 0.3, pigment: "#964859" },
  { id: "lima", number: 49, name: "Lima", swatch: "#f4a984", tint: [1, 1, 1], cover: 0.846, pigment: "#faae8b" },
  { id: "rom", number: 50, name: "Rom", swatch: "#7a4237", tint: [0.3085, 0.2244, 0.2054], cover: 0.3, pigment: "#7a4256" },
  { id: "porto", number: 51, name: "Porto", swatch: "#593c34", tint: [0.1584, 0.1584, 0.1584], cover: 0.3, pigment: "#594654" },
  { id: "balmoral", number: 52, name: "Balmoral", swatch: "#382d28", tint: [0.0627, 0.0627, 0.0627], cover: 0.3, pigment: "#384045" },
  { id: "assisi", number: 53, name: "Assisi", swatch: "#ab897a", tint: [1, 1, 1], cover: 0.804, pigment: "#a08982" },
  { id: "nairobi", number: 54, name: "Nairobi", swatch: "#6e4f39", tint: [0.2472, 0.2472, 0.2472], cover: 0.3, pigment: "#6e6257" },
  { id: "horsens", number: 55, name: "Horsens", swatch: "#915938", tint: [0.4489, 0.4045, 0.3687], cover: 0.3, pigment: "#915b4b" },
  { id: "puerto_rico", number: 56, name: "Puerto Rico", swatch: "#936142", tint: [0.4626, 0.4626, 0.4626], cover: 0.3, pigment: "#93675b" },
  { id: "kobenhavn", number: 57, name: "København", swatch: "#795340", tint: [0.3031, 0.3031, 0.3031], cover: 0.3, pigment: "#796061" },
  { id: "pompeji", number: 58, name: "Pompeji", swatch: "#a34c34", tint: [0.5709, 0.2983, 0.2215], cover: 0.3, pigment: "#a64c4e" },
  { id: "new_delhi", number: 59, name: "New Delhi", swatch: "#bf7c56", tint: [1, 1, 1], cover: 0.748, pigment: "#b97859" },
  { id: "roussillon", number: 60, name: "Roussillon", swatch: "#bb7a34", tint: [1, 1, 1], cover: 0.762, pigment: "#b47629" },
  { id: "goteborg", number: 61, name: "Gøteborg", swatch: "#e8ae72", tint: [1, 1, 1], cover: 0.727, pigment: "#f0ba7d" },
  { id: "casablanca", number: 62, name: "Casablanca", swatch: "#ddb785", tint: [1, 1, 1], cover: 0.671, pigment: "#e3c998" },
  { id: "cusco", number: 63, name: "Cusco", swatch: "#d6b63e", tint: [1, 1, 1], cover: 0.594, pigment: "#dacf32" },
  { id: "reykjavik", number: 64, name: "Reykjavik", swatch: "#d2bc99", tint: [1, 1, 1], cover: 0.541, pigment: "#d4ddc0" },
  { id: "natur", name: "Natur", swatch: "#d0874c", tint: [1, 1, 1], cover: 0, pigment: "#000000" },
  { id: "dusseldorf", name: "Düsseldorf", swatch: "#16171a", tint: [0.0127, 0.0136, 0.0164], cover: 0.3, pigment: "#162832" },
  { id: "tokyo_lys", name: "Tokyo Lys", swatch: "#524a34", tint: [0.1338, 0.1338, 0.1338], cover: 0.3, pigment: "#526d55" },
  { id: "paris_lys", name: "Paris Lys", swatch: "#233d48", tint: [0.0266, 0.074, 0.1027], cover: 0.3, pigment: "#235f7b" },
];

export const PALETTES: FinishPalette[] = [
  {
    id: "satin_wood_oil",
    maker: "Linolie & Pigment",
    name: "Satin Wood Oil",
    url: "https://linolie.dk/en/products/satin-wood-oil.lin10.020/",
    m2_per_litre: 10,
    coats: 2,
    photographed_on: "douglas_fir",
    source: "Sampled from Linolie's photos of each colour on Douglas fir",
    colours: SATIN_WOOD_OIL,
  },
  {
    // Osmo publishes no colour photos to sample, so these are modelled from
    // its descriptions: 3044 has 1.25% white, just enough to cancel the
    // darkening a clear oil gives; 3040 has 4% for a visible whitewash.
    id: "osmo_polyx",
    maker: "Osmo",
    name: "Polyx-Oil",
    url: "https://osmouk.com/faq/wood/polyx-oil-raw-3044-vs-tints-white-3040/",
    m2_per_litre: 12,
    coats: 2,
    source: "Modelled from Osmo's descriptions of how much white each one has",
    colours: [
      {
        id: "raw_3044",
        number: 3044,
        name: "Raw",
        tint: [1, 1, 1],
        cover: 0.06,
        pigment: "#f5f2ec",
        base: "raw",
        sheen: "matt",
        note: "Keeps pale timber looking bare, with a matt sheen",
      },
      {
        id: "white_3040",
        number: 3040,
        name: "White",
        tint: [1, 1, 1],
        cover: 0.2,
        pigment: "#f5f2ec",
        base: "raw",
        note: "A light, visible whitewash with a satin sheen",
      },
      { id: "clear_satin_3032", number: 3032, name: "Clear satin", tint: [1, 1, 1], cover: 0, pigment: "#000000", note: "Clear, so it darkens the timber like any oil" },
    ],
  },
];

/** Bare timber, with nothing on it. */
export const RAW = "raw";

export interface ResolvedFinish {
  palette: FinishPalette;
  colour: FinishColour;
}

/** "Ella Ø" becomes "ella_o", as the colour ids are written. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/ø/g, "o")
    .replace(/å/g, "a")
    .replace(/æ/g, "ae")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

/**
 * Turns what someone typed into a finish id: "raw", or "palette/colour".
 * The colour can be its name or its number. Returns null when it's unknown.
 */
export function normaliseFinish(input: string): string | null {
  const s = input.trim().toLowerCase();
  if (s === RAW || s === "none" || s === "unfinished") return RAW;
  const slash = s.indexOf("/");
  const key = slugify(slash < 0 ? s : s.slice(slash + 1));
  // Without a palette, the first one with that colour wins; Linolie comes first.
  const palettes = slash < 0 ? PALETTES : PALETTES.filter((p) => p.id === s.slice(0, slash));
  for (const palette of palettes) {
    const colour = palette.colours.find((c) => c.id === key || String(c.number) === key || slugify(c.name) === key);
    if (colour) return `${palette.id}/${colour.id}`;
  }
  return null;
}

export function lookupFinish(id: string): ResolvedFinish | null {
  const [paletteId, colourId] = id.split("/");
  const palette = PALETTES.find((p) => p.id === paletteId);
  const colour = palette?.colours.find((c) => c.id === colourId);
  return palette && colour ? { palette, colour } : null;
}

/** "13 Amsterdam", or "Raw timber". */
export function finishLabel(id: string | undefined): string {
  if (!id || id === RAW) return "Raw timber";
  const f = lookupFinish(id);
  if (!f) return id;
  const label = `${f.colour.number ? `${f.colour.number} ` : ""}${f.colour.name}`;
  return f.palette === PALETTES[0] ? label : `${f.palette.maker} ${label}`;
}

/** Where a finish can go: "material:pine", "shelf", "shelf#2" or "shelf.front". */
export type FinishTarget =
  | { kind: "material"; material: string }
  | { kind: "part"; part: string }
  | { kind: "face"; part: string; face: Face };

export function parseFinishTarget(s: string): FinishTarget | null {
  if (s.startsWith("material:")) {
    const material = s.slice("material:".length);
    return material ? { kind: "material", material } : null;
  }
  const dot = s.lastIndexOf(".");
  if (dot < 0) return s ? { kind: "part", part: s } : null;
  const face = s.slice(dot + 1) as Face;
  if (!FACES.includes(face)) return null;
  return { kind: "face", part: s.slice(0, dot), face };
}

/**
 * Finishes set on single pieces or faces whose part is in one of these
 * materials. A finish on the whole material doesn't show through them.
 */
export function finishesWithin(design: Pick<Design, "finishes" | "parts">, materials: string[]): string[] {
  const inMaterial = new Set(design.parts.filter((p) => materials.includes(p.material)).map((p) => p.id));
  return Object.keys(design.finishes ?? {}).filter((key) => {
    const t = parseFinishTarget(key);
    return !!t && t.kind !== "material" && inMaterial.has(t.part.split("#")[0]!);
  });
}

/**
 * Finishes set more closely inside a target, which would hide a new colour
 * on it: everything set on a material's pieces and faces, a piece's own
 * faces, and for an array's original part, its copies too.
 */
export function finishesInside(design: Pick<Design, "finishes" | "parts">, target: string): string[] {
  const t = parseFinishTarget(target);
  if (!t || t.kind === "face") return [];
  if (t.kind === "material") return finishesWithin(design, [t.material]);
  const wholeArray = !t.part.includes("#");
  return Object.keys(design.finishes ?? {}).filter((key) => {
    if (key === target) return false;
    const k = parseFinishTarget(key);
    if (!k || k.kind === "material") return false;
    return wholeArray ? k.part.split("#")[0] === t.part : k.part === t.part;
  });
}

/**
 * The finish on one face of a derived part, or undefined when it's raw.
 * An array's original part id covers all its copies; "shelf#2" is one copy
 * and "shelf#1" is the original alone.
 */
export function finishOn(design: Pick<Design, "finishes">, p: Pick<DerivedPart, "id" | "source" | "copy" | "material">, face: Face): string | undefined {
  const f = design.finishes;
  if (!f) return undefined;
  const one = p.copy === 1 ? `${p.source}#1` : p.id;
  const id = f[`${one}.${face}`] ?? f[`${p.source}.${face}`] ?? f[one] ?? f[p.source] ?? f[`material:${p.material}`];
  return id === RAW ? undefined : id;
}

// Colour arithmetic happens in linear light, as the eye adds light.
export function toLinear(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
}

export function toHex(rgb: readonly number[]): string {
  return (
    "#" +
    rgb
      .map((l) => {
        const c = Math.min(Math.max(l, 0), 1);
        const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
        return Math.round(s * 255)
          .toString(16)
          .padStart(2, "0");
      })
      .join("")
  );
}

/** Share of each ring that's late wood, on average. The 3D view draws the same mix. */
export const LATE_SHARE = 0.3;

function ringAverage(early: string, late: string): [number, number, number] {
  const e = toLinear(early);
  const l = toLinear(late);
  return e.map((v, i) => v * (1 - LATE_SHARE) + l[i]! * LATE_SHARE) as [number, number, number];
}

/** A species' average colour with clear oil on it. */
export function oiledColour(s: Species): [number, number, number] {
  return ringAverage(s.early, s.late);
}

/** A species' average colour bare, as it comes off the planer. */
export function rawColour(s: Species): [number, number, number] {
  return ringAverage(s.raw_early, s.raw_late);
}

function luminance(rgb: readonly number[]): number {
  return 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!;
}

/**
 * The share of every channel of a photo that the pigment supplies at
 * least. These are pigment oils, so some colour sits on top whatever the
 * timber.
 */
export const PIGMENT_FLOOR = 0.3;

/** Steps between a clear tint and one in the photo's own colour, for `fitFinish`. */
const LEAN_STEPS = 20;

/**
 * Splits a colour photographed on a sample timber into a see-through tint
 * and a covering pigment that add back up to the photo on that timber.
 * `cover` is how much the pigment covers, from how much grain the photo
 * shows, and `sample` is the timber in the same light with clear oil.
 *
 * The tint is clear, or leans toward the photo's own colour, and never
 * away from it. A tint that leant away from the sample timber, say blue
 * against Douglas fir's orange, would cancel the fir in the photo and then
 * cast that colour onto any paler timber. The pigment keeps at least
 * `PIGMENT_FLOOR` of every channel. Within those limits the fit lets as
 * much light as it can through the timber, so the grain shows as much as
 * the photo allows.
 */
export function fitFinish(swatch: string, cover: number, sample: string): { tint: [number, number, number]; pigment: string } {
  if (!(cover > 0 && cover <= 1)) throw new Error("cover must be above 0 and at most 1; a colour with no pigment is the sample itself");
  const s = toLinear(swatch);
  const f = toLinear(sample);
  const top = Math.max(...s);
  let best: { tint: number[]; through: number } = { tint: [0, 0, 0], through: -1 };
  for (let step = 0; step <= LEAN_STEPS; step++) {
    // 0 is a clear tint, the same in every channel; 1 is the photo's own balance.
    const lean = step / LEAN_STEPS;
    const shape = s.map((v) => (top > 0 ? (v / top) ** lean : 1));
    // The strongest tint that still leaves the pigment its share of every channel.
    const scale = Math.min(
      ...shape.map((v, i) => (v > 0 && f[i]! > 0 ? ((1 - PIGMENT_FLOOR) * s[i]!) / (f[i]! * v * (1 - cover)) : Infinity)),
    );
    const tint = shape.map((v) => Math.min(1, scale * v));
    const through = luminance(f.map((v, i) => v * tint[i]!));
    if (through > best.through + 1e-12) best = { tint, through };
  }
  const tint = best.tint.map((v) => Math.round(v * 1e4) / 1e4) as [number, number, number];
  const pigment = toHex(s.map((v, i) => (v - f[i]! * tint[i]! * (1 - cover)) / cover));
  return { tint, pigment };
}

/** One colour of wood with a finish on it, in linear light. */
export function applyFinish(wood: readonly number[], f: FinishColour): [number, number, number] {
  const p = toLinear(f.pigment);
  return wood.map((w, i) => w * f.tint[i]! * (1 - f.cover) + p[i]! * f.cover) as [number, number, number];
}

/** The average colour of a species with a finish on it, as a hex colour. */
export function finishedColour(speciesId: string | undefined, finishId: string | undefined): string {
  const s = SPECIES[speciesId ?? ""] ?? SPECIES.douglas_fir!;
  if (!finishId || finishId === RAW) return toHex(rawColour(s));
  const f = lookupFinish(finishId);
  if (!f) return toHex(oiledColour(s));
  return toHex(applyFinish(f.colour.base === "raw" ? rawColour(s) : oiledColour(s), f.colour));
}

export interface FinishUse {
  finish: string;
  label: string;
  area_m2: number;
  /** Oil needed for the usual coats, rounded up to the next 0.05 L. */
  litres: number;
}

/**
 * How much of each finish the design needs, counting every face it's on. A
 * part with cuts counts the faces its cuts leave, and a box counts its six
 * rectangles.
 */
export function finishSchedule(design: Design, parts: DerivedPart[]): FinishUse[] {
  const area = new Map<string, number>();
  for (const p of parts) {
    if (p.broken || p.decor || p.unverified) continue;
    if (p.profile) {
      const faces = faceAreas(p);
      for (const face of FACES) {
        const f = finishOn(design, p, face);
        if (f) area.set(f, (area.get(f) ?? 0) + faces[face] / 1e6);
      }
      continue;
    }
    const size = p.nominal.max.map((v, i) => v - p.nominal.min[i]!);
    FACES.forEach((face, k) => {
      const f = finishOn(design, p, face);
      if (!f) return;
      const axis = Math.floor(k / 2);
      const [a, b] = [0, 1, 2].filter((i) => i !== axis);
      area.set(f, (area.get(f) ?? 0) + (size[a!]! * size[b!]!) / 1e6);
    });
  }
  return [...area]
    .map(([finish, m2]) => {
      const rate = lookupFinish(finish)?.palette.m2_per_litre ?? 10;
      return { finish, label: finishLabel(finish), area_m2: Math.round(m2 * 100) / 100, litres: Math.ceil((m2 / rate) * 20) / 20 };
    })
    .sort((a, b) => b.area_m2 - a.area_m2);
}
