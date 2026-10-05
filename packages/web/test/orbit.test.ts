import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { EASE_S, MAX_FRAME_MS, orbitStep, turnAround } from "../src/orbit";

/** Runs an orbit for a time in frames of one length, and says how far it turned and how fast it ends. */
function run(speed: number, target: number, totalMs: number, frameMs: number) {
  let s = speed;
  let turned = 0;
  for (let t = 0; t < totalMs - 1e-9; t += frameMs) {
    const step = orbitStep(s, target, Math.min(frameMs, totalMs - t));
    s = step.speed;
    turned += step.degrees;
  }
  return { speed: s, turned };
}

describe("the orbit's speed and turn", () => {
  it("turns steadily at its speed once it's up to speed", () => {
    expect(orbitStep(12, 12, 16)).toEqual({ speed: 12, degrees: 12 * 0.016 });
    expect(run(12, 12, 1000, 1000 / 60).turned).toBeCloseTo(12, 6);
    expect(run(-20, -20, 500, 10).turned).toBeCloseTo(-10, 6);
  });

  it("turns the same at any frame rate", () => {
    const at60 = run(0, 12, 2000, 1000 / 60);
    const at30 = run(0, 12, 2000, 1000 / 30);
    const at144 = run(0, 12, 2000, 1000 / 144);
    expect(at30.turned).toBeCloseTo(at60.turned, 6);
    expect(at144.turned).toBeCloseTo(at60.turned, 6);
    expect(at30.speed).toBeCloseTo(at60.speed, 6);
  });

  it("eases in from still, rather than jumping to speed", () => {
    const first = orbitStep(0, 12, 16);
    expect(first.speed).toBeGreaterThan(0);
    expect(first.speed).toBeLessThan(1);
    // About two thirds of the way there after one ease time, and there in a couple of seconds.
    expect(run(0, 12, EASE_S * 1000, 10).speed).toBeCloseTo(12 * (1 - Math.exp(-1)), 6);
    expect(run(0, 12, 3000, 16).speed).toBe(12);
  });

  it("eases to a stop, and settles at exactly still", () => {
    const out = run(12, 0, 3000, 16);
    expect(out.speed).toBe(0);
    // It drifts on by its speed times the ease time, a few degrees.
    expect(out.turned).toBeCloseTo(12 * EASE_S, 1);
    expect(orbitStep(0, 0, 16)).toEqual({ speed: 0, degrees: 0 });
  });

  it("never jumps after a long gap, such as a hidden tab", () => {
    expect(orbitStep(12, 12, 5000).degrees).toBeCloseTo((12 * MAX_FRAME_MS) / 1000, 9);
    expect(orbitStep(12, 12, -50).degrees).toBe(0);
  });
});

describe("turning around the model's middle", () => {
  const near = (a: readonly number[], b: readonly number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 6));

  it("turns as a turn from another app does: to the right carries the camera left", () => {
    const camera: [number, number, number] = [900, 750, 1250];
    const middle: [number, number, number] = [0, 0, 0];
    // The same as three.js turns it for a turn command.
    const three = new THREE.Vector3(...camera).applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(-30));
    near(turnAround(camera, middle, 30), three.toArray());
    // From the front, a quarter turn right looks from the left.
    near(turnAround([0, 0, 1000], middle, 90), [-1000, 0, 0]);
  });

  it("keeps the height and the distance from the middle, and comes back round", () => {
    const middle: [number, number, number] = [400, 300, -200];
    const p: [number, number, number] = [1400, 900, 600];
    const q = turnAround(p, middle, 47);
    expect(q[1]).toBe(900);
    expect(Math.hypot(q[0] - 400, q[2] + 200)).toBeCloseTo(Math.hypot(1000, 800), 6);
    near(turnAround(q, middle, -47), p);
    near(turnAround(p, middle, 360), p);
  });
});
