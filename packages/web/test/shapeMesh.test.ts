// A shaped part's mesh in the 3D view: a closed solid with every face
// turned outwards, where its box would be, with each triangle naming the
// face it counts as so the finishes and the face picks land right. The
// side and the panel are invented, and so is every size.

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { applyOps, derive, emptyDesign, FACES, signedArea, type DerivedPart, type Face } from "@woodchuck/core";
import { cutAwayPath } from "../src/cutAway.js";
import { FACE_ATTRIBUTE, faceOfHit, faceSheetGeometry, shapeGeometry } from "../src/shapeMesh.js";
import { makeWoodMaterial } from "../src/wood.js";

const parts = derive(
  applyOps(emptyDesign("Shapes"), [
    { op: "define_material", id: "ply15", name: "15 mm birch ply", kind: "sheet", thickness_mm: 15, grained: true },
    {
      op: "add_panel",
      id: "side",
      name: "Sloped side",
      material: "ply15",
      thickness_axis: "x",
      grain_axis: "z",
      x: { start: { at: "0" } },
      y: { start: { at: "0" }, size: "150" },
      z: { start: { at: "0" }, size: "380" },
    },
    { op: "set_edge_cut", id: "side", cut: "slope", edge: "top", start: { at: "150" }, end: { at: "80" } },
    {
      op: "add_panel",
      id: "panel",
      name: "Panel",
      material: "ply15",
      thickness_axis: "z",
      grain_axis: "y",
      x: { start: { at: "400" }, size: "360" },
      y: { start: { at: "0" }, size: "420" },
      z: { start: { at: "100" } },
    },
    { op: "set_cutout", id: "panel", cut: "cable", shape: "circle", centre: { x: { at: "490" }, y: { at: "320" } }, diameter: "40" },
    { op: "set_cutout", id: "panel", cut: "slot", shape: "rect", x: { start: { at: "560" }, size: "140" }, y: { start: { at: "300" }, size: "36" }, radius: "18" },
    { op: "set_cutout", id: "panel", cut: "kick", shape: "rect", x: { start: { at: "390" }, size: "80" }, y: { start: { at: "-10" }, size: "60" } },
    {
      op: "add_panel",
      id: "plain",
      name: "Plain panel",
      material: "ply15",
      thickness_axis: "y",
      grain_axis: "x",
      x: { start: { at: "0" }, size: "300" },
      y: { start: { at: "500" } },
      z: { start: { at: "0" }, size: "200" },
    },
  ]),
).byId;
const side = parts.get("side")!;
const panel = parts.get("panel")!;

type V = [number, number, number];
const vertex = (g: THREE.BufferGeometry, name: string, i: number): V => {
  const a = g.getAttribute(name);
  return [a.getX(i), a.getY(i), a.getZ(i)];
};
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The volume the triangles enclose, positive when every one faces outwards. */
function signedVolume(g: THREE.BufferGeometry): number {
  let v = 0;
  for (let i = 0; i < g.getAttribute("position").count; i += 3) {
    v += dot(vertex(g, "position", i), cross(vertex(g, "position", i + 1), vertex(g, "position", i + 2))) / 6;
  }
  return v;
}

/** How many triangles count as each face. */
function faceCounts(g: THREE.BufferGeometry): Partial<Record<Face, number>> {
  const out: Partial<Record<Face, number>> = {};
  const a = g.getAttribute(FACE_ATTRIBUTE);
  for (let i = 0; i < a.count; i += 3) {
    const f = FACES[a.getX(i)]!;
    out[f] = (out[f] ?? 0) + 1;
  }
  return out;
}

/** Every triangle turns the way its normal points, so none is inside out. */
function windsWithNormals(g: THREE.BufferGeometry): boolean {
  for (let i = 0; i < g.getAttribute("position").count; i += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => vertex(g, "position", i + k)) as [V, V, V];
    if (dot(cross(sub(b, a), sub(c, a)), vertex(g, "normal", i)) <= 0) return false;
  }
  return true;
}

/** The mesh as the 3D view places it, at the centre of the part's box. */
function meshOf(p: DerivedPart, g: THREE.BufferGeometry): THREE.Mesh {
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial());
  m.position.set(...(p.nominal.min.map((v, i) => (v + p.nominal.max[i]!) / 2) as V));
  m.updateMatrixWorld();
  return m;
}

const hit = (m: THREE.Mesh, from: V, toward: V) => new THREE.Raycaster(new THREE.Vector3(...from), new THREE.Vector3(...toward).normalize()).intersectObject(m);

describe("a sloped side's mesh", () => {
  const g = shapeGeometry(side)!;

  it("is closed and faces outwards, holding the side's volume", () => {
    expect(windsWithNormals(g)).toBe(true);
    expect(signedVolume(g)).toBeCloseTo(((150 + 80) / 2) * 380 * 15, 3);
  });

  it("sits where the box would, around the box's centre", () => {
    g.computeBoundingBox();
    expect(g.boundingBox!.min.toArray()).toEqual([-7.5, -75, -190]);
    expect(g.boundingBox!.max.toArray()).toEqual([7.5, 75, 190]);
  });

  it("counts the slope as the top, so it takes the top's finish", () => {
    expect(faceCounts(g)).toEqual({ left: 2, right: 2, back: 2, top: 2, front: 2, bottom: 2 });
    const a = g.getAttribute(FACE_ATTRIBUTE);
    const top = [...Array(a.count).keys()].find((i) => FACES[a.getX(i)] === "top")!;
    const n = vertex(g, "normal", top);
    expect(n[1]).toBeGreaterThan(0.98);
    expect(n[2]).toBeCloseTo(70 / Math.hypot(70, 380), 6);
  });

  it("reports the top when a click lands on the slope", () => {
    const [h] = hit(meshOf(side, g), [7.5, 400, 200], [0, -1, 0]);
    expect(h!.point.y).toBeCloseTo(150 - (70 * 200) / 380, 3);
    expect(faceOfHit(g, h!)).toBe("top");
  });

  it("lays a picked face's sheet on the slope, just off it", () => {
    const sheet = faceSheetGeometry(side, "top", 0.4)!;
    expect(sheet.getAttribute("position").count).toBe(6);
    const [h] = hit(meshOf(side, sheet), [7.5, 400, 200], [0, -1, 0]);
    expect(h!.point.y - (150 - (70 * 200) / 380)).toBeCloseTo(0.4 / (380 / Math.hypot(70, 380)), 3);
    expect(faceSheetGeometry(side, "left")!.getAttribute("position").count).toBe(6);
  });
});

