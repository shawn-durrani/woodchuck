// Cutting layouts: how the cut list's parts come out of the timber you
// buy. Sheet goods go onto stock sheets with guillotine cuts, the way a
// panel saw cuts them. Solid timber goes along stock lengths, one board
// section at a time. Both leave a kerf between parts. Each packing is tried
// in a fixed set of orders and the best kept, so the same design always
// gives the same layout. All lengths are in mm.

import { fmt } from "./expr.js";
import type { CutList } from "./cutlist.js";
import type { Design, Material, MaterialKind } from "./types.js";

export const DEFAULT_KERF_MM = 3;
export const DEFAULT_TRIM_MM = 10;
export const DEFAULT_SHEET_MM: readonly [number, number] = [2400, 1200];
/** Lengths you can carry home. 2400 is the most common, and 3600 the longest. */
export const DEFAULT_LENGTHS_MM: readonly number[] = [2400, 3000, 3600];
/** The widest solid board, unless the material says. A wider part is glued up from boards. */
export const DEFAULT_BOARD_WIDTH_MM = 300;
/** A leftover at least this long, and on a sheet this wide, is an offcut worth keeping. */
export const OFFCUT_MIN_MM = 100;

const EPS = 1e-6;
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const nonNegative = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

export interface PlacedPart {
  part: string;
  name: string;
  /** Its row in the cut list. */
  row: number;
  /** The corner nearest the stock's origin. x runs along the stock's length and y across it. */
  x_mm: number;
  y_mm: number;
  /** The part's cut length, along its grain, and its width. */
  length_mm: number;
  width_mm: number;
  /** The part's length runs across the stock. Never on grained stock. */
  rotated: boolean;
  /** One board of a glue-up, as [which board, how many]. */
  board?: [number, number];
}

export interface Offcut {
  x_mm: number;
  y_mm: number;
  /** Along the stock's length, and across it. */
  length_mm: number;
  width_mm: number;
}

/** One sheet or length to buy, with the parts cut from it. */
export interface StockPiece {
  length_mm: number;
  width_mm: number;
  parts: PlacedPart[];
  offcuts: Offcut[];
  waste_pct: number;
}

export interface BuyLine {
  qty: number;
  length_mm: number;
  width_mm: number;
  thickness_mm: number;
  text: string;
}

export interface UnplacedPart {
  part: string;
  name: string;
  row: number;
  length_mm: number;
  width_mm: number;
  reason: string;
}

export interface MaterialLayout {
  material: string;
  name: string;
  kind: MaterialKind;
  thickness_mm: number;
  grained: boolean;
  /** The sheet, for sheet goods, as [length along the grain, width]. */
  sheet_mm?: [number, number];
  /** The lengths on offer, for solid timber. */
  lengths_mm?: number[];
  /** The design sets this material's stock, so it isn't the default. */
  custom: boolean;
  stock: StockPiece[];
  buy: BuyLine[];
  /** Everything bought that isn't a part, offcuts included. */
  waste_pct: number;
  /** Parts no stock is big enough for. */
  unplaced: UnplacedPart[];
  /** Glue-ups, and anything else to know before cutting. */
  notes: string[];
}

export interface CutLayout {
  kerf_mm: number;
  trim_mm: number;
  materials: MaterialLayout[];
  /** Everything to buy, material by material. */
  buy: BuyLine[];
}

/** The kerf and trim in force, with the defaults for anything the design leaves out. */
export function stockSettings(design: Pick<Design, "stock">): { kerf_mm: number; trim_mm: number } {
  const kerf = design.stock?.kerf_mm;
  const trim = design.stock?.trim_mm;
  return { kerf_mm: nonNegative(kerf) ? kerf : DEFAULT_KERF_MM, trim_mm: nonNegative(trim) ? trim : DEFAULT_TRIM_MM };
}

/**
 * What a material is bought as. A sheet comes from the design's stock, then
 * the material's own first sheet size, then 2400 × 1200. Solid timber comes
 * in the design's lengths, or the usual lengths up to its longest board.
 */
