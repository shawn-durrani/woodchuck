// Box select: which parts have their middle inside a box dragged on the
// screen. Kept apart from the 3D view so it can be tested on its own.

import { FACES, type DerivedPart } from "@woodchuck/core";

export interface ScreenPoint {
  x: number;
  y: number;
  /** True when the point is behind the camera. */
  behind: boolean;
}

export interface ScreenRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function partsInRect(
  parts: Pick<DerivedPart, "id" | "nominal">[],
  project: (p: [number, number, number]) => ScreenPoint,
  r: ScreenRect,
): string[] {
  const [x0, x1] = [Math.min(r.x0, r.x1), Math.max(r.x0, r.x1)];
  const [y0, y1] = [Math.min(r.y0, r.y1), Math.max(r.y0, r.y1)];
  // A click, not a drag, selects nothing.
  if (x1 - x0 < 4 && y1 - y0 < 4) return [];
  return parts
    .filter((p) => {
      const c = p.nominal.max.map((v, i) => (v + p.nominal.min[i]!) / 2) as [number, number, number];
      const s = project(c);
      return !s.behind && s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1;
    })
    .map((p) => p.id);
}

/** Every face of each part, as "part.face", hidden ones included. */
export function facesOf(ids: string[]): string[] {
  return ids.flatMap((id) => FACES.map((f) => `${id}.${f}`));
}

/** True for "part.face" rather than a part id. Part ids never contain a dot. */
export function isFace(s: string): boolean {
  return s.includes(".");
}

/**
 * What to name in set_finish so it means exactly the parts you picked. An
 * array's original stands for every copy, so on its own it's written #1.
 */
export function finishTargets(picked: string[], parts: Pick<DerivedPart, "id" | "source" | "copy">[]): string[] {
  const arrayed = new Set(parts.filter((p) => p.copy > 1).map((p) => p.source));
  return picked.map((s) => {
    const dot = s.indexOf(".");
    const id = dot < 0 ? s : s.slice(0, dot);
    const rest = dot < 0 ? "" : s.slice(dot);
    return arrayed.has(id) ? `${id}#1${rest}` : s;
  });
}

/**
 * Box select by touch, where one finger would turn the model. Two fingers
 * span the box, and lifting them selects what's inside. A tap starts a box
 * at that corner, and the next tap or a drag sets the opposite one. One
 * finger dragged from anywhere draws a box too, as the mouse does.
 */
export interface TouchBox {
  /** The fingers down now, by pointer id: where each started and where it is. */
  fingers: Record<number, { x0: number; y0: number; x: number; y: number }>;
  /** The corner a tap left, waiting for the opposite one. */
  anchor: { x: number; y: number } | null;
  /** The box to draw now. */
  rect: ScreenRect | null;
  /** Two fingers have been down, so lifting one ends the box and the other does nothing. */
  pair: boolean;
}

export const NO_TOUCH_BOX: TouchBox = { fingers: {}, anchor: null, rect: null, pair: false };

export type FingerEvent = { kind: "down" | "move" | "up" | "cancel"; id: number; x: number; y: number };

/** A finger that moves less than this, in CSS px, taps. */
export const TAP_PX = 8;

/** The next state of a box drawn by touch, and the box to select in when a finger ends it. */
export function touchBox(s: TouchBox, e: FingerEvent): { state: TouchBox; done: ScreenRect | null } {
  if (e.kind === "cancel") return { state: NO_TOUCH_BOX, done: null };
  const fingers = { ...s.fingers };
  const span = (f: TouchBox["fingers"]) => {
    const [a, b] = Object.values(f);
    return a && b ? { x0: a.x, y0: a.y, x1: b.x, y1: b.y } : null;
  };
  if (e.kind === "down") {
    fingers[e.id] = { x0: e.x, y0: e.y, x: e.x, y: e.y };
    if (Object.keys(fingers).length > 1) return { state: { fingers, anchor: null, rect: span(fingers), pair: true }, done: null };
    return { state: { ...s, fingers, rect: s.anchor ? { x0: s.anchor.x, y0: s.anchor.y, x1: e.x, y1: e.y } : null }, done: null };
  }
  const f = fingers[e.id];
  if (!f) return { state: s, done: null };
  if (e.kind === "move") {
    fingers[e.id] = { ...f, x: e.x, y: e.y };
    if (s.pair) return { state: { ...s, fingers, rect: s.rect && span(fingers) }, done: null };
    const from = s.anchor ?? { x: f.x0, y: f.y0 };
    const dragged = Math.hypot(e.x - f.x0, e.y - f.y0) > TAP_PX;
    return { state: { ...s, fingers, rect: dragged || s.anchor ? { x0: from.x, y0: from.y, x1: e.x, y1: e.y } : null }, done: null };
  }
  // A finger lifts.
  delete fingers[e.id];
  const left = Object.keys(fingers).length;
  // The first of two fingers to lift ends the box, which is gone by the time the other lifts.
  if (s.pair) return { state: { fingers, anchor: null, rect: null, pair: left > 0 }, done: s.rect };
  const tap = Math.hypot(e.x - f.x0, e.y - f.y0) <= TAP_PX;
  if (tap && !s.anchor) return { state: { fingers, anchor: { x: e.x, y: e.y }, rect: null, pair: false }, done: null };
  const from = s.anchor ?? { x: f.x0, y: f.y0 };
  return { state: { fingers, anchor: null, rect: null, pair: false }, done: { x0: from.x, y0: from.y, x1: e.x, y1: e.y } };
}
