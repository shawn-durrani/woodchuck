// The wood the finished view draws. Each part is a solid block of timber:
// the grain is worked out from where a point sits in the board, not
// painted on, so the long faces show stripes and arches, and the ends show
// growth rings. Plywood shows its plies on the edges. Each face then gets
// its own finish: bare or oiled timber, a see-through tint and a covering
// pigment, as in @woodchuck/core's finishes.ts. A box finds each face by
// the way it points. A shaped part's geometry names the face each triangle
// counts as (shapeMesh.ts), so a sloped top takes the top's finish.

import * as THREE from "three";
import {
  FACES,
  RAW,
  lookupFinish,
  toLinear,
  type Axis,
  type Design,
  type DerivedPart,
  type Species,
  finishOn,
  speciesOf,
} from "@woodchuck/core";

const AXIS_VEC: Record<Axis, THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

/** What one face looks like. */
export interface FaceLook {
  /** Start from the bare timber's colours rather than oiled ones. */
  raw: boolean;
  tint: [number, number, number];
  cover: number;
  pigment: [number, number, number];
  /** How rough the surface is: bare timber is dull, satin oil less so. */
  rough: number;
}

export interface WoodLook {
  species: Species;
  faces: FaceLook[];
}

const BARE: FaceLook = { raw: true, tint: [1, 1, 1], cover: 0, pigment: [0, 0, 0], rough: 0.85 };

/** The species and the finish on each face of a part, in the order of FACES. */
export function woodLookOf(design: Pick<Design, "materials" | "finishes">, p: DerivedPart): WoodLook {
  const species = speciesOf(design.materials.find((m) => m.id === p.material));
  const faces = FACES.map((face) => {
    const id = finishOn(design, p, face);
    const f = id && id !== RAW ? lookupFinish(id) : null;
    if (!f) return BARE;
    return {
      raw: f.colour.base === "raw",
      tint: f.colour.tint,
      cover: f.colour.cover,
      pigment: toLinear(f.colour.pigment),
      rough: f.colour.sheen === "matt" ? 0.75 : 0.55,
    };
  });
  return { species, faces };
}

/** A key that changes whenever the look does, so materials update only then. */
export function lookKey(l: WoodLook): string {
  return `${l.species.id}|${l.faces.map((f) => `${f.raw ? "raw" : "oiled"}:${f.tint.join(",")}:${f.cover}:${f.pigment.join(",")}:${f.rough}`).join("|")}`;
}

function seedOf(id: string): [number, number, number] {
  let h = 2166136261;
  for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  const r = (k: number) => (((h >>> (k * 8)) & 255) / 255) * 2 - 1;
  return [r(0), r(1), r(2)];
}

// Value noise. The hash follows Inigo Quilez's "Value Noise 3D" (shadertoy.com/view/4sfGzS), MIT, copyright 2017 Inigo Quilez. See ACKNOWLEDGEMENTS.md.
const NOISE = /* glsl */ `
float wHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float wNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(wHash(i), wHash(i + vec3(1, 0, 0)), f.x), mix(wHash(i + vec3(0, 1, 0)), wHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(wHash(i + vec3(0, 0, 1)), wHash(i + vec3(1, 0, 1)), f.x), mix(wHash(i + vec3(0, 1, 1)), wHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float wFbm(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * wNoise(p); p *= 2.03; a *= 0.5; }
  return s;
}
`;

