// When the 3D view frames the whole model again by itself. It does on a
// design switch, when the view changes size (a panel folded, full screen,
// the window resized) and when a change makes the model reach past the
// frame. It never moves the camera during a drag or while you're turning
// the view: a fit that comes up then waits until you let go. It stays
// gentle: a resize keeps a view you've turned or zoomed yourself, unless
// the model no longer fits, and a model you'd already zoomed into doesn't
// count as growing. A model that shrinks into a corner of a view you
// haven't touched, as after undoing a taller bookcase, frames again too.
// Kept free of three.js so the tests can hold it.

export type FitReason = "design" | "resized" | "grew" | "shrank";

export interface FitMemory {
  /** Which design, with whether it has parts yet, so the first parts frame like a new design. */
  design: string;
  width: number;
  height: number;
  /** The model reached past the frame when last looked at. */
  overflow: boolean;
  /** The model took up only a small part of the frame when last looked at. */
  small: boolean;
  /** You've turned, zoomed or panned since the last fit. */
  moved: boolean;
  /** A drag or a turn is under way. */
  held: boolean;
  /** A fit that came up during a drag, waiting for it to end. */
  pending: FitReason | null;
}

export type FitEvent =
  /** A look at the model after the design, its parts or the view's size changed. */
  | { kind: "look"; design: string; width: number; height: number; overflow: boolean; small?: boolean }
  /** A drag or a turn starts. */
  | { kind: "hold" }
  /** It ends. turned says whether the camera moved, as it does for an orbit but not a box select. */
  | { kind: "release"; overflow: boolean; turned: boolean; small?: boolean }
  /** The camera was just fitted on purpose, by Fit or a camera view. */
  | { kind: "fitted"; design: string; width: number; height: number };

/** A size change smaller than this, in CSS pixels, is noise, such as a scrollbar's rounding. */
const RESIZE_PX = 3;

const settled = (m: Pick<FitMemory, "design" | "width" | "height">, held: boolean): FitMemory => ({
  design: m.design,
  width: m.width,
  height: m.height,
  overflow: false,
  small: false,
  moved: false,
  held,
  pending: null,
});

/** Design switches outrank resizes, which outrank growth, when one waits on another. */
const RANK: Record<FitReason, number> = { shrank: 0, grew: 1, resized: 2, design: 3 };
const stronger = (a: FitReason | null, b: FitReason | null) => (!a ? b : !b ? a : RANK[a] >= RANK[b] ? a : b);

/** What one event means for the camera: the memory to keep, and the fit to make now, if any. */
export function autoFit(m: FitMemory | null, e: FitEvent): { memory: FitMemory; fit: FitReason | null } {
  if (e.kind === "fitted") return { memory: settled(e, m?.held ?? false), fit: null };
  if (e.kind === "hold") {
    const base = m ?? { ...settled({ design: "", width: 0, height: 0 }, false) };
    return { memory: { ...base, held: true }, fit: null };
  }
  if (e.kind === "release") {
    const small = !!e.small;
    if (!m) return { memory: { ...settled({ design: "", width: 0, height: 0 }, false), overflow: e.overflow, small, moved: e.turned }, fit: null };
    const moved = m.moved || e.turned;
    // A new design always frames. Growth or a resize that came up during
    // the drag only frames if the model is still past the edge now.
    const due = m.pending === "design" || (m.pending !== null && m.pending !== "shrank" && e.overflow) ? m.pending : null;
    if (due) return { memory: settled(m, false), fit: due };
    return { memory: { ...m, held: false, moved, overflow: e.overflow, small, pending: null }, fit: null };
  }
  // A look.
  let reason: FitReason | null = null;
  if (!m || m.design !== e.design) reason = "design";
  else if (Math.abs(m.width - e.width) >= RESIZE_PX || Math.abs(m.height - e.height) >= RESIZE_PX) {
    if (!m.moved || (e.overflow && !m.overflow)) reason = "resized";
  } else if (e.overflow && !m.overflow) reason = "grew";
  else if (e.small && !m.small && !m.moved) reason = "shrank";
  const here = { design: e.design, width: e.width, height: e.height };
  const small = !!e.small;
  if (m?.held) return { memory: { ...m, ...here, overflow: e.overflow, small, pending: stronger(m.pending, reason) }, fit: null };
  if (reason) return { memory: settled(here, false), fit: reason };
  return { memory: { ...(m ?? settled(here, false)), ...here, overflow: e.overflow, small }, fit: null };
}

type Corner = readonly [number, number, number];

/**
 * Whether a model reaches past the frame, given its box's corners on the
 * canvas as normalised device coordinates: -1 to 1 across and up, and a z
 * over 1 for a corner behind the camera.
 */
export function pastFrame(corners: readonly Corner[], margin = 0.002): boolean {
  return corners.some(([x, y, z]) => z > 1 || Math.abs(x) > 1 + margin || Math.abs(y) > 1 + margin);
}

/** A model this small a share of the frame, both across and up, has shrunk into a corner of it. A fitted model fills most of one or the other. */
const SMALL_SHARE = 0.45;

/** How a model sits in the frame: past its edge, or small in it. */
export function framing(corners: readonly Corner[]): { overflow: boolean; small: boolean } {
  const overflow = pastFrame(corners);
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const across = (Math.max(...xs) - Math.min(...xs)) / 2;
  const up = (Math.max(...ys) - Math.min(...ys)) / 2;
  return { overflow, small: !overflow && Math.max(across, up) < SMALL_SHARE };
}