export function materialStock(design: Pick<Design, "stock">, m: Material): { sheet_mm?: [number, number]; lengths_mm?: number[]; custom: boolean } {
  const own = design.stock?.materials?.[m.id];
  if (m.kind === "sheet") {
    const s = own?.sheet_mm;
    if (Array.isArray(s) && positive(s[0]) && positive(s[1])) return { sheet_mm: [s[0], s[1]], custom: true };
    const listed = m.sheet_sizes_mm?.[0];
    return { sheet_mm: listed && positive(listed[0]) && positive(listed[1]) ? [listed[0], listed[1]] : [...DEFAULT_SHEET_MM], custom: false };
  }
  const own_lengths = Array.isArray(own?.lengths_mm) ? own.lengths_mm.filter(positive) : [];
  if (own_lengths.length) return { lengths_mm: [...new Set(own_lengths)].sort((a, b) => a - b), custom: true };
  const max = m.board_max_length_mm;
  if (positive(max)) {
    const fit = DEFAULT_LENGTHS_MM.filter((l) => l <= max + EPS);
    return { lengths_mm: fit.length ? fit : [max], custom: false };
  }
  return { lengths_mm: [...DEFAULT_LENGTHS_MM], custom: false };
}

/**
 * Whether a part of this cut size can come out of a sheet at all: inside the
 * trim, and turned across the sheet only when the material has no grain. The
 * cutting layout and the too-big check both ask this, so they never differ.
 */
export function fitsSheet(grained: boolean, length_mm: number, width_mm: number, sheet_mm: readonly [number, number], trim_mm: number): boolean {
  const w = sheet_mm[0] - 2 * trim_mm;
  const h = sheet_mm[1] - 2 * trim_mm;
  return (length_mm <= w + EPS && width_mm <= h + EPS) || (!grained && width_mm <= w + EPS && length_mm <= h + EPS);
}

/** Whether a part this long fits the longest of the stock lengths on offer. */
export function fitsLengths(length_mm: number, lengths_mm: readonly number[]): boolean {
  return length_mm <= Math.max(...lengths_mm) + EPS;
}

interface Item {
  part: string;
  name: string;
  row: number;
  length: number;
  width: number;
  board?: [number, number];
}

const area = (it: Item) => it.length * it.width;

// Sheet goods. Free space is a list of rectangles. A part goes into the
// corner of one, and the rest of that rectangle is cut in two, a kerf away
// from the part. Every cut runs right across the piece it's made in, so a
// panel saw can make them in order.

interface Rect {
  x: number;
  y: number;
  /** Along the sheet's length, and across it. */
  w: number;
  h: number;
}

interface Sheet {
  free: Rect[];
  parts: PlacedPart[];
}

type Fit = "area" | "short_side" | "long_side";
type Split = "shorter_leftover" | "longer_leftover" | "min_area" | "max_area" | "rip_first" | "crosscut_first";

const FITS: Fit[] = ["area", "short_side", "long_side"];
const SPLITS: Split[] = ["shorter_leftover", "longer_leftover", "min_area", "max_area", "rip_first", "crosscut_first"];
const SHEET_ORDERS: ((a: Item, b: Item) => number)[] = [
  (a, b) => area(b) - area(a),
  (a, b) => Math.max(b.length, b.width) - Math.max(a.length, a.width),
  (a, b) => b.length - a.length,
  (a, b) => b.width - a.width,
  (a, b) => b.length + b.width - (a.length + a.width),
];

/** How well a part fits a free rectangle. Lower is better, compared in order. */
function fitScore(fit: Fit, r: Rect, w: number, h: number): [number, number] {
  const short = Math.min(r.w - w, r.h - h);
  const long = Math.max(r.w - w, r.h - h);
  if (fit === "area") return [r.w * r.h - w * h, short];
  if (fit === "short_side") return [short, long];
  return [long, short];
}

/** What's left of a free rectangle once a w × h part sits in its corner. */
function splitRect(rule: Split, r: Rect, w: number, h: number, kerf: number): Rect[] {
  const beside = r.w - w;
  const above = r.h - h;
  // A rip runs along the length first, so the strip across keeps the whole length.
  const rip =
    rule === "shorter_leftover" ? beside <= above
    : rule === "longer_leftover" ? beside > above
    : rule === "min_area" ? w * above > beside * h
    : rule === "max_area" ? w * above <= beside * h
    : rule === "rip_first";
  const out: Rect[] = [];
  const across = { x: r.x, y: r.y + h + kerf, w: rip ? r.w : w, h: above - kerf };
  const along = { x: r.x + w + kerf, y: r.y, w: beside - kerf, h: rip ? h : r.h };
  for (const s of rip ? [across, along] : [along, across]) if (s.w > EPS && s.h > EPS) out.push(s);
  return out;
}