const WOOD = /* glsl */ `
uniform vec3 uL; uniform vec3 uW; uniform vec3 uT;
uniform vec3 uSize; uniform vec3 uSeed;
uniform vec3 uEarly; uniform vec3 uLate; uniform vec3 uRawEarly; uniform vec3 uRawLate;
uniform float uRing; uniform float uWave; uniform float uPores; uniform float uPly; uniform float uFibre;
uniform float uRaw[6]; uniform vec3 uTint[6]; uniform float uCover[6]; uniform vec3 uPigment[6]; uniform float uRough[6];
varying vec3 vWoodPos;
varying vec3 vWoodNormal;
${NOISE}
vec3 woodColour(vec3 g, bool edge, bool endGrain, vec3 early, vec3 lateC, float endDark) {
  float fibre = wNoise(vec3(g.x * 0.03, g.y * 1.3, g.z * 1.3) + uSeed * 37.0);
  if (uFibre > 0.5) {
    float speck = wNoise(g * 1.7 + uSeed * 9.0);
    return early * (0.95 + 0.08 * speck) * (edge ? 0.86 : 1.0);
  }
  if (uPly > 0.0 && edge) {
    // Plies alternate along and across the grain, with a glue line between.
    float z = (g.z + uSize.z * 0.5) / uPly;
    float odd = mod(floor(z), 2.0);
    float f = fract(z);
    float glue = 1.0 - smoothstep(0.0, 0.1, f) * (1.0 - smoothstep(0.9, 1.0, f));
    return mix(early, lateC, 0.3 + 0.35 * odd) * (0.92 + 0.1 * fibre) * (1.0 - 0.3 * glue);
  }
  // A flat-sawn board: the heart of the tree runs along the grain, below the board.
  vec2 pith = vec2(uSeed.x * uSize.y * 0.6, -(uSize.z * 0.5 + 60.0 + (uSeed.y + 1.0) * 70.0 + uRing * 10.0));
  float wob = (wFbm(vec3(g.x * 0.0035, g.y * 0.012, g.z * 0.012) + uSeed * 10.0) - 0.5) * uWave * uRing * 7.0;
  float r = length(vec2(g.y, g.z) - pith) + wob;
  float ring = fract(r / uRing);
  // Early wood darkens into late wood, which stops sharply at the next ring.
  float late = smoothstep(0.5, 0.88, ring) * (1.0 - smoothstep(0.96, 1.0, ring));
  vec3 c = mix(early, lateC, late);
  c *= 0.94 + 0.12 * fibre;
  float pore = smoothstep(0.75, 0.92, wNoise(vec3(g.x * 0.12, g.y * 3.5, g.z * 3.5) + uSeed * 13.0));
  c *= 1.0 - uPores * 0.4 * pore;
  // End grain soaks up more oil, so it reads darker; bare, a little darker.
  if (endGrain) c *= endDark;
  return c;
}
`;

const FRAGMENT_MAIN = /* glsl */ `
  vec3 wn = normalize(vWoodNormal);
#ifdef WOOD_FACES
  int wFace = int(vWoodFace + 0.5);
#else
  vec3 an = abs(wn);
  int wAxis = an.x > an.y && an.x > an.z ? 0 : (an.y > an.z ? 1 : 2);
  float wSign = wAxis == 0 ? wn.x : (wAxis == 1 ? wn.y : wn.z);
  int wFace = wAxis * 2 + (wSign > 0.0 ? 1 : 0);
#endif
  vec3 g = vec3(dot(vWoodPos, uL), dot(vWoodPos, uW), dot(vWoodPos, uT));
  bool endGrain = abs(dot(wn, uL)) > 0.5;
  bool edge = abs(dot(wn, uT)) < 0.5;
  float fRaw = 1.0; vec3 fTint = vec3(1.0); float fCover = 0.0; vec3 fPigment = vec3(0.0); float fRough = 0.85;
  for (int i = 0; i < 6; i++) {
    if (i == wFace) { fRaw = uRaw[i]; fTint = uTint[i]; fCover = uCover[i]; fPigment = uPigment[i]; fRough = uRough[i]; }
  }
  bool bare = fRaw > 0.5;
  vec3 wood = woodColour(g, edge, endGrain, bare ? uRawEarly : uEarly, bare ? uRawLate : uLate, bare ? 0.9 : 0.78);
  wood = wood * fTint * (1.0 - fCover) + fPigment * fCover;
  diffuseColor.rgb = wood;
`;

/**
 * A standard three.js material with the wood worked into it, so lights and
 * shadows still apply. With faces set, each face's finish follows the
 * geometry's aFace attribute, which a shaped part's geometry has.
 */
