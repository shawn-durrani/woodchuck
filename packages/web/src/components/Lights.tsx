// Lighting for the finished view. Oil colours shift a lot with the light,
// so there are three rooms to judge them in: daylight, a warm evening lamp
// and a bright workshop. Each has a floor that takes the piece's shadow.
// Everything is drawn here; nothing is fetched.

import { Environment, Lightformer } from "@react-three/drei";
import { useLayoutEffect, useRef } from "react";
import * as THREE from "three";
import type { DerivedPart } from "@woodchuck/core";
import type { Lighting } from "../lighting";

export { LIGHTINGS, type Lighting } from "../lighting";

interface Preset {
  background: string;
  floor: string;
  sky: string;
  ground: string;
  ambient: number;
  key: { colour: string; intensity: number; dir: [number, number, number] };
  fill: { colour: string; intensity: number; dir: [number, number, number] };
  env: number;
  envColour: string;
}

const PRESETS: Record<Lighting, Preset> = {
  daylight: {
    background: "#e8eaec",
    floor: "#d8d3cb",
    sky: "#e4ecf6",
    ground: "#b9a88f",
    ambient: 1.3,
    key: { colour: "#fff3e2", intensity: 2.2, dir: [-0.55, 0.9, 0.75] },
    fill: { colour: "#dfe9f7", intensity: 0.5, dir: [0.8, 0.4, 0.5] },
    env: 0.45,
    envColour: "#ffffff",
  },
  // Eyes adjust to lamplight, so it's drawn warm but not orange.
  evening: {
    background: "#2e2924",
    floor: "#6b5d50",
    sky: "#9a8a78",
    ground: "#3a3028",
    ambient: 0.7,
    key: { colour: "#ffe1c2", intensity: 2.2, dir: [0.7, 0.75, 0.8] },
    fill: { colour: "#ffe8d2", intensity: 0.45, dir: [-0.9, 0.35, 0.4] },
    env: 0.3,
    envColour: "#ffe6cc",
  },
  workshop: {
    background: "#ecebe8",
    floor: "#cbc6be",
    sky: "#f6f3ee",
    ground: "#a29b90",
    ambient: 1.5,
    key: { colour: "#fff2e2", intensity: 1.9, dir: [0.15, 1, 0.35] },
    fill: { colour: "#fff2e2", intensity: 0.45, dir: [-0.4, 0.6, 0.8] },
    env: 0.55,
    envColour: "#fff4e8",
  },
};

export function backgroundOf(lighting: Lighting): string {
  return PRESETS[lighting].background;
}

function modelBounds(parts: DerivedPart[]) {
  const box = new THREE.Box3();
  for (const p of parts) {
    box.expandByPoint(new THREE.Vector3(...p.nominal.min));
    box.expandByPoint(new THREE.Vector3(...p.nominal.max));
  }
  if (box.isEmpty()) box.set(new THREE.Vector3(0, 0, 0), new THREE.Vector3(600, 600, 400));
  return { centre: box.getCenter(new THREE.Vector3()), radius: Math.max(box.getSize(new THREE.Vector3()).length() / 2, 200) };
}

/**
 * In a photo, the photo is the background and the floor: the model's
 * shadow falls on it, so the floor here only catches shadow.
 */
export function FinishedLights({ lighting, parts, photo }: { lighting: Lighting; parts: DerivedPart[]; photo?: { shadow: number } }) {
  const p = PRESETS[lighting];
  const key = useRef<THREE.DirectionalLight>(null);
  const fill = useRef<THREE.DirectionalLight>(null);
  const { centre, radius } = modelBounds(parts);
  const sig = `${centre.toArray().join(",")}:${radius}:${lighting}`;

  // Aim both lights at the piece, and fit the shadow to it.
  useLayoutEffect(() => {
    for (const [light, dir] of [
      [key.current, p.key.dir],
      [fill.current, p.fill.dir],
    ] as const) {
      if (!light) continue;
      light.position.copy(centre).add(new THREE.Vector3(...dir).normalize().multiplyScalar(radius * 4));
      light.target.position.copy(centre);
      light.target.updateMatrixWorld();
    }
    const cam = key.current?.shadow.camera;
    if (cam) {
      cam.left = cam.bottom = -radius * 1.4;
      cam.right = cam.top = radius * 1.4;
      cam.near = radius;
      cam.far = radius * 8;
      cam.updateProjectionMatrix();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  return (
    <>
      {!photo && <color attach="background" args={[p.background]} />}
      <hemisphereLight args={[p.sky, p.ground, p.ambient]} />
      <directionalLight
        ref={key}
        color={p.key.colour}
        intensity={p.key.intensity}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0003}
        shadow-normalBias={1.5}
        shadow-radius={4}
      />
      <directionalLight ref={fill} color={p.fill.colour} intensity={p.fill.intensity} />
      <mesh rotation-x={-Math.PI / 2} position={[centre.x, -0.3, centre.z]} receiveShadow>
        <planeGeometry args={[radius * 40, radius * 40]} />
        {photo ? <shadowMaterial transparent opacity={photo.shadow} /> : <meshStandardMaterial color={p.floor} roughness={0.95} />}
      </mesh>
      {/* Soft reflections for the oil's satin sheen, drawn here rather than loaded. */}
      <Environment frames={1} resolution={128} environmentIntensity={p.env}>
        <Lightformer form="rect" intensity={2} color={p.envColour} position={[0, 5, 5]} scale={[10, 4, 1]} />
        <Lightformer form="rect" intensity={1} color={p.envColour} position={[-5, 2, 0]} rotation-y={Math.PI / 2} scale={[6, 3, 1]} />
        <Lightformer form="rect" intensity={0.6} color={p.sky} position={[0, 6, 0]} rotation-x={Math.PI / 2} scale={[10, 10, 1]} />
      </Environment>
    </>
  );
}