function packSheets(items: Item[], usable: Rect, grained: boolean, kerf: number, fit: Fit, rule: Split): Sheet[] {
  const sheets: Sheet[] = [];
  const turns = grained ? [false] : [false, true];
  for (const it of items) {
    let best: { sheet: Sheet; f: number; rotated: boolean; score: [number, number] } | null = null;
    // Any open sheet first. Only when none has room does a new sheet start.
    for (let pass = 0; pass < 2 && !best; pass++) {
      if (pass === 1) sheets.push({ free: [{ ...usable }], parts: [] });
      for (const sheet of pass === 0 ? sheets : sheets.slice(-1)) {
        for (let f = 0; f < sheet.free.length; f++) {
          const r = sheet.free[f]!;
          for (const rotated of turns) {
            const w = rotated ? it.width : it.length;
            const h = rotated ? it.length : it.width;
            if (w > r.w + EPS || h > r.h + EPS) continue;
            const score = fitScore(fit, r, w, h);
            const better =
              !best || score[0] < best.score[0] - EPS || (Math.abs(score[0] - best.score[0]) <= EPS && score[1] < best.score[1] - EPS);
            if (better) best = { sheet, f, rotated, score };
          }
        }
      }
    }
    // Every item fits an empty sheet, so the second pass always finds a place.
    if (!best) throw new Error(`${it.part} fits no sheet`);
    const { sheet, f, rotated } = best;
    const r = sheet.free[f]!;
    const w = rotated ? it.width : it.length;
    const h = rotated ? it.length : it.width;
    sheet.free.splice(f, 1, ...splitRect(rule, r, w, h, kerf));
    const placed: PlacedPart = { part: it.part, name: it.name, row: it.row, x_mm: r2(r.x), y_mm: r2(r.y), length_mm: it.length, width_mm: it.width, rotated };
    sheet.parts.push(placed);
  }
  return sheets;
}

const keepable = (r: Rect) => Math.min(r.w, r.h) >= OFFCUT_MIN_MM - EPS;

function layoutSheets(m: Material, items: Item[], sheet: [number, number], kerf: number, trim: number): Pick<MaterialLayout, "stock" | "unplaced"> {
  const [L, W] = sheet;
  const usable: Rect = { x: trim, y: trim, w: L - 2 * trim, h: W - 2 * trim };
  const fits = (it: Item) => fitsSheet(m.grained, it.length, it.width, sheet, trim);
  const unplaced: UnplacedPart[] = items
    .filter((it) => !fits(it))
    .map((it) => ({
      part: it.part,
      name: it.name,
      row: it.row,
      length_mm: it.length,
      width_mm: it.width,
      reason: `${fmt(it.length)} × ${fmt(it.width)} mm doesn't fit a ${fmt(L)} × ${fmt(W)} sheet inside its ${fmt(trim)} mm trim${m.grained ? " with the grain along the sheet" : ""}`,
    }));
  const placeable = items.filter(fits);
  let best: { sheets: Sheet[]; score: number[] } | null = null;
  if (placeable.length) {
    for (const order of SHEET_ORDERS) {
      const sorted = [...placeable].sort((a, b) => order(a, b) || area(b) - area(a));
      for (const fit of FITS) {
        for (const rule of SPLITS) {
          const sheets = packSheets(sorted, usable, m.grained, kerf, fit, rule);
          // Fewest sheets, then the biggest single offcut, then the fewest
          // offcuts: what's left is most use later in a few big pieces.
          const offcuts = sheets.flatMap((s) => s.free.filter(keepable).map((r) => r.w * r.h));
          const score = [sheets.length, -Math.max(0, ...offcuts), offcuts.length];
          const i = best ? score.findIndex((v, k) => Math.abs(v - best!.score[k]!) > EPS) : 0;
          if (!best || (i >= 0 && score[i]! < best.score[i]!)) best = { sheets, score };
        }
      }
    }
  }
  const stock: StockPiece[] = (best?.sheets ?? []).map((s) => ({
    length_mm: L,
    width_mm: W,
    parts: [...s.parts].sort((a, b) => a.y_mm - b.y_mm || a.x_mm - b.x_mm),
    offcuts: s.free
      .filter(keepable)
      .sort((a, b) => b.w * b.h - a.w * a.h || a.y - b.y || a.x - b.x)
      .map((r) => ({ x_mm: r2(r.x), y_mm: r2(r.y), length_mm: r2(r.w), width_mm: r2(r.h) })),
    waste_pct: r1(100 * (1 - s.parts.reduce((t, p) => t + p.length_mm * p.width_mm, 0) / (L * W))),
  }));
  return { stock, unplaced };
}

// Solid timber. Parts of one board section are packed along stock lengths:
// the longest first, into whichever length suits, then each length is cut
// down to the shortest stock length that still holds what's on it.

interface Board {
  items: Item[];
  /** The parts and the kerfs between them. */
  used: number;
}

