// Timber species, for the finished view. Each one says how its grain looks
// so the app can draw it: the colour of the early and late wood in each
// growth ring, both bare and with a clear oil on it, how far apart the
// rings are, how wavy they run and how open the pores are. Plywood also
// says how thick its plies are, since they show on the edges.

export type SpeciesKind = "solid" | "plywood" | "fibreboard";

export interface Species {
  id: string;
  name: string;
  kind: SpeciesKind;
  /** Early wood, the paler part of each ring, with clear oil on it. */
  early: string;
  /** Late wood, the darker band that ends each ring, with clear oil on it. */
  late: string;
  /** The same two colours on bare, freshly dressed timber, which is much paler. */
  raw_early: string;
  raw_late: string;
  /** How far apart the growth rings are. */
  ring_mm: number;
  /** How much the rings wander, from 0 (straight) to 1 (wild). */
  wave: number;
  /** How visible the pores are, from 0 (closed) to 1 (open, like oak). */
  pores: number;
  /** Ply thickness, for plywood edges. */
  ply_mm?: number;
  note: string;
}

const LIST: Species[] = [
  {
    id: "tasmanian_oak",
    name: "Tasmanian oak",
    kind: "solid",
    early: "#d8ab7b",
    late: "#bc8a59",
    raw_early: "#ecd8b9",
    raw_late: "#d6b893",
    ring_mm: 5,
    wave: 0.35,
    pores: 0.35,
    note: "Pale straw to light brown eucalypt, sold dressed all round in most hardware stores.",
  },
  {
    id: "victorian_ash",
    name: "Victorian ash",
    kind: "solid",
    early: "#dcb486",
    late: "#c4945f",
    raw_early: "#eedcbf",
    raw_late: "#dbbf99",
    ring_mm: 5,
    wave: 0.3,
    pores: 0.3,
    note: "Pale eucalypt with straight grain, very like Tasmanian oak.",
  },
  {
    id: "spotted_gum",
    name: "Spotted gum",
    kind: "solid",
    early: "#b98659",
    late: "#8d5c37",
    raw_early: "#dcc09f",
    raw_late: "#b99370",
    ring_mm: 6,
    wave: 0.6,
    pores: 0.25,
    note: "Hard, mid to dark brown, often with a wavy figure.",
  },
  {
    id: "jarrah",
    name: "Jarrah",
    kind: "solid",
    early: "#8f3b25",
    late: "#6a2618",
    raw_early: "#ad5b40",
    raw_late: "#8c412c",
    ring_mm: 6,
    wave: 0.4,
    pores: 0.2,
    note: "Deep red-brown hardwood from Western Australia.",
  },
  {
    id: "blackbutt",
    name: "Blackbutt",
    kind: "solid",
    early: "#cb9961",
    late: "#a97541",
    raw_early: "#e8d0aa",
    raw_late: "#cdab80",
    ring_mm: 6,
    wave: 0.3,
    pores: 0.25,
    note: "Golden brown hardwood with fairly even grain.",
  },
  {
    id: "radiata_pine",
    name: "Radiata pine",
    kind: "solid",
    early: "#e8c68e",
    late: "#c4925a",
    raw_early: "#f3e5c8",
    raw_late: "#dcbd8e",
    ring_mm: 9,
    wave: 0.45,
    pores: 0,
    note: "Pale, fast-grown pine with wide, clear growth rings.",
  },
  {
    id: "douglas_fir",
    name: "Douglas fir (Oregon)",
    kind: "solid",
    early: "#dc9b5e",
    late: "#ad5f2c",
    raw_early: "#f1e3cc",
    raw_late: "#d6b28b",
    ring_mm: 4,
    wave: 0.4,
    pores: 0,
    note: "Warm, strongly striped softwood. Linolie shows its colours on it.",
  },
  {
    id: "white_oak",
    name: "American white oak",
    kind: "solid",
    early: "#caa06d",
    late: "#a77a4a",
    raw_early: "#e4cfae",
    raw_late: "#c9ab84",
    ring_mm: 3,
    wave: 0.35,
    pores: 0.8,
    note: "Light brown with open pores that oil darkens.",
  },
  {
    id: "walnut",
    name: "American walnut",
    kind: "solid",
    early: "#6c4b34",
    late: "#4d3122",
    raw_early: "#937157",
    raw_late: "#6f513b",
    ring_mm: 4,
    wave: 0.4,
    pores: 0.45,
    note: "Dark chocolate brown.",
  },
  {
    id: "birch_ply",
    name: "Birch plywood",
    kind: "plywood",
    early: "#e4c79c",
    late: "#d3ad7d",
    raw_early: "#f4e9d7",
    raw_late: "#e8d6bb",
    ring_mm: 12,
    wave: 0.7,
    pores: 0,
    ply_mm: 1.4,
    note: "Pale, even faces with many thin plies on the edge.",
  },
  {
    id: "hoop_pine_ply",
    name: "Hoop pine plywood",
    kind: "plywood",
    early: "#e5c391",
    late: "#cda068",
    raw_early: "#f2e3c4",
    raw_late: "#e2cba2",
    ring_mm: 14,
    wave: 0.6,
    pores: 0,
    ply_mm: 2.4,
    note: "Australian pine plywood with a pale, mild face.",
  },
  {
    id: "mdf",
    name: "MDF",
    kind: "fibreboard",
    early: "#b08d63",
    late: "#a7845b",
    raw_early: "#c9ae89",
    raw_late: "#c2a782",
    ring_mm: 1,
    wave: 0,
    pores: 0,
    note: "No grain. Usually painted rather than oiled.",
  },
];

export const SPECIES: Record<string, Species> = Object.fromEntries(LIST.map((s) => [s.id, s]));
export const SPECIES_IDS: readonly string[] = LIST.map((s) => s.id);

// Words in a material's name that give away its timber, most specific first.
const NAME_HINTS: [RegExp, string][] = [
  [/hoop pine/i, "hoop_pine_ply"],
  [/birch/i, "birch_ply"],
  [/\bmdf\b/i, "mdf"],
  [/douglas|oregon|\bfir\b/i, "douglas_fir"],
  [/tas(manian)? ?oak/i, "tasmanian_oak"],
  [/vic(torian)? ?ash/i, "victorian_ash"],
  [/spotted gum/i, "spotted_gum"],
  [/jarrah/i, "jarrah"],
  [/blackbutt/i, "blackbutt"],
  [/(white|american) oak/i, "white_oak"],
  [/walnut/i, "walnut"],
  [/radiata|\bpine\b/i, "radiata_pine"],
  [/\boak\b/i, "tasmanian_oak"],
  [/\bply/i, "birch_ply"],
];

/** The species a material's name points to, if any. */
export function guessSpecies(name: string): string | undefined {
  return NAME_HINTS.find(([re]) => re.test(name))?.[1];
}

/**
 * The species a material shows as: its own, else one its name gives away,
 * else pale ply for sheets and Tasmanian oak for solid timber.
 */
export function speciesOf(m: { kind: "sheet" | "solid"; name?: string; species?: string } | undefined): Species {
  return (
    SPECIES[m?.species ?? ""] ??
    SPECIES[guessSpecies(m?.name ?? "") ?? ""] ??
    SPECIES[m?.kind === "solid" ? "tasmanian_oak" : "birch_ply"]!
  );
}