describe("a holed panel's mesh", () => {
  const g = shapeGeometry(panel)!;
  const pr = panel.profile!;

  it("is closed and faces outwards, with its holes open", () => {
    expect(windsWithNormals(g)).toBe(true);
    const area = Math.abs(signedArea(pr.outline_mm)) - pr.holes.reduce((s, h) => s + Math.abs(signedArea(h.points_mm)), 0);
    expect(signedVolume(g)).toBeCloseTo(area * 15, 1);
    expect(area).toBeLessThan(360 * 420 - 70 * 50 - 1200 - 4700);
  });

  it("gives each broad face the whole outline less its holes, and each hole's walls the way they look", () => {
    const counts = faceCounts(g);
    const loops = pr.outline_mm.length + pr.holes.reduce((s, h) => s + h.points_mm.length, 0);
    // Each broad face has two triangles fewer than its corners, plus two for each hole.
    expect(counts.back).toBe(loops - 2 + 2 * pr.holes.length);
    expect(counts.front).toBe(counts.back);
    // Every edge of the outline and the holes stands up as a wall of two triangles.
    expect((counts.left ?? 0) + (counts.right ?? 0) + (counts.top ?? 0) + (counts.bottom ?? 0)).toBe(2 * loops);
  });

  it("lets a click through a hole, and names the wall a click inside it lands on", () => {
    const m = meshOf(panel, g);
    expect(hit(m, [490, 320, 500], [0, 0, -1])).toEqual([]);
    const [wall] = hit(m, [490, 320, 107.5], [1, 0, 0]);
    expect(wall!.point.x).toBeCloseTo(510, 2);
    expect(faceOfHit(g, wall!)).toBe("left");
    const [face] = hit(m, [450, 200, 500], [0, 0, -1]);
    expect(faceOfHit(g, face!)).toBe("front");
  });
});

describe("a part with no cuts", () => {
  it("has no shaped mesh, so it stays a box", () => {
    expect(shapeGeometry(parts.get("plain")!)).toBeNull();
    expect(faceSheetGeometry(parts.get("plain")!, "top")).toBeNull();
  });
});

describe("the wood on a shaped part", () => {
  const compile = (faces: boolean) => {
    const m = makeWoodMaterial(faces);
    const shader = {
      uniforms: {},
      vertexShader: "#include <common>\n#include <begin_vertex>",
      fragmentShader: "#include <common>\n#include <color_fragment>\n#include <roughnessmap_fragment>",
    };
    m.onBeforeCompile(shader as never, null as never);
    return { m, shader };
  };

  it("finishes each face by the face its triangle names", () => {
    const { m, shader } = compile(true);
    expect(m.defines).toEqual({ STANDARD: "", WOOD_FACES: "" });
    expect(m.customProgramCacheKey()).toBe("woodchuck-wood-faces");
    expect(shader.vertexShader).toContain(`attribute float ${FACE_ATTRIBUTE};`);
    expect(shader.vertexShader).toContain(`vWoodFace = ${FACE_ATTRIBUTE};`);
    expect(shader.fragmentShader).toContain("int wFace = int(vWoodFace + 0.5);");
  });

  it("finishes a box by the way each face points, as it always has", () => {
    const { m, shader } = compile(false);
    expect(m.defines).toEqual({ STANDARD: "" });
    expect(m.customProgramCacheKey()).toBe("woodchuck-wood");
    expect(shader.vertexShader).not.toContain(FACE_ATTRIBUTE);
  });
});

describe("a shaped part on the cutting layout", () => {
  it("shades the wood its cuts take from the blank, holes and all", () => {
    const shape = {
      outline: [
        [0, 0],
        [0, 150],
        [380, 80],
        [380, 0],
      ] as [number, number][],
      holes: [],
    };
    const blank = { length_mm: 380, width_mm: 150 };
    expect(cutAwayPath(shape, { ...blank, rotated: false }, 10, 20, 380, 150)).toBe(
      "M10.00,20.00h380.00v150.00h-380.00ZM10.00,20.00L10.00,170.00L390.00,100.00L390.00,20.00Z",
    );
    // Turned across the sheet, the length runs down the drawing.
    expect(cutAwayPath(shape, { ...blank, rotated: true }, 0, 0, 150, 380)).toBe("M0.00,0.00h150.00v380.00h-150.00ZM0.00,0.00L150.00,0.00L80.00,380.00L0.00,380.00Z");
    // A length is drawn thicker than life, and the outline stretches with it.
    expect(cutAwayPath(shape, { ...blank, rotated: false }, 0, 0, 380, 30)).toContain("L380.00,16.00");
  });
});