function packLengths(items: Item[], capacity: number, kerf: number, rule: "first" | "best"): Board[] {
  const boards: Board[] = [];
  for (const it of items) {
    let pick: Board | null = null;
    let room = Infinity;
    for (const b of boards) {
      const left = capacity - b.used - kerf - it.length;
      if (left < -EPS) continue;
      if (rule === "first") {
        pick = b;
        break;
      }
      if (left < room - EPS) {
        room = left;
        pick = b;
      }
    }
    if (pick) {
      pick.items.push(it);
      pick.used += kerf + it.length;
    } else boards.push({ items: [it], used: it.length });
  }
  return boards;
}

/** Fills one length at a time, choosing the stock length that wastes least of itself. */
function packBestFill(items: Item[], lengths: number[], kerf: number): Board[] {
  let left = items;
  const boards: Board[] = [];
  while (left.length) {
    let best: { board: Board; waste: number } | null = null;
    for (const L of lengths) {
      const board: Board = { items: [], used: -kerf };
      for (const it of left) {
        if (board.used + kerf + it.length <= L + EPS) {
          board.items.push(it);
          board.used += kerf + it.length;
        }
      }
      if (!board.items.length) continue;
      const waste = (L - board.used) / L;
      if (!best || waste < best.waste - EPS) best = { board, waste };
    }
    if (!best) break;
    const taken = new Set(best.board.items);
    boards.push(best.board);
    left = left.filter((it) => !taken.has(it));
  }
  return boards;
}

function layoutLengths(m: Material, items: Item[], lengths: number[], kerf: number): Pick<MaterialLayout, "stock" | "unplaced"> {
  const longest = Math.max(...lengths);
  const unplaced: UnplacedPart[] = [];
  const sections = new Map<number, Item[]>();
  for (const it of items) {
    if (!fitsLengths(it.length, lengths)) {
      unplaced.push({
        part: it.part,
        name: it.name,
        row: it.row,
        length_mm: it.length,
        width_mm: it.width,
        reason: `${fmt(it.length)} mm long, and the longest length is ${fmt(longest)} mm. Join two lengths, or add a longer stock length`,
      });
      continue;
    }
    sections.set(it.width, [...(sections.get(it.width) ?? []), it]);
  }
  const stock: StockPiece[] = [];
  for (const width of [...sections.keys()].sort((a, b) => b - a)) {
    const sorted = [...sections.get(width)!].sort((a, b) => b.length - a.length);
    const shortest = (used: number) => lengths.find((l) => l >= used - EPS) ?? longest;
    let best: { boards: Board[]; count: number; bought: number; common: number } | null = null;
    const tries: Board[][] = [];
    for (const L of lengths) {
      if (L < sorted[0]!.length - EPS) continue;
      tries.push(packLengths(sorted, L, kerf, "first"), packLengths(sorted, L, kerf, "best"));
    }
    tries.push(packBestFill(sorted, lengths, kerf));
    for (const boards of tries) {
      // The least timber bought, then the most boards at the shortest
      // length (the commonest at the yard), then the fewest boards.
      const bought = boards.reduce((t, b) => t + shortest(b.used), 0);
      const common = boards.filter((b) => shortest(b.used) === lengths[0]).length;
      const better =
        !best ||
        bought < best.bought - EPS ||
        (Math.abs(bought - best.bought) <= EPS && (common > best.common || (common === best.common && boards.length < best.count)));
      if (better) best = { boards, count: boards.length, bought, common };
    }
    for (const b of best?.boards ?? []) {
      const L = shortest(b.used);
      let x = 0;
      const parts: PlacedPart[] = b.items.map((it) => {
        const p: PlacedPart = { part: it.part, name: it.name, row: it.row, x_mm: r2(x), y_mm: 0, length_mm: it.length, width_mm: width, rotated: false };
        if (it.board) p.board = it.board;
        x += it.length + kerf;
        return p;
      });
      const rest = L - b.used - kerf;
      stock.push({
        length_mm: L,
        width_mm: width,
        parts,
        offcuts: rest >= OFFCUT_MIN_MM - EPS ? [{ x_mm: r2(b.used + kerf), y_mm: 0, length_mm: r2(rest), width_mm: width }] : [],
        waste_pct: r1(100 * (1 - b.items.reduce((t, it) => t + it.length, 0) / L)),
      });
    }
  }
  return { stock, unplaced };
}

/** "Douglas fir" from "42 mm Douglas fir", since the buy list gives the section. */
const timberName = (name: string) => name.replace(/^\d+(\.\d+)?\s*mm\s+/i, "");