export function makeWoodMaterial(faces = false): THREE.MeshStandardMaterial {
  const uniforms = {
    uL: { value: new THREE.Vector3(1, 0, 0) },
    uW: { value: new THREE.Vector3(0, 0, 1) },
    uT: { value: new THREE.Vector3(0, 1, 0) },
    uSize: { value: new THREE.Vector3(1, 1, 1) },
    uSeed: { value: new THREE.Vector3() },
    uEarly: { value: new THREE.Vector3(0.7, 0.4, 0.2) },
    uLate: { value: new THREE.Vector3(0.5, 0.25, 0.1) },
    uRawEarly: { value: new THREE.Vector3(0.8, 0.7, 0.55) },
    uRawLate: { value: new THREE.Vector3(0.65, 0.5, 0.35) },
    uRing: { value: 5 },
    uWave: { value: 0.3 },
    uPores: { value: 0 },
    uPly: { value: 0 },
    uFibre: { value: 0 },
    uRaw: { value: [1, 1, 1, 1, 1, 1] },
    uRough: { value: [0.85, 0.85, 0.85, 0.85, 0.85, 0.85] },
    uTint: { value: Array.from({ length: 6 }, () => new THREE.Vector3(1, 1, 1)) },
    uCover: { value: [0, 0, 0, 0, 0, 0] },
    uPigment: { value: Array.from({ length: 6 }, () => new THREE.Vector3()) },
  };
  const m = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0 });
  m.userData.uniforms = uniforms;
  // Kept beside three.js's own defines, such as STANDARD, which the shader needs.
  if (faces) m.defines = { ...m.defines, WOOD_FACES: "" };
  const face = faces ? { declare: "\nattribute float aFace;\nvarying float vWoodFace;", set: "\nvWoodFace = aFace;", read: "\nvarying float vWoodFace;" } : { declare: "", set: "", read: "" };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vWoodPos;\nvarying vec3 vWoodNormal;${face.declare}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\nvWoodPos = position;\nvWoodNormal = normal;${face.set}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>${face.read}\n${WOOD}`)
      .replace("#include <color_fragment>", `#include <color_fragment>\n${FRAGMENT_MAIN}`)
      // Oil leaves a satin sheen; bare timber is dull.
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = fRough;");
  };
  m.customProgramCacheKey = () => (faces ? "woodchuck-wood-faces" : "woodchuck-wood");
  return m;
}

/** Points a wood material at one part: its size, grain direction, species and finishes. */
export function setWood(m: THREE.MeshStandardMaterial, p: DerivedPart, look: WoodLook) {
  const u = m.userData.uniforms as ReturnType<typeof makeWoodMaterial>["userData"]["uniforms"];
  const size = p.nominal.max.map((v, i) => v - p.nominal.min[i]!);
  const idx = { x: 0, y: 1, z: 2 } as const;
  u.uL.value.copy(AXIS_VEC[p.grain_axis]);
  u.uW.value.copy(AXIS_VEC[p.width_axis]);
  u.uT.value.copy(AXIS_VEC[p.thickness_axis]);
  u.uSize.value.set(size[idx[p.grain_axis]]!, size[idx[p.width_axis]]!, size[idx[p.thickness_axis]]!);
  u.uSeed.value.set(...seedOf(p.id));
  const s = look.species;
  u.uEarly.value.set(...toLinear(s.early));
  u.uLate.value.set(...toLinear(s.late));
  u.uRawEarly.value.set(...toLinear(s.raw_early));
  u.uRawLate.value.set(...toLinear(s.raw_late));
  u.uRing.value = s.ring_mm;
  u.uWave.value = s.wave;
  u.uPores.value = s.pores;
  u.uPly.value = s.ply_mm ?? 0;
  u.uFibre.value = s.kind === "fibreboard" ? 1 : 0;
  look.faces.forEach((f, i) => {
    u.uRaw.value[i] = f.raw ? 1 : 0;
    u.uRough.value[i] = f.rough;
    u.uTint.value[i]!.set(...f.tint);
    u.uCover.value[i] = f.cover;
    u.uPigment.value[i]!.set(...f.pigment);
  });
}
