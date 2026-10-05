// A slow, steady orbit of the 3D view, as another app such as Crossband
// asks for while people talk. The camera turns around a vertical line
// through the model's middle, and what it looks at turns with it, so a
// zoom or a pan stays as it was. The speed eases in and out rather than
// jumping, and each frame turns by however long that frame took, so the
// spin looks the same at any frame rate. Kept free of three.js so the
// tests can hold it.

type Point = readonly [number, number, number];

/** How quickly the speed settles on a new one, in seconds: about two thirds of the way in this time. */
export const EASE_S = 0.4;
/**
 * A frame longer than this, such as the first after the tab was hidden,
 * counts as this long, so the model never jumps. The spin keeps its speed
 * down to four frames a second.
 */
export const MAX_FRAME_MS = 250;
/** Within this many degrees a second of where it's heading, the speed is there. */
const SETTLED = 0.01;

/**
 * One frame of an orbit: the speed it's turning at now and the speed it's
 * heading for, both in degrees a second, and the frame's length. Returns
 * the speed at the end of the frame and how far to turn during it. The
 * speed eases toward the target exponentially, and the turn is that
 * curve's exact area, so one long frame turns as far as many short ones.
 */
export function orbitStep(speed: number, target: number, frameMs: number): { speed: number; degrees: number } {
  const dt = Math.min(Math.max(frameMs, 0), MAX_FRAME_MS) / 1000;
  const gap = speed - target;
  const left = Math.exp(-dt / EASE_S);
  const next = target + gap * left;
  const degrees = target * dt + gap * EASE_S * (1 - left);
  return { speed: Math.abs(next - target) < SETTLED ? target : next, degrees };
}

/**
 * A point turned around the vertical line through centre, by degrees.
 * Positive turns the model to the right, which carries the camera to the
 * left around it, as a turn from another app does.
 */
export function turnAround(p: Point, centre: Point, degrees: number): [number, number, number] {
  const a = (-degrees * Math.PI) / 180;
  const x = p[0] - centre[0];
  const z = p[2] - centre[2];
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return [centre[0] + x * cos + z * sin, p[1], centre[2] - x * sin + z * cos];
}
