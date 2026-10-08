// The Cut layout tab's stock editors: the boards and sheets you already
// own, the lengths and widths the yard sells, and the words each change is
// undone by. They're kept apart from React so the tests can hold them.
// Every size is in mm.

import { fmt, type CutLayout, type MaterialKind, type OwnedStock } from "@woodchuck/core";
import type { Paper } from "./toolbar";

/** The cutting plan alone, one page when it fits, to print and take to the saw. */
export const cuttingPlanUrl = (paper: Paper) => `/api/cutting-plan.pdf?paper=${paper}`;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What one piece of a material is called: a sheet, or a board of solid timber. */
export const pieceWord = (kind: MaterialKind) => (kind === "sheet" ? "sheet" : "board");

/** A typed list of sizes: nothing at all, something that isn't a size, or the sizes, smallest first and each once. */
export type SizeList = { kind: "empty" } | { kind: "bad" } | { kind: "sizes"; sizes_mm: number[] };

/** Sizes typed with commas or spaces, such as "2400, 3000 3600". A stray "mm" is fine. */
export function parseSizes(text: string): SizeList {
  const words = text.replace(/mm/gi, " ").split(/[\s,]+/).filter(Boolean);
  if (!words.length) return { kind: "empty" };
  const sizes = words.map(Number);
  if (sizes.some((n) => !Number.isFinite(n) || n <= 0)) return { kind: "bad" };
  return { kind: "sizes", sizes_mm: [...new Set(sizes)].sort((a, b) => a - b) };
}

/** The undo label for new stock lengths, or null for the usual ones. */
export const lengthsLabel = (name: string, lengths_mm: readonly number[] | null) =>
  lengths_mm ? `Set ${name} to ${lengths_mm.map(fmt).join(", ")} mm lengths` : `Set ${name} back to the usual lengths`;

/** The undo label for the widths sold, or null to buy each part at its own width. */
export const widthsLabel = (name: string, widths_mm: readonly number[] | null) =>
  widths_mm ? `Set ${name} to ${widths_mm.map(fmt).join(", ")} mm widths` : `Set ${name} back to each part's own width`;

/** The add row's three boxes, as typed. */
export interface OwnedRow {
  length: string;
  width: string;
  qty: string;
}

export const EMPTY_ROW: OwnedRow = { length: "", width: "", qty: "1" };

/** The add row as boards or sheets you own, or what's wrong with it. An empty count is one. */
export function parseOwnedRow(row: OwnedRow, kind: MaterialKind): OwnedStock | { error: string } {
  const size = (t: string) => (t.trim() === "" ? NaN : Number(t.replace(/mm/gi, "").trim()));
  const length_mm = size(row.length);
  const width_mm = size(row.width);
  const qty = row.qty.trim() === "" ? 1 : Number(row.qty.trim());
  if (![length_mm, width_mm].every((n) => Number.isFinite(n) && n > 0)) {
    return { error: `Give the length and width in mm, such as ${kind === "sheet" ? "2400 × 1200" : "2400 × 90"}` };
  }
  if (!Number.isInteger(qty) || qty < 1 || qty > 200) return { error: `The number of ${pieceWord(kind)}s is a whole number from 1 to 200` };
  return { length_mm, width_mm, qty };
}

/** Longest first, then widest, the order the design keeps them in. */
const byLength = (a: OwnedStock, b: OwnedStock) => b.length_mm - a.length_mm || b.width_mm - a.width_mm;

/** Your stock with more added. A size you already have just gains the count. */
export function addOwned(owned: readonly OwnedStock[], add: OwnedStock): OwnedStock[] {
  const out = owned.map((o) => ({ ...o }));
  const had = out.find((o) => o.length_mm === add.length_mm && o.width_mm === add.width_mm);
  if (had) had.qty += add.qty;
  else out.push({ ...add });
  return out.sort(byLength);
}

/** Your stock without the size at this row. */
export const removeOwned = (owned: readonly OwnedStock[], i: number): OwnedStock[] => owned.filter((_, k) => k !== i).map((o) => ({ ...o }));

/** One size you own, as its row in the editor. */
export const ownedText = (o: OwnedStock, kind: MaterialKind) => `${fmt(o.length_mm)} × ${fmt(o.width_mm)} mm, ${plural(o.qty, pieceWord(kind))}`;

/** The undo label for a new list of your own stock, counting every piece. */
export function ownedLabel(name: string, kind: MaterialKind, owned: readonly OwnedStock[]): string {
  const n = owned.reduce((t, o) => t + o.qty, 0);
  return n ? `Set your own ${name} to ${plural(n, pieceWord(kind))}` : `Cleared your own stock of ${name}`;
}

/** How many sheets or lengths a material is cut from, and how many of them are yours. */
export function stockCount(kind: MaterialKind, stock: readonly { owned?: boolean }[]): string {
  const all = plural(stock.length, kind === "sheet" ? "sheet" : "length");
  const mine = stock.filter((s) => s.owned).length;
  if (!mine) return all;
  if (mine === stock.length) return `${all}, ${mine === 1 ? "yours" : "all yours"}`;
  return `${all}, ${mine} of them yours`;
}

/** What the To buy card says when there's nothing on it. */
export function nothingToBuy(layout: Pick<CutLayout, "from_stock" | "materials">): string {
  if (!layout.from_stock.length) return "Nothing fits the stock yet.";
  // A part too big for any stock is left off, so your own doesn't cover everything.
  return layout.materials.some((m) => m.unplaced.length) ? "Nothing to buy." : "Nothing to buy: your own stock covers it.";
}
