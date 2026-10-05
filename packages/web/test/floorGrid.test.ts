// The floor grid under the model, for issue #37: in the Front view the grid
// drew over the lower half of every part. drei's infinite grid put the
// sheet's corners 120 km out, and the GPU lost the depth across triangles
// that size. These hold the grid to a sheet the size of its fade, drawn
// before anything else and never touching depth, and run three.js's own
// draw order to check that it comes first from any camera.

import { readdirSync, readFileSync } from "node:fs";
import * as THREE from "three";
import { WebGLRenderList } from "three/src/renderers/webgl/WebGLRenderLists.js";
import { describe, expect, it } from "vitest";
import { drawAsFloor, FLOOR_GRID, GRID_FADE_MM, GRID_RENDER_ORDER } from "../src/floorGrid.js";

/** The grid's mesh as the 3D view makes it. */
function floorGrid(): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(...FLOOR_GRID.args), drawAsFloor(new THREE.ShaderMaterial({ transparent: true })));
  mesh.renderOrder = GRID_RENDER_ORDER;
  return mesh;
}

/** Everything else the 3D view draws, with the settings Viewport.tsx gives each. */
function scene(): Record<string, THREE.Mesh> {
  const box = new THREE.BoxGeometry(400, 520, 30);
  const mesh = (material: THREE.Material, renderOrder = 0) => Object.assign(new THREE.Mesh(box, material), { renderOrder });
  return {
    part: mesh(new THREE.MeshStandardMaterial({ color: "#d9b98c" })),
    hardware: mesh(new THREE.MeshStandardMaterial({ metalness: 0.6 })),
    unverified: mesh(new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.75 })),
    seeThrough: mesh(new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.04, depthWrite: false })),
    faded: mesh(new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.28, depthWrite: false })),
    ghost: mesh(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.22, depthWrite: false }), 4),
    faceMark: mesh(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.45, depthWrite: false }), 5),
  };
}

/** The order three.js draws these in, given each one's depth from the camera, as WebGLRenderer sorts and draws its lists. */
function drawOrder(items: [THREE.Mesh, number][]): THREE.Object3D[] {
  const list = new WebGLRenderList();
  list.init();
  const camera = new THREE.PerspectiveCamera();
  for (const [mesh, z] of items) list.push(mesh, mesh.geometry, mesh.material as THREE.Material, 0, z, null, camera);
  list.sort(null, null);
  return [...list.opaque, ...list.transmissive, ...list.transparent].map((item: { object: THREE.Object3D }) => item.object);
}

describe("the floor grid", () => {
  it("is a sheet as wide as its fade, kept under the camera, with no corner kilometres out", () => {
    expect(FLOOR_GRID.infiniteGrid).toBe(false);
    expect(FLOOR_GRID.followCamera).toBe(true);
    expect(FLOOR_GRID.fadeDistance).toBe(GRID_FADE_MM);
    const [width_mm, depth_mm] = FLOOR_GRID.args;
    // The lines fade out inside the sheet, so its edge never shows.
    expect(Math.min(width_mm, depth_mm) / 2).toBeGreaterThanOrEqual(GRID_FADE_MM);
    // The corner furthest from the camera's foot stays within 50 m.
    expect(Math.hypot(width_mm, depth_mm) / 2).toBeLessThan(50_000);
  });

  it("never reads or writes depth, so no depth sum can put it over a part", () => {
    const m = floorGrid().material as THREE.Material;
    expect(m.depthTest).toBe(false);
    expect(m.depthWrite).toBe(false);
  });

  it("goes with the solid things and still blends its lines as see-through things do", () => {
    const m = floorGrid().material as THREE.Material;
    expect(m.transparent).toBe(false);
    // three.js turns normal blending off for a material that isn't see-through.
    expect(m.blending).toBe(THREE.CustomBlending);
    expect([m.blendEquation, m.blendSrc, m.blendDst]).toEqual([THREE.AddEquation, THREE.SrcAlphaFactor, THREE.OneMinusSrcAlphaFactor]);
    // The canvas stays opaque under a line, as with three.js's own normal blending.
    expect([m.blendEquationAlpha, m.blendSrcAlpha, m.blendDstAlpha]).toEqual([THREE.AddEquation, THREE.OneFactor, THREE.OneMinusSrcAlphaFactor]);
  });

  it("draws before every part, ghost and mark, wherever the camera is", () => {
    const grid = floorGrid();
    const others = Object.values(scene());
    // Depths from the camera, from in front of everything to behind it.
    for (const gridZ of [-1, 0, 0.3, 0.6, 0.9, 1]) {
      for (const shift of [0, 3, 5]) {
        const items: [THREE.Mesh, number][] = others.map((m, i) => [m, ((i + shift) % others.length) / others.length]);
        items.splice(shift % items.length, 0, [grid, gridZ]);
        expect(drawOrder(items)[0]).toBe(grid);
      }
    }
  });

  it("sits under every render order the 3D view sets", () => {
    const dir = new URL("../src/components/", import.meta.url);
    const orders = readdirSync(dir)
      .filter((f) => f.endsWith(".tsx"))
      .flatMap((f) => [...readFileSync(new URL(f, dir), "utf8").matchAll(/renderOrder=\{(-?[\d.]+)\}/g)].map((m) => Number(m[1])));
    expect(orders.length).toBeGreaterThan(0);
    for (const order of orders) expect(order).toBeGreaterThan(GRID_RENDER_ORDER);
    const viewport = readFileSync(new URL("Viewport.tsx", dir), "utf8");
    expect(viewport).toContain("renderOrder={GRID_RENDER_ORDER}");
    expect(viewport).toContain("drawAsFloor(");
  });
});