function buyLines(m: Material, stock: StockPiece[]): BuyLine[] {
  const groups = new Map<string, BuyLine>();
  for (const s of stock) {
    const key = `${s.width_mm}|${s.length_mm}`;
    const line = groups.get(key);
    if (line) line.qty++;
    else groups.set(key, { qty: 1, length_mm: s.length_mm, width_mm: s.width_mm, thickness_mm: m.thickness_mm, text: "" });
  }
  const lines = [...groups.values()].sort((a, b) => b.width_mm - a.width_mm || b.length_mm - a.length_mm);
  for (const l of lines) {
    l.text =
      m.kind === "sheet"
        ? `${l.qty} ${l.qty === 1 ? "sheet" : "sheets"} of ${m.name} ${fmt(l.length_mm)} × ${fmt(l.width_mm)}`
        : `${l.qty} ${l.qty === 1 ? "length" : "lengths"} of ${fmt(l.width_mm)} × ${fmt(m.thickness_mm)} ${timberName(m.name)} at ${fmt(l.length_mm)}`;
  }
  return lines;
}

/** The cutting layout for every material on the cut list. */
export function cutLayout(design: Pick<Design, "materials" | "stock">, list: CutList): CutLayout {
  const { kerf_mm, trim_mm } = stockSettings(design);
  const known = new Map(design.materials.map((m) => [m.id, m]));
  const rowsBy = new Map<string, CutList["rows"]>();
  for (const r of list.rows) rowsBy.set(r.material, [...(rowsBy.get(r.material) ?? []), r]);
  // Materials in the order they were defined, then any the design has lost.
  const ids = [...design.materials.map((m) => m.id).filter((id) => rowsBy.has(id)), ...[...rowsBy.keys()].filter((id) => !known.has(id))];

  const materials: MaterialLayout[] = ids.map((id) => {
    const rows = rowsBy.get(id)!;
    const m: Material = known.get(id) ?? {
      id,
      name: rows[0]!.material_name,
      kind: "sheet",
      thickness_mm: rows[0]!.thickness_mm,
      grained: rows[0]!.grain,
    };
    const { sheet_mm, lengths_mm, custom } = materialStock(design, m);
    const notes: string[] = [];
    const items: Item[] = [];
    const empty: UnplacedPart[] = [];
    const boardWidth = positive(m.board_max_width_mm) && m.board_max_width_mm >= 1 ? m.board_max_width_mm : DEFAULT_BOARD_WIDTH_MM;
    for (const r of rows) {
      const base = { name: r.name, row: r.row, length: r.length_mm, width: r.width_mm };
      if (!positive(r.length_mm) || !positive(r.width_mm)) {
        for (const part of r.parts) empty.push({ part, name: r.name, row: r.row, length_mm: r.length_mm, width_mm: r.width_mm, reason: "it has no size to cut" });
      } else if (m.kind === "solid" && r.width_mm > boardWidth + EPS) {
        // Too wide for one board: glue up boards of equal width, a whole mm each.
        let n = Math.ceil(r.width_mm / boardWidth - EPS);
        while (Math.ceil(r.width_mm / n) > boardWidth + EPS) n++;
        const width = Math.ceil(r.width_mm / n);
        notes.push(
          `${r.name} is ${fmt(r.width_mm)} mm wide, more than a ${fmt(boardWidth)} mm board, so ${r.qty === 1 ? "it's" : "each is"} a glue-up of ${n} boards ${fmt(width)} mm wide. Glue them up, then cut to width`,
        );
        for (const part of r.parts) for (let k = 1; k <= n; k++) items.push({ ...base, part, width, board: [k, n] });
      } else {
        for (const part of r.parts) items.push({ ...base, part });
      }
    }
    const { stock, unplaced } = m.kind === "sheet" ? layoutSheets(m, items, sheet_mm!, kerf_mm, trim_mm) : layoutLengths(m, items, lengths_mm!, kerf_mm);
    const bought = stock.reduce((t, s) => t + s.length_mm * s.width_mm, 0);
    const used = stock.reduce((t, s) => t + s.parts.reduce((u, p) => u + p.length_mm * p.width_mm, 0), 0);
    const out: MaterialLayout = {
      material: id,
      name: m.name,
      kind: m.kind,
      thickness_mm: m.thickness_mm,
      grained: m.grained,
      custom,
      stock,
      buy: buyLines(m, stock),
      waste_pct: bought ? r1(100 * (1 - used / bought)) : 0,
      unplaced: [...empty, ...unplaced],
      notes,
    };
    if (sheet_mm) out.sheet_mm = sheet_mm;
    if (lengths_mm) out.lengths_mm = lengths_mm;
    return out;
  });
  return { kerf_mm, trim_mm, materials, buy: materials.flatMap((m) => m.buy) };
}
