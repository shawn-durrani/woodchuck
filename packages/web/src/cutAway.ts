// The wood a shaped part loses from its blank, for the cutting layout. The
// layout places blanks, and this draws the part's outline inside one. Kept
// free of React so the tests can hold it.

import type { Loop, PlacedPart } from "@woodchuck/core";

/**
 * The wood a shaped part loses from its blank, as one even-odd path: the
 * blank, the outline and each hole. Along the part runs across the drawing,
 * or down it when the part is turned. On a length, the width is stretched
 * to the drawing's height like the length itself.
 */
export function cutAwayPath(shape: { outline: Loop; holes: Loop[] }, p: Pick<PlacedPart, "length_mm" | "width_mm" | "rotated">, x: number, y: number, w: number, h: number): string {
  const sx = (p.rotated ? h : w) / p.length_mm;
  const sy = (p.rotated ? w : h) / p.width_mm;
  const at = ([l, c]: [number, number]) => {
    const [a, b] = p.rotated ? [c * sy, l * sx] : [l * sx, c * sy];
    return `${(x + a).toFixed(2)},${(y + b).toFixed(2)}`;
  };
  const blank = `M${x.toFixed(2)},${y.toFixed(2)}h${w.toFixed(2)}v${h.toFixed(2)}h${(-w).toFixed(2)}Z`;
  return blank + [shape.outline, ...shape.holes].map((l) => `M${l.map(at).join("L")}Z`).join("");
}
