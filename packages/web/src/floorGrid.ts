// The floor grid under the model in the plain look. It's drei's Grid, set
// up so that every part draws in front of it from any angle.
//
// drei's infinite grid stretches its sheet by the fade distance, which
// suits a scene measured in metres. In millimetres that put the sheet's
// edges 120 km out, and a GPU can't reliably clip triangles that big or
// work out their depth. Looking along the floor, as the Front view does,
// the grid could then beat the parts standing on it in the depth test and
// draw over them. Here the sheet is just wide enough to fade out on and
// follows the camera. The grid also draws before anything else without
// reading or writing depth, so every part covers it whatever the depth.

import * as THREE from "three";

/** How far from the camera the lines fade away, in millimetres. */
export const GRID_FADE_MM = 12000;

/**
 * drei Grid's own settings. The sheet is square and as wide as the fade
 * across, kept under the camera, so its edge is never seen.
 */
export const FLOOR_GRID = {
  args: [2 * GRID_FADE_MM, 2 * GRID_FADE_MM] as [number, number],
  cellSize: 100,
  sectionSize: 1000,
  fadeDistance: GRID_FADE_MM,
  infiniteGrid: false,
  followCamera: true,
};

/** Below every other object's render order, so the grid comes first among the solid things. */
export const GRID_RENDER_ORDER = -1;

/**
 * Sets the grid's material to draw as the floor. It goes with the solid
 * things, which three.js draws before anything see-through, and blends
 * its lines in the way see-through things do. It never reads or writes
 * depth, so everything drawn after it, the parts included, covers it.
 */
export function drawAsFloor(material: THREE.Material): THREE.Material {
  material.transparent = false;
  // three.js skips normal blending on a material that isn't see-through, so
  // the same blend goes in as a custom one: colour mixed by alpha, and the
  // canvas's own alpha left whole.
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.AddEquation;
  material.blendSrc = THREE.SrcAlphaFactor;
  material.blendDst = THREE.OneMinusSrcAlphaFactor;
  material.blendEquationAlpha = THREE.AddEquation;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  material.depthTest = false;
  material.depthWrite = false;
  material.needsUpdate = true;
  return material;
}
