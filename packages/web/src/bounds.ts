// How a bound reads in a field. A bound is typed as an expression ("450"),
// or as a face starting with @ ("@left_side.right + 2"). The inspector's
// size fields and its cut fields read and write them the same way. Kept
// free of React so the tests can hold it.

import type { Bound } from "@woodchuck/core";

export function boundText(b: Bound | undefined): string {
  if (!b) return "";
  if ("at" in b) return b.at;
  if (!b.offset) return `@${b.face}`;
  const o = b.offset.trim();
  return o.startsWith("-") ? `@${b.face} - ${o.slice(1).trim()}` : `@${b.face} + ${o}`;
}

/** Whether a sum is wrapped whole in one pair of brackets, such as "(gap / 2)". */
function bracketed(s: string): boolean {
  if (!s.startsWith("(") || !s.endsWith(")")) return false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return i === s.length - 1;
  }
  return false;
}

export function parseBound(text: string): Bound | undefined {
  const t = text.trim();
  if (!t) return undefined;
  if (!t.startsWith("@")) return { at: t };
  const m = /^@([a-z][a-z0-9_]*(?:#\d+)?\.[a-z]+)\s*(?:([+-])\s*(.+))?$/i.exec(t);
  if (!m) return { face: t.slice(1) };
  const [, face, sign, rest] = m;
  if (!sign || !rest) return { face: face! };
  // Taken away, a sum keeps its brackets, so "- gap / 2" stays minus the whole of it.
  return { face: face!, offset: sign === "-" ? (/^[\d.]+$/.test(rest) || bracketed(rest) ? `-${rest}` : `-(${rest})`) : rest };
}
