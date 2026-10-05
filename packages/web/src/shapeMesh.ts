// A shaped part's solid as a three.js geometry, for the 3D view. A part with
// no cuts stays a box geometry. A shaped one is its outline carried through
// its thickness, with its holes open, from the same solid the plan views
// draw (outline.ts in core). It sits where the box would, centred on the
// part's box like a box geometry, so the wood's grain lines up the same.
//
// Every triangle says which face it counts as, in the aFace attribute: the
// broad faces for the two caps, and the face each edge counts as for the
// walls, so a sloped top still takes the top's finish. A hole's walls count
// as the faces they look towards. Kept free of React so the tests can hold
// its winding, its volume and its faces.

import * as THREE from "three";
import { FACES, solidOf, type DerivedPart, type Face, type Vec3 } from "@woodchuck/core";

/** The attribute that names each vertex's face, as its place in FACES. */
export const FACE_ATTRIBUTE = "aFace";

/** What the geometry needs: the box it fills and the shape cut on its face. */
export type Shaped = Pick<DerivedPart, "nominal" | "profile">;

interface Arrays {
  position: number[];
  normal: number[];
  face: number[];
}

const centreOf = (p: Shaped): Vec3 => p.nominal.min.map((v, i) => (v + p.nominal.max[i]!) / 2) as Vec3;

/** Every triangle of the solid, three vertices each, around the box's centre. Null for a part with no shape. */
function solidArrays(p: Shaped): Arrays | null {
  const solid = solidOf(p);
  if (!solid) return null;
  const c = centreOf(p);
  const out: Arrays = { position: [], normal: [], face: [] };
  const push = (q: Vec3, n: Vec3, f: Face) => {
    out.position.push(q[0] - c[0], q[1] - c[1], q[2] - c[2]);
    out.normal.push(n[0], n[1], n[2]);
    out.face.push(FACES.indexOf(f));
  };

  // The broad faces, cut into triangles on u and v. u × v points along the
  // thickness, so a triangle that runs counter-clockwise there faces out of
  // the upper cap, and the lower cap takes it the other way round.
  const [outline, ...holes] = solid.loops.map((l) => l.map(([x, y]) => new THREE.Vector2(x, y)));
  const flat = solid.loops.flat();
  const [low, high] = solid.caps;
  const lowPts = low.loops.flat();
  const highPts = high.loops.flat();
  for (const tri of THREE.ShapeUtils.triangulateShape(outline!, holes)) {
    const [i, j, k] = tri as [number, number, number];
    const [a, b, d] = [flat[i]!, flat[j]!, flat[k]!];
    const turn = (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0]);
    if (Math.abs(turn) < 1e-12) continue;
    const ccw: [number, number, number] = turn > 0 ? [i, j, k] : [i, k, j];
    for (const n of ccw) push(highPts[n]!, high.normal, high.face);
    for (const n of [ccw[0], ccw[2], ccw[1]]) push(lowPts[n]!, low.normal, low.face);
  }

  // The walls, each a quad whose corners run counter-clockwise seen from outside.
  for (const w of solid.walls) {
    const [q0, q1, q2, q3] = w.corners;
    for (const q of [q0, q1, q2, q0, q2, q3]) push(q, w.normal, w.face);
  }
  return out;
}

function geometryOf(a: Arrays): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(a.position, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(a.normal, 3));
  g.setAttribute(FACE_ATTRIBUTE, new THREE.Float32BufferAttribute(a.face, 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** A shaped part's solid, around the centre of its box. Null for a part with no shape, which draws as its box. */
export function shapeGeometry(p: Shaped): THREE.BufferGeometry | null {
  const a = solidArrays(p);
  return a ? geometryOf(a) : null;
}

/**
 * A thin sheet over one face of a shaped part, lifted off it by `lift` mm,
 * to show the face is picked. It covers every triangle that counts as the
 * face, so a sloped top's sheet lies on the slope.
 */
export function faceSheetGeometry(p: Shaped, face: Face, lift = 0.4): THREE.BufferGeometry | null {
  const a = solidArrays(p);
  if (!a) return null;
  const want = FACES.indexOf(face);
  const out: Arrays = { position: [], normal: [], face: [] };
  for (let v = 0; v < a.face.length; v++) {
    if (a.face[v] !== want) continue;
    const n = a.normal.slice(v * 3, v * 3 + 3);
    for (let k = 0; k < 3; k++) out.position.push(a.position[v * 3 + k]! + n[k]! * lift);
    out.normal.push(...n);
    out.face.push(want);
  }
  return out.face.length ? geometryOf(out) : null;
}

/** The face a ray hit on a shaped part's geometry, from the face its triangle counts as. */
export function faceOfHit(g: THREE.BufferGeometry, hit: { face?: { a: number } | null }): Face | null {
  const attr = g.getAttribute(FACE_ATTRIBUTE);
  if (!attr || !hit.face) return null;
  return FACES[Math.round(attr.getX(hit.face.a))] ?? null;
}
