// Names before ids. A part, a face or a pin reads by the part's name, such
// as "Seat slat 9 of 15", and its id stays one hover away.

import { FACES, type DerivedPart } from "@woodchuck/core";

type Named = Pick<DerivedPart, "id" | "name" | "copy" | "source">;

/** A namer for the parts of one design. Anything it doesn't know keeps its id. */
export function partNamer(parts: Named[]): (ref: string) => string {
  const byId = new Map(parts.map((p) => [p.id, p]));
  const copies = new Map<string, number>();
  for (const p of parts) copies.set(p.source, (copies.get(p.source) ?? 0) + 1);
  const name = (ref: string): string => {
    const p = byId.get(ref);
    if (p) {
      const n = copies.get(p.source) ?? 1;
      // A copy's own name carries its number, such as "Seat slat 9", so it reads by its original's.
      return n > 1 ? `${byId.get(p.source)?.name ?? p.name} ${p.copy} of ${n}` : p.name;
    }
    // A face, written part.face.
    const dot = ref.lastIndexOf(".");
    const face = ref.slice(dot + 1);
    if (dot > 0 && (FACES as readonly string[]).includes(face) && byId.has(ref.slice(0, dot))) return `${name(ref.slice(0, dot))}, ${face} face`;
    return ref;
  };
  return name;
}

/**
 * A part's name for many of them, in lower case: "Seat slat" becomes
 * "seat slats" and "Shelf" becomes "shelves". In a name with a comma, such
 * as "Leg, front left", the word before the comma is the one that counts.
 */
export function plural(name: string): string {
  const comma = name.indexOf(",");
  const head = comma < 0 ? name : name.slice(0, comma);
  const tail = comma < 0 ? "" : name.slice(comma);
  const many = head.replace(/(\w+)$/, (w) => {
    if (/(s|x|z|ch|sh)$/i.test(w)) return `${w}es`;
    if (/[^aeiou]y$/i.test(w)) return `${w.slice(0, -1)}ies`;
    if (/lf$/i.test(w)) return `${w.slice(0, -1)}ves`;
    if (/[^f]fe$/i.test(w)) return `${w.slice(0, -2)}ves`;
    return `${w}s`;
  });
  // A leading acronym, such as "LP divider", keeps its capitals.
  const lower = /^[A-Z]{2,}\b/.test(many) ? many : many.charAt(0).toLowerCase() + many.slice(1);
  return lower + tail;
}

/** On an array copy, the button that edits every copy, such as "Edit all 15 seat slats". Null on anything else. */
export function editAllLabel(part: Named, parts: Named[]): string | null {
  const n = parts.filter((p) => p.source === part.source).length;
  if (part.copy <= 1 || n <= 1) return null;
  // A copy's own name carries its number, so the words come from the original.
  const original = parts.find((p) => p.id === part.source)?.name ?? part.name;
  return `Edit all ${n} ${plural(original)}`;
}

/** What you're pointing at, on one line above the chat box, and the names "list" opens. */
export interface Pointing {
  text: string;
  /** Empty when the line already names the one thing. */
  list: string[];
}

/** The selection's line, such as "21 parts selected" or "Seat slat 9 of 15 selected". */
export function selectionLine(ids: string[], name: (ref: string) => string): Pointing | null {
  if (!ids.length) return null;
  if (ids.length === 1) return { text: `${name(ids[0]!)} selected`, list: [] };
  const faces = ids.every((s) => s.includes("."));
  return { text: `${ids.length} ${faces ? "faces" : "parts"} selected`, list: ids.map(name) };
}

/** The pins' line, such as "2 pins dropped", naming each pin's part and face. */
export function pinsLine(pins: { n: number; part: string; face: string }[], name: (ref: string) => string): Pointing | null {
  if (!pins.length) return null;
  const each = pins.map((p) => `Pin ${p.n} on ${name(p.part)}, ${p.face} face`);
  if (pins.length === 1) return { text: each[0]!, list: [] };
  return { text: `${pins.length} pins dropped`, list: each };
}
