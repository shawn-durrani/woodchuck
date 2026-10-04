// Real parts, such as a particular drawer slide or hinge. Claude researches
// a part and proposes it; once you approve it, it's saved in the repo's
// library/parts folder as one JSON file and can be used in any design.
//
// A part's model is a few boxes in its own frame: x along the part's
// length, y up, z across it. When hardware is placed in a design, its
// length can run along any world axis.

import type { Vec3 } from "./derive.js";
import type { Axis } from "./types.js";

export const PART_KINDS = ["drawer_slide", "hinge", "handle", "leg", "fixing", "other"] as const;
export type PartKind = (typeof PART_KINDS)[number];

export interface PartBox {
  name: string;
  min_mm: Vec3;
  max_mm: Vec3;
}

export interface PartSource {
  url?: string;
  title?: string;
  /** What this source gave, or that it was a spec sheet you attached. */
  note?: string;
}

export interface LibraryPart {
  /** File-name-safe id, such as acmeco-glide-450. */
  id: string;
  name: string;
  kind: PartKind;
  maker?: string;
  model?: string;
  sku?: string;
  /** Where every number came from. */
  sources: PartSource[];
  /** Figures that matter for fitting it, in mm or kg: length_mm, clearance_per_side_mm, load_kg. */
  specs: Record<string, number | string>;
  shape: PartBox[];
  /** How it's fitted, in plain words. */
  mounting?: string;
  notes?: string;
  approved_at?: string;
}

export class LibraryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LibraryError";
  }
}

export const PART_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;

function text(v: unknown, what: string, required = false): string | undefined {
  if (v === undefined || v === null || v === "") {
    if (required) throw new LibraryError(`${what} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new LibraryError(`${what} must be text`);
  return v.trim();
}

function vec(v: unknown, what: string): Vec3 {
  if (!Array.isArray(v) || v.length !== 3 || v.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
    throw new LibraryError(`${what} must be [x, y, z] in mm`);
  }
  return [v[0], v[1], v[2]];
}

/** Checks a part before it's proposed or saved, with messages that say how to fix it. */
export function validateLibraryPart(input: unknown): LibraryPart {
  if (typeof input !== "object" || input === null) throw new LibraryError("A part must be an object");
  const o = input as Record<string, unknown>;
  const id = text(o.id, "id", true)!;
  if (!PART_ID.test(id)) throw new LibraryError(`id "${id}" must be 2 to 64 characters of a-z, 0-9 and -, such as acmeco-glide-450`);
  const kind = o.kind as PartKind;
  if (!PART_KINDS.includes(kind)) throw new LibraryError(`kind "${String(o.kind)}" isn't allowed. Use one of: ${PART_KINDS.join(", ")}`);
  if (!Array.isArray(o.sources) || o.sources.length === 0) {
    throw new LibraryError("sources must list where the numbers came from: a url, or a note such as \"spec sheet attached by the woodworker\"");
  }
  const sources = o.sources.map((s, i) => {
    const src = s as Record<string, unknown>;
    const out: PartSource = {};
    const url = text(src.url, `sources[${i}].url`);
    if (url) {
      if (!/^https?:\/\//.test(url)) throw new LibraryError(`sources[${i}].url must start with http:// or https://`);
      out.url = url;
    }
    const title = text(src.title, `sources[${i}].title`);
    if (title) out.title = title;
    const note = text(src.note, `sources[${i}].note`);
    if (note) out.note = note;
    if (!out.url && !out.note) throw new LibraryError(`sources[${i}] needs a url or a note`);
    return out;
  });
  if (typeof o.specs !== "object" || o.specs === null || Array.isArray(o.specs)) throw new LibraryError("specs must be an object of figures");
  const specs: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(o.specs)) {
    if (!/^[a-z][a-z0-9_]*$/.test(k)) throw new LibraryError(`spec name "${k}" must be lowercase words joined by _`);
    if (typeof v === "number" ? !Number.isFinite(v) : typeof v !== "string") throw new LibraryError(`spec ${k} must be a number or text`);
    specs[k] = v as number | string;
  }
  if (!Array.isArray(o.shape) || o.shape.length === 0) throw new LibraryError("shape needs at least one box");
  const shape = o.shape.map((b, i) => {
    const box = b as Record<string, unknown>;
    const min = vec(box.min_mm, `shape[${i}].min_mm`);
    const max = vec(box.max_mm, `shape[${i}].max_mm`);
    if (min.some((v, k) => v >= max[k]!)) throw new LibraryError(`shape[${i}]: each min_mm value must be below its max_mm value`);
    if (max.some((v, k) => v - min[k]! > 5000)) throw new LibraryError(`shape[${i}] is over 5 m long; sizes are in mm`);
    return { name: text(box.name, `shape[${i}].name`) ?? `box ${i + 1}`, min_mm: min, max_mm: max };
  });
  const part: LibraryPart = { id, name: text(o.name, "name", true)!, kind, sources, specs, shape };
  for (const f of ["maker", "model", "sku", "mounting", "notes", "approved_at"] as const) {
    const v = text(o[f], f);
    if (v) part[f] = v;
  }
  return part;
}

/**
 * Turns a box from the part's own frame into the world. The part's length
 * (its own x) runs along `lengthAxis`; its height stays up unless the
 * length runs up, when height turns to run along x.
 */
export function placeBox(b: PartBox, origin: Vec3, lengthAxis: Axis = "x"): { min: Vec3; max: Vec3 } {
  const map = (p: Vec3): Vec3 => {
    const [lx, ly, lz] = p;
    if (lengthAxis === "z") return [lz, ly, lx];
    if (lengthAxis === "y") return [ly, lx, lz];
    return [lx, ly, lz];
  };
  const a = map(b.min_mm);
  const c = map(b.max_mm);
  return {
    min: [0, 1, 2].map((i) => Math.min(a[i]!, c[i]!) + origin[i]!) as Vec3,
    max: [0, 1, 2].map((i) => Math.max(a[i]!, c[i]!) + origin[i]!) as Vec3,
  };
}
