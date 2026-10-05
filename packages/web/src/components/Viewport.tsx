// The 3D view. Each part is drawn as its visible box, coloured by material,
// or in the finished look as real timber with its finish under a choice of
// lighting. Click a part to select it, or a face in face mode; shift-click
// adds to the selection.

import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Edges, Grid, Html, Line, OrbitControls } from "@react-three/drei";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { FACES, type Box, type DerivedHardware, type DerivedJoint, type DerivedPart, type Design, type Face, type JointFeature } from "@woodchuck/core";
import { facesOf, NO_TOUCH_BOX, partsInRect, touchBox, type FingerEvent, type TouchBox } from "../select";
import { autoFit, framing, type FitMemory, type FitReason } from "../autofit";
import { orbitStep, turnAround } from "../orbit";
import { lookKey, makeWoodMaterial, setWood, woodLookOf, type WoodLook } from "../wood";
import { useScene, type SceneColours } from "../theme";
import { FinishedLights, type Lighting } from "./Lights";
import type { Ghost, MoveMark, Vec } from "../ghost";

/** Plain colours for editing, or the timber and its finish. */
export type Look = "plain" | "finished";

export type CameraView = "iso" | "front" | "top" | "left" | "right" | "back";

/** How a click in the 3D view is read: pick parts, drag a box, or drop pins. */
export type PointMode = "pick" | "box" | "pin" | "pan";

export interface Pin {
  n: number;
  part: string;
  face: string;
  point_mm: [number, number, number];
}

/** What the rest of the app can ask of the 3D view. */
export interface ViewportApi {
  /** A JPEG of exactly what's on screen, no more than 1568 px across. */
  capture(): { media_type: "image/jpeg"; data: string } | null;
  /** Where a point in the model lands on the canvas, in CSS pixels. */
  project(p: [number, number, number]): { x: number; y: number; behind: boolean };
  /** A PNG of the view at up to three times the screen's size, as a data URL. */
  snapshot(): string | null;
  /** Turns the camera around the model (degrees, positive to the right) and moves it closer by a factor. */
  nudge(turnDegrees: number, zoom: number): void;
}

const FACE_BY_NORMAL: Record<string, string> = { "0+": "right", "0-": "left", "1+": "top", "1-": "bottom", "2+": "front", "2-": "back" };

function faceFromNormal(n: THREE.Vector3): string {
  const a = [Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)];
  const i = a.indexOf(Math.max(...a));
  return FACE_BY_NORMAL[`${i}${[n.x, n.y, n.z][i]! >= 0 ? "+" : "-"}`]!;
}

const half = (v: number) => Math.round(v * 2) / 2;

/** A numbered red dot that stays the same size on screen and shows through parts. */
function PinMarker({ pin, scene }: { pin: Pin; scene: SceneColours }) {
  const texture = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d")!;
    g.fillStyle = scene.pin;
    g.strokeStyle = scene.pinRing;
    g.lineWidth = 5;
    g.beginPath();
    g.arc(32, 32, 27, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.fillStyle = scene.pinRing;
    g.font = "bold 32px Helvetica, Arial, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(String(pin.n), 32, 34);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, [pin.n, scene.pin, scene.pinRing]);
  useEffect(() => () => texture.dispose(), [texture]);
  return (
    <sprite position={pin.point_mm} scale={[0.045, 0.045, 1]} renderOrder={10} userData={{ uiOnly: true }}>
      <spriteMaterial map={texture} sizeAttenuation={false} depthTest={false} transparent />
    </sprite>
  );
}

/** Hands the app a way to capture the canvas and project points onto it. */
function ApiBridge({ apiRef }: { apiRef: React.MutableRefObject<ViewportApi | null> }) {
  const { gl, camera, size, scene } = useThree();
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  useEffect(() => {
    apiRef.current = {
      capture() {
        const src = gl.domElement;
        const scale = Math.min(1, 1568 / Math.max(src.width, src.height));
        const out = document.createElement("canvas");
        out.width = Math.round(src.width * scale);
        out.height = Math.round(src.height * scale);
        const g = out.getContext("2d");
        if (!g) return null;
        g.drawImage(src, 0, 0, out.width, out.height);
        const url = out.toDataURL("image/jpeg", 0.85);
        return { media_type: "image/jpeg", data: url.slice(url.indexOf(",") + 1) };
      },
      project(p) {
        const v = new THREE.Vector3(...p).project(camera);
        return { x: ((v.x + 1) / 2) * size.width, y: ((1 - v.y) / 2) * size.height, behind: v.z > 1 };
      },
      nudge(turnDegrees, zoom) {
        const target = controls?.target ?? new THREE.Vector3();
        const offset = camera.position.clone().sub(target);
        // Turning to the right moves the camera to the left around the model.
        offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(-turnDegrees));
        offset.multiplyScalar(1 / zoom);
        camera.position.copy(target).add(offset);
        camera.lookAt(target);
        controls?.update();
        // Remembered line-ups listen for this, as they do for a drag.
        controls?.dispatchEvent({ type: "end" } as never);
      },
      snapshot() {
        // Draw once at a higher resolution without selection marks or pins,
        // read it straight off, then put the canvas back.
        const ratio = gl.getPixelRatio();
        const hidden: THREE.Object3D[] = [];
        scene.traverse((o) => {
          if (o.userData.uiOnly && o.visible) hidden.push(o);
        });
        const scale = Math.min(3, 4096 / Math.max(size.width * ratio, size.height * ratio, 1));
        try {
          for (const o of hidden) o.visible = false;
          gl.setPixelRatio(ratio * Math.max(scale, 1));
          gl.setSize(size.width, size.height, false);
          gl.render(scene, camera);
          return gl.domElement.toDataURL("image/png");
        } catch {
          return null;
        } finally {
          for (const o of hidden) o.visible = true;
          gl.setPixelRatio(ratio);
          gl.setSize(size.width, size.height, false);
          gl.render(scene, camera);
        }
      },
    };
  }, [gl, camera, size, scene, controls, apiRef]);
  return null;
}

const WOOD = ["#d9b98c", "#c89f6d", "#e3c9a0", "#b98b5a", "#d2ab7c", "#e8d3b0", "#a87d4f", "#cfa774"];
function hash(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}
function colourFor(p: DerivedPart): string {
  if (p.unverified) return "#f0a24a";
  if (p.decor) return "#bdbdbd";
  return WOOD[hash(p.material) % WOOD.length]!;
}

function bounds(parts: DerivedPart[]) {
  const box = new THREE.Box3();
  for (const p of parts) {
    box.expandByPoint(new THREE.Vector3(...p.nominal.min));
    box.expandByPoint(new THREE.Vector3(...p.nominal.max));
  }
  if (box.isEmpty()) box.set(new THREE.Vector3(0, 0, 0), new THREE.Vector3(600, 600, 400));
  return box;
}

const DIRS: Record<CameraView, [number, number, number]> = {
  iso: [0.9, 0.75, 1.25],
  front: [0, 0, 1],
  back: [0, 0, -1],
  top: [0, 1, 0.0001],
  left: [-1, 0, 0],
  right: [1, 0, 0],
};

/**
 * The camera for lining the model up with a photo: the lens the photo was
 * taken with, and the last line-up, remembered in this browser so a reload
 * doesn't lose it.
 */
function PhotoCamera({ fov, memoryKey }: { fov: number; memoryKey: string }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  useEffect(() => {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }, [camera, fov]);
  useEffect(() => {
    if (!controls) return;
    try {
      const saved = JSON.parse(localStorage.getItem(memoryKey) ?? "null") as { position: number[]; target: number[] } | null;
      if (saved?.position?.length === 3 && saved.target?.length === 3) {
        camera.position.set(saved.position[0]!, saved.position[1]!, saved.position[2]!);
        controls.target.set(saved.target[0]!, saved.target[1]!, saved.target[2]!);
        controls.update();
      }
    } catch {
      // Nothing saved, or storage refused: keep the usual view.
    }
    const save = () => {
      try {
        localStorage.setItem(memoryKey, JSON.stringify({ position: camera.position.toArray(), target: controls.target.toArray() }));
      } catch {
        // Storage refused: the line-up just won't be remembered.
      }
    };
    controls.addEventListener("end", save);
    return () => controls.removeEventListener("end", save);
  }, [camera, controls, memoryKey]);
  return null;
}

/** Where the camera goes to frame a box from a direction, with the far plane to match. */
interface Goal {
  position: THREE.Vector3;
  target: THREE.Vector3;
  far: number;
}

function frameBox(camera: THREE.Camera, box: THREE.Box3, canvas: { width: number; height: number }, dir: THREE.Vector3): Goal {
  const centre = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2;
  // Back off until the whole piece fits both across and up the canvas.
  const vfov = THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov ?? 35);
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * (canvas.width / Math.max(canvas.height, 1)));
  const dist = (radius / Math.sin(Math.min(vfov, hfov) / 2)) * 1.08;
  return { position: centre.clone().add(dir.clone().normalize().multiplyScalar(dist)), target: centre, far: dist * 20 + 10000 };
}

function corners(b: THREE.Box3): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) out.push(new THREE.Vector3(x, y, z));
  return out;
}

/** How long an automatic fit takes to glide into place, in milliseconds. */
const GLIDE_MS = 280;

/**
 * The camera. A camera view, Fit and a new fitKey frame the model from that
 * view. With auto on, it also frames the model again by itself when the
 * design changes, the canvas changes size, or a change takes the model past
 * the frame or shrinks it into a corner, as autofit.ts decides. It never
 * does during a drag or a turn, and it keeps the angle you're looking
 * from, gliding there. With an orbit on, it turns the camera steadily
 * around the model's middle, as orbit.ts works out, and pauses for a glide.
 */
function CameraRig({
  parts,
  extra,
  view,
  fitKey,
  focus,
  target,
  auto = false,
  designKey = "",
  held = false,
  paused = false,
  orbit = null,
  spin,
}: {
  parts: DerivedPart[];
  /** More boxes the model's frame takes in, such as a suggested change's ghost. */
  extra?: Box[];
  view: CameraView;
  fitKey: string;
  focus?: Box;
  /** Frames these few parts once per key, from the angle you're looking from, as Show me does. */
  target?: { box: Box; key: number } | null;
  auto?: boolean;
  designKey?: string;
  /** A drag in the view, such as a box select, is under way. */
  held?: boolean;
  /** The canvas is out of sight, so a fit lands at once. */
  paused?: boolean;
  /** Keep turning at this many degrees a second, or ease to a stop (null). */
  orbit?: number | null;
  /** How fast the orbit turns right now, in degrees a second, shared so a grab can stop it dead. */
  spin: React.MutableRefObject<number>;
}) {
  const { camera, size: canvas, invalidate } = useThree();
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const box = useMemo(() => {
    if (focus) return new THREE.Box3(new THREE.Vector3(...focus.min), new THREE.Vector3(...focus.max));
    const b = bounds(parts);
    for (const e of extra ?? []) {
      b.expandByPoint(new THREE.Vector3(...e.min));
      b.expandByPoint(new THREE.Vector3(...e.max));
    }
    return b;
  }, [focus, parts, extra]);
  const sig = [...box.min.toArray(), ...box.max.toArray()].map((v) => Math.round(v)).join(",");
  const design = `${designKey}${parts.length ? "" : ":empty"}`;
  const memory = useRef<FitMemory | null>(null);
  const glide = useRef<{ from: Goal; to: Goal; start: number } | null>(null);
  // The latest of everything, for listeners set up once.
  const now = useRef({ box, view, canvas, paused, design, orbit });
  now.current = { box, view, canvas, paused, design, orbit };

  const place = (g: Goal) => {
    camera.position.copy(g.position);
    camera.lookAt(g.target);
    if (controls) {
      controls.target.copy(g.target);
      controls.update();
    }
  };
  const fit = (dir: THREE.Vector3, animate: boolean, b: THREE.Box3 = now.current.box) => {
    const { canvas: c, paused: p } = now.current;
    const goal = frameBox(camera, b, c, dir);
    camera.near = 1;
    camera.far = Math.max(goal.far, animate ? camera.far : 0);
    camera.updateProjectionMatrix();
    glide.current = null;
    // A fit lands where it was asked to, and an orbit eases in again from there.
    spin.current = 0;
    if (animate && !p) {
      const from = { position: camera.position.clone(), target: controls?.target.clone() ?? goal.target.clone(), far: camera.far };
      glide.current = { from, to: goal, start: performance.now() };
    } else place(goal);
    invalidate();
  };
  /** The way you're looking now, so an automatic fit keeps your angle. */
  const looking = () => {
    const d = camera.position.clone().sub(controls?.target ?? new THREE.Vector3());
    return d.lengthSq() > 1e-6 ? d : new THREE.Vector3(...DIRS[now.current.view]);
  };
  const sits = () => {
    const c = now.current.canvas;
    const persp = camera as THREE.PerspectiveCamera;
    if (persp.isPerspectiveCamera && c.height > 0 && Math.abs(persp.aspect - c.width / c.height) > 1e-6) {
      persp.aspect = c.width / c.height;
      persp.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
    return framing(corners(now.current.box).map((p) => p.project(camera).toArray() as [number, number, number]));
  };
  const act = (reason: FitReason | null) => {
    if (reason) fit(reason === "design" ? new THREE.Vector3(...DIRS[now.current.view]) : looking(), reason !== "design");
  };

  /** One frame of an orbit: the camera and what it looks at both turn around the model's middle. */
  const orbitFrame = (delta: number) => {
    const aim = now.current.orbit ?? 0;
    if (aim === 0 && spin.current === 0) return;
    const step = orbitStep(spin.current, aim, delta * 1000);
    spin.current = step.speed;
    if (!step.degrees) return;
    const middle = now.current.box.getCenter(new THREE.Vector3()).toArray();
    camera.position.fromArray(turnAround(camera.position.toArray(), middle, step.degrees));
    const target = controls?.target ?? new THREE.Vector3(...middle);
    target.fromArray(turnAround(target.toArray(), middle, step.degrees));
    camera.lookAt(target);
    controls?.update();
  };

  useFrame((_, delta) => {
    const g = glide.current;
    if (!g) {
      orbitFrame(delta);
      return;
    }
    const k = Math.min(1, (performance.now() - g.start) / GLIDE_MS);
    const e = 1 - (1 - k) ** 3;
    const target = g.from.target.clone().lerp(g.to.target, e);
    camera.position.lerpVectors(g.from.position, g.to.position, e);
    camera.lookAt(target);
    if (controls) {
      controls.target.copy(target);
      controls.update();
    }
    if (k >= 1) {
      glide.current = null;
      camera.far = g.to.far;
      camera.updateProjectionMatrix();
    }
  });

  // A camera view, Fit, or a new fitKey frames the model from that view.
  // Without auto, a new design comes in by its fitKey, and the first parts
  // of an empty one frame too.
  useEffect(() => {
    fit(new THREE.Vector3(...DIRS[view]), false);
    if (auto) memory.current = autoFit(memory.current, { kind: "fitted", design, width: canvas.width, height: canvas.height }).memory;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, fitKey, controls, auto || parts.length > 0]);

  // Show me frames a few parts, with room round them, from where you're
  // looking. The model then reaches past the frame on purpose, so it
  // counts as a view you've moved: only Fit or another design frames it
  // all again.
  useEffect(() => {
    if (!target) return;
    const picked = new THREE.Box3(new THREE.Vector3(...target.box.min), new THREE.Vector3(...target.box.max));
    const b = picked.clone().expandByScalar(Math.min(150, Math.max(30, picked.getSize(new THREE.Vector3()).length() * 0.08)));
    // Never wider than Fit would frame the whole model.
    b.intersect(now.current.box);
    fit(looking(), true, b.isEmpty() ? picked : b);
    if (memory.current) memory.current = { ...memory.current, moved: true, overflow: true, small: false, pending: null };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.key]);

  // Automatic fits: a new design frames at once, before it's drawn; a
  // resize or a bigger model waits until the size settles and no panel is
  // being dragged.
  useLayoutEffect(() => {
    if (!auto) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = () => {
      if (document.body.classList.contains("dragging")) {
        timer = setTimeout(look, 150);
        return;
      }
      const c = now.current.canvas;
      const r = autoFit(memory.current, { kind: "look", design: now.current.design, width: c.width, height: c.height, ...sits() });
      memory.current = r.memory;
      act(r.fit);
    };
    if (!memory.current || memory.current.design !== design) look();
    else timer = setTimeout(look, 150);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, design, sig, canvas.width, canvas.height]);

  // Your own turning holds automatic fits back until you let go.
  useEffect(() => {
    if (!auto || !controls) return;
    let at: { position: THREE.Vector3; target: THREE.Vector3 } | null = null;
    const onStart = () => {
      glide.current = null;
      at = { position: camera.position.clone(), target: controls.target.clone() };
      memory.current = autoFit(memory.current, { kind: "hold" }).memory;
    };
    const onEnd = () => {
      // A click that didn't move the camera isn't a turn. A turn from outside, such as Crossband's, has no start.
      const turned = !at || at.position.distanceTo(camera.position) > 0.5 || at.target.distanceTo(controls.target) > 0.5;
      at = null;
      const r = autoFit(memory.current, { kind: "release", ...sits(), turned });
      memory.current = r.memory;
      act(r.fit);
    };
    controls.addEventListener("start", onStart);
    controls.addEventListener("end", onEnd);
    return () => {
      controls.removeEventListener("start", onStart);
      controls.removeEventListener("end", onEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, controls, camera]);

  // A drag in the view, such as a box select, holds them back too.
  const wasHeld = useRef(false);
  useEffect(() => {
    if (!auto || held === wasHeld.current) return;
    wasHeld.current = held;
    const r = autoFit(memory.current, held ? { kind: "hold" } : { kind: "release", ...sits(), turned: false });
    memory.current = r.memory;
    act(r.fit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, held]);
  return null;
}

const boxSize = (b: Box) => b.max.map((v, i) => v - b.min[i]!) as [number, number, number];
const boxCentre = (b: Box) => b.max.map((v, i) => (v + b.min[i]!) / 2) as [number, number, number];

/** One joint's tongues, cut-outs and fixings, for the see-through view. */
function JointDetail({
  j,
  colourOf,
  scene,
  onHover,
  onPick,
}: {
  j: DerivedJoint;
  colourOf: (id: string) => string;
  scene: SceneColours;
  onHover: (label: string | null) => void;
  onPick: (ids: string[]) => void;
}) {
  const label = `${j.id}: ${j.type.replace(/_/g, " ")}, ${j.guest} into ${j.host}`;
  const events = {
    onPointerOver: (e: ThreeEvent<PointerEvent>) => {
      e.stopPropagation();
      onHover(label);
    },
    onPointerOut: () => onHover(null),
    onClick: (e: ThreeEvent<MouseEvent>) => {
      e.stopPropagation();
      onPick([j.guest, j.host]);
    },
  };
  return (
    <>
      {j.features.map((f: JointFeature, k: number) => {
        if (f.box && (f.kind === "tongue" || f.kind === "removed")) {
          const tongue = f.kind === "tongue";
          return (
            <mesh key={k} position={boxCentre(f.box)} {...events}>
              <boxGeometry args={boxSize(f.box)} />
              <meshStandardMaterial
                color={tongue ? colourOf(f.part) : scene.cut}
                transparent={!tongue}
                opacity={tongue ? 1 : 0.35}
                depthWrite={tongue}
              />
              <Edges color={tongue ? scene.tongue : scene.cutEdge} lineWidth={2} />
            </mesh>
          );
        }
        if (f.from && f.to) {
          const a = new THREE.Vector3(...f.from);
          const b = new THREE.Vector3(...f.to);
          const dir = b.clone().sub(a);
          const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
          return (
            <mesh key={k} position={a.clone().add(b).multiplyScalar(0.5)} quaternion={q} {...events}>
              <cylinderGeometry args={[(f.diameter_mm ?? 4) / 2, (f.diameter_mm ?? 4) / 2, dir.length(), 12]} />
              <meshStandardMaterial color={scene.fastener} metalness={0.4} roughness={0.4} />
            </mesh>
          );
        }
        return null;
      })}
    </>
  );
}

/** Sets the colour response: true-to-colour for the finished look, the usual film look otherwise. */
function ToneMap({ look }: { look: Look }) {
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    gl.toneMapping = look === "finished" ? THREE.NeutralToneMapping : THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 1;
  }, [gl, look]);
  return null;
}

/** A thin blue sheet over each selected face, so you can see which ones you've picked. */
function FaceMarks({ parts, faces, scene }: { parts: DerivedPart[]; faces: string[]; scene: SceneColours }) {
  const byId = new Map(parts.map((p) => [p.id, p]));
  return (
    <>
      {faces.map((key) => {
        const dot = key.lastIndexOf(".");
        const p = byId.get(key.slice(0, dot));
        const face = key.slice(dot + 1) as Face;
        if (!p || !FACES.includes(face)) return null;
        const axis = Math.floor(FACES.indexOf(face) / 2);
        const max = FACES.indexOf(face) % 2 === 1;
        const size = p.nominal.max.map((v, i) => v - p.nominal.min[i]!) as [number, number, number];
        const pos = p.nominal.max.map((v, i) => (v + p.nominal.min[i]!) / 2) as [number, number, number];
        pos[axis] = (max ? p.nominal.max[axis]! + 0.4 : p.nominal.min[axis]! - 0.4);
        const dims = size.map((v, i) => (i === axis ? 0.2 : v + 0.4)) as [number, number, number];
        return (
          <mesh key={key} position={pos} renderOrder={5} userData={{ uiOnly: true }}>
            <boxGeometry args={dims} />
            <meshBasicMaterial color={scene.pickEdge} transparent opacity={0.45} depthWrite={false} toneMapped={false} />
          </mesh>
        );
      })}
    </>
  );
}

/**
 * A dimension's size, such as "+40 mm", in white on the ghost's pink. It
 * stays the same size on screen, shows through the parts, and goes into a
 * picture of the view, so Claude sees it too.
 */
function DimLabel({ text, position, scene }: { text: string; position: Vec; scene: SceneColours }) {
  const { texture, aspect } = useMemo(() => {
    const font = "bold 30px Helvetica, Arial, sans-serif";
    const c = document.createElement("canvas");
    const measure = c.getContext("2d")!;
    measure.font = font;
    const h = 46;
    c.width = Math.ceil(measure.measureText(text).width) + 28;
    c.height = h;
    // Sizing the canvas resets its drawing state, so the font is set again.
    const g = c.getContext("2d")!;
    g.fillStyle = scene.ghost;
    g.beginPath();
    g.roundRect(1, 1, c.width - 2, h - 2, 10);
    g.fill();
    g.fillStyle = scene.pinRing;
    g.font = font;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(text, c.width / 2, h / 2 + 1);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return { texture: t, aspect: c.width / h };
  }, [text, scene.ghost, scene.pinRing]);
  useEffect(() => () => texture.dispose(), [texture]);
  const height = 0.024;
  return (
    <sprite position={position} scale={[height * aspect, height, 1]} renderOrder={11}>
      <spriteMaterial map={texture} sizeAttenuation={false} depthTest={false} transparent />
    </sprite>
  );
}

/** One dimension on a suggested change: a line from the old edge to the new one, with ticks, extension lines and its size. */
function MoveDimension({ m, scene }: { m: MoveMark; scene: SceneColours }) {
  const at = (p: Vec, k: number) => p.map((v, i) => v + m.tick[i]! * k) as Vec;
  const mid = m.from.map((v, i) => (v + m.to[i]!) / 2) as Vec;
  return (
    <group>
      <Line points={[m.from, m.to]} color={scene.ghost} lineWidth={2} />
      <Line points={[at(m.from, -1), at(m.from, 1)]} color={scene.ghost} lineWidth={2} />
      <Line points={[at(m.to, -1), at(m.to, 1)]} color={scene.ghost} lineWidth={2} />
      {/* Extension lines, from the parts out to the dimension. */}
      <Line points={[at(m.from, -2.5), at(m.from, -1)]} color={scene.ghost} lineWidth={1} />
      <Line points={[at(m.to, -2.5), at(m.to, -1)]} color={scene.ghost} lineWidth={1} />
      <DimLabel text={m.label} position={at(mid, 4.5)} scene={scene} />
    </group>
  );
}

/**
 * A suggested change over the model as it is: each part's new place,
 * see-through in the ghost's colour and outlined, and how far it moves.
 * It takes no clicks, so the parts under it still pick.
 */
function GhostLayer({ ghost, scene }: { ghost: Ghost; scene: SceneColours }) {
  return (
    <>
      {ghost.parts.map((g) => (
        <mesh key={`ghost:${g.id}`} position={boxCentre(g.box)} renderOrder={4} raycast={() => null}>
          <boxGeometry args={boxSize(g.box)} />
          <meshBasicMaterial color={scene.ghost} transparent opacity={g.added ? 0.3 : 0.22} depthWrite={false} toneMapped={false} />
          <Edges color={scene.ghost} lineWidth={2} />
        </mesh>
      ))}
      {ghost.marks.map((m) => (
        <MoveDimension key={`${m.axis}:${m.from.join(",")}:${m.label}`} m={m} scene={scene} />
      ))}
    </>
  );
}

function Part({
  p,
  selected,
  highlighted,
  faded = false,
  outlined = false,
  xray,
  wood,
  scene,
  onPick,
  onHover,
}: {
  p: DerivedPart;
  scene: SceneColours;
  selected: boolean;
  highlighted: boolean;
  /** A part a suggested change moves or takes away, faded where it is now. */
  faded?: boolean;
  /** A part a suggested change moves or adds, outlined in the ghost's colour. */
  outlined?: boolean;
  xray: boolean;
  /** Set in the finished look: the timber and the finish on each face. */
  wood: WoodLook | null;
  onPick: (id: string, add: boolean, hit: { point: THREE.Vector3; normal: THREE.Vector3 | null }) => void;
  onHover: (id: string | null) => void;
}) {
  const size = p.nominal.max.map((v, i) => v - p.nominal.min[i]!) as [number, number, number];
  const centre = p.nominal.max.map((v, i) => (v + p.nominal.min[i]!) / 2) as [number, number, number];
  const colour = selected ? scene.pick : colourFor(p);
  const woodMaterial = useMemo(() => (wood ? makeWoodMaterial() : null), [wood !== null]);
  useEffect(() => () => woodMaterial?.dispose(), [woodMaterial]);
  const sig = wood ? `${lookKey(wood)}|${size.join(",")}|${p.grain_axis}${p.thickness_axis}` : "";
  useLayoutEffect(() => {
    if (woodMaterial && wood) setWood(woodMaterial, p, wood);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [woodMaterial, sig, p.id]);
  return (
    <mesh
      castShadow={!!wood}
      receiveShadow={!!wood}
      position={centre}
      onClick={(e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation();
        onPick(p.id, e.shiftKey || e.metaKey, { point: e.point.clone(), normal: e.face ? e.face.normal.clone() : null });
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        onHover(p.id);
      }}
      onPointerOut={() => onHover(null)}
    >
      <boxGeometry args={size} />
      {woodMaterial ? (
        <primitive object={woodMaterial} attach="material" />
      ) : (
        // three.js only applies a change of transparency to a new material.
        <meshStandardMaterial
          key={xray ? "see-through" : faded ? "faded" : "solid"}
          color={colour}
          roughness={0.75}
          transparent={xray || faded || p.unverified || p.decor}
          opacity={xray ? (selected ? 0.18 : 0.04) : faded ? 0.28 : p.unverified ? 0.75 : p.decor ? 0.6 : 1}
          depthWrite={!xray && !faded}
          emissive={highlighted ? scene.glow : "#000000"}
          emissiveIntensity={highlighted ? 0.25 : 0}
        />
      )}
      {(!wood || selected || highlighted || outlined) && (
        <Edges
          color={selected ? scene.pickEdge : outlined ? scene.ghost : highlighted ? scene.glow : xray || faded ? scene.edgeSee : scene.edge}
          lineWidth={selected || highlighted || outlined ? 2 : 1}
          userData={{ uiOnly: !!wood && !outlined }}
        />
      )}
    </mesh>
  );
}

export function Viewport({
  parts,
  joints,
  hardware,
  selection,
  highlight,
  view,
  xray,
  fitKey,
  mode,
  pins,
  apiRef,
  onSelect,
  onPin,
  design,
  look,
  lighting,
  faceMode,
  faces,
  onFaces,
  focus,
  onClickFace,
  marks = [],
  photo,
  autoFit: auto = false,
  designKey,
  paused = false,
  ghost = null,
  outline = [],
  frame = null,
  orbit = null,
  onOrbitEnd,
}: {
  parts: DerivedPart[];
  joints: DerivedJoint[];
  hardware: DerivedHardware[];
  selection: string[];
  highlight: string[];
  view: CameraView;
  xray: boolean;
  fitKey: string;
  mode: PointMode;
  pins: Pin[];
  apiRef: React.MutableRefObject<ViewportApi | null>;
  onSelect: (ids: string[]) => void;
  onPin: (pin: Omit<Pin, "n">) => void;
  design: Pick<Design, "materials" | "finishes">;
  look: Look;
  lighting: Lighting;
  /** Clicks and boxes pick faces instead of whole parts. */
  faceMode: boolean;
  /** Selected faces, as "part.face". */
  faces: string[];
  onFaces: (faces: string[]) => void;
  /** Frame this region instead of the whole model. */
  focus?: Box;
  /** Told the face under every selecting click, as "part.face". */
  onClickFace?: (face: string) => void;
  /** Faces to show in blue without selecting them, as "part.face". */
  marks?: string[];
  /**
   * Placing the design in a photo: the canvas is see-through so the photo
   * behind it shows, with this lens, shadow strength and remembered line-up.
   */
  photo?: { fov: number; shadow: number; memoryKey: string } | null;
  /**
   * Frame the model again by itself on a design switch, a resize, or when a
   * change takes it past the frame. Never while lining it up with a photo.
   */
  autoFit?: boolean;
  /** Which design this is, so a switch frames the new one. */
  designKey?: string;
  /** Out of sight under the 2D view: it stays ready, and only draws when something changes. */
  paused?: boolean;
  /** A suggested change drawn over the model as it is. */
  ghost?: Ghost | null;
  /** Parts outlined in the ghost's colour, as the design with a suggested change shows them. */
  outline?: string[];
  /** A few parts to frame, once per key, as Show me does. */
  frame?: { box: Box; key: number } | null;
  /** Keep turning around the model at this many degrees a second, as another app can ask. Null holds it still. */
  orbit?: number | null;
  /** The woodworker took the camera, so the orbit is over. */
  onOrbitEnd?: () => void;
}) {
  const scene = useScene();
  const [hover, setHover] = useState<string | null>(null);
  const [jointHover, setJointHover] = useState<string | null>(null);
  const [rect, setRect] = useState<{ x0: number; y0: number; x1: number; y1: number; add: boolean } | null>(null);
  /** Box select by touch: two fingers, a tap for each corner, or one finger dragged. */
  const [touch, setTouch] = useState<TouchBox>(NO_TOUCH_BOX);
  const touchNow = useRef<TouchBox>(NO_TOUCH_BOX);
  // Another tool drops a half-drawn box.
  useEffect(() => {
    touchNow.current = NO_TOUCH_BOX;
    setTouch(NO_TOUCH_BOX);
  }, [mode]);
  const live = useMemo(() => parts.filter((p) => !p.broken), [parts]);
  const sel = new Set(selection);
  const hl = new Set(highlight);
  const fade = new Set(ghost?.faded ?? []);
  const lined = new Set(outline);
  const ghostBoxes = useMemo(() => ghost?.parts.map((g) => g.box), [ghost]);
  const hovered = hover ? live.find((p) => p.id === hover) : undefined;
  const down = useRef<[number, number] | null>(null);
  const finished = (look === "finished" || !!photo) && !xray;
  /** How fast the orbit turns right now, in degrees a second. */
  const spin = useRef(0);
  // Out of sight or lined up with a photo, the camera stops dead.
  const inPhoto = !!photo;
  useEffect(() => {
    if (paused || inPhoto) spin.current = 0;
  }, [paused, inPhoto]);
  /** Any press, drag or scroll on the view takes the camera back from an orbit at once. */
  const grab = () => {
    spin.current = 0;
    if (orbit !== null) onOrbitEnd?.();
  };

  const pick = (id: string, add: boolean, hit: { point: THREE.Vector3; normal: THREE.Vector3 | null }) => {
    if (mode === "pan") return;
    if (mode === "pin") {
      onPin({ part: id, face: hit.normal ? faceFromNormal(hit.normal) : "front", point_mm: [half(hit.point.x), half(hit.point.y), half(hit.point.z)] });
      return;
    }
    if (hit.normal) onClickFace?.(`${id}.${faceFromNormal(hit.normal)}`);
    if (faceMode) {
      if (!hit.normal) return;
      const key = `${id}.${faceFromNormal(hit.normal)}`;
      onFaces(add ? (faces.includes(key) ? faces.filter((f) => f !== key) : [...faces, key]) : [key]);
      return;
    }
    onSelect(add ? (sel.has(id) ? selection.filter((s) => s !== id) : [...selection, id]) : [id]);
  };

  // Box select: every part whose middle falls inside the box you drag. In
  // face mode, every face of those parts, including the hidden ones.
  const finishBox = (r: NonNullable<typeof rect>) => {
    const api = apiRef.current;
    if (!api) return;
    const inside = partsInRect(live, api.project, r);
    if (!inside.length && Math.abs(r.x1 - r.x0) < 4 && Math.abs(r.y1 - r.y0) < 4) return;
    if (faceMode) {
      const picked = facesOf(inside);
      onFaces(r.add ? [...new Set([...faces, ...picked])] : picked);
      return;
    }
    onSelect(r.add ? [...new Set([...selection, ...inside])] : inside);
  };

  /** A finger on the box-select layer, read by touchBox. A finished box selects like a dragged one. */
  const finger = (e: React.PointerEvent<HTMLDivElement>, kind: FingerEvent["kind"]) => {
    const b = e.currentTarget.getBoundingClientRect();
    const r = touchBox(touchNow.current, { kind, id: e.pointerId, x: e.clientX - b.left, y: e.clientY - b.top });
    touchNow.current = r.state;
    setTouch(r.state);
    if (r.done) finishBox({ ...r.done, add: false });
  };

  /** The box being drawn, by mouse or by touch. */
  const drawnBox = rect ?? touch.rect;

  return (
    <div className={`viewport mode-${mode}`} onPointerDownCapture={grab} onWheelCapture={grab}>
    <Canvas
      shadows
      frameloop={paused ? "demand" : "always"}
      gl={{ preserveDrawingBuffer: true, alpha: true }}
      camera={{ fov: 35, position: [2000, 1500, 2500] }}
      onPointerDown={(e) => (down.current = [e.clientX, e.clientY])}
      onPointerMissed={(e) => {
        const d = down.current;
        // A drag that orbits the camera shouldn't clear the selection.
        if (d && Math.hypot(e.clientX - d[0], e.clientY - d[1]) > 4) return;
        onSelect([]);
        onFaces([]);
      }}
    >
      <ToneMap look={finished ? "finished" : "plain"} />
      {finished ? (
        <FinishedLights lighting={lighting} parts={live} {...(photo ? { photo: { shadow: photo.shadow } } : {})} />
      ) : (
        <>
          <color attach="background" args={[scene.bg]} />
          <ambientLight intensity={0.85} />
          <directionalLight position={[3000, 5000, 4000]} intensity={1.6} />
          <directionalLight position={[-3000, 2000, -2000]} intensity={0.5} />
          <Grid
            args={[20000, 20000]}
            cellSize={100}
            sectionSize={1000}
            cellColor={scene.cell}
            sectionColor={scene.section}
            fadeDistance={12000}
            infiniteGrid
            position={[0, -0.5, 0]}
          />
        </>
      )}
      {live.map((p) => (
        <Part
          key={p.id}
          p={p}
          scene={scene}
          selected={sel.has(p.id)}
          highlighted={hl.has(p.id)}
          faded={fade.has(p.id)}
          outlined={lined.has(p.id)}
          xray={xray}
          wood={finished && !p.unverified && !p.decor && !fade.has(p.id) ? woodLookOf(design, p) : null}
          onHover={setHover}
          onPick={pick}
        />
      ))}
      {hardware.flatMap((h) =>
        h.boxes.map((b, i) => (
          <mesh
            key={`${h.id}:${i}`}
            position={boxCentre(b)}
            onPointerOver={(e) => {
              e.stopPropagation();
              setJointHover(`${h.name} (${h.id})`);
            }}
            onPointerOut={() => setJointHover(null)}
          >
            <boxGeometry args={boxSize(b)} />
            <meshStandardMaterial color={scene.hardware} metalness={0.6} roughness={0.35} />
            <Edges color={scene.hardwareEdge} />
          </mesh>
        )),
      )}
      {xray &&
        joints.map((j) => {
          // With parts selected, show only their joints.
          if (selection.length && !sel.has(j.host) && !sel.has(j.guest)) return null;
          return (
            <JointDetail
              key={j.id}
              j={j}
              scene={scene}
              colourOf={(id) => {
                const p = live.find((x) => x.id === id);
                return p ? colourFor(p) : "#d2ab7c";
              }}
              onHover={setJointHover}
              onPick={onSelect}
            />
          );
        })}
      {hovered && !jointHover && (
        <Html position={hovered.nominal.max.map((v, i) => (v + hovered.nominal.min[i]!) / 2) as [number, number, number]} center>
          <div className="hover-tag">{hovered.id}</div>
        </Html>
      )}
      {jointHover && (
        <Html fullscreen>
          <div className="joint-tag">{jointHover}</div>
        </Html>
      )}
      {ghost && <GhostLayer ghost={ghost} scene={scene} />}
      <FaceMarks parts={live} faces={marks.length ? [...faces, ...marks] : faces} scene={scene} />
      {pins.map((p) => (
        <PinMarker key={p.n} pin={p} scene={scene} />
      ))}
      {/* In Pan mode a plain drag moves the view; right-drag rotates instead. */}
      <OrbitControls
        makeDefault
        enableDamping={false}
        mouseButtons={
          mode === "pan"
            ? { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }
            : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }
        }
        touches={mode === "pan" ? { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE } : { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }}
      />
      <CameraRig
        parts={live}
        {...(ghostBoxes ? { extra: ghostBoxes } : {})}
        view={view}
        fitKey={fitKey}
        {...(focus ? { focus } : {})}
        target={frame}
        auto={auto && !photo}
        designKey={designKey ?? ""}
        held={rect !== null || touch.rect !== null}
        paused={paused}
        orbit={paused || inPhoto ? null : orbit}
        spin={spin}
      />
      {photo && <PhotoCamera fov={photo.fov} memoryKey={photo.memoryKey} />}
      <ApiBridge apiRef={apiRef} />
    </Canvas>
    {mode === "box" && (
      <div
        className="box-select"
        onPointerDown={(e) => {
          if (e.pointerType === "touch") return finger(e, "down");
          const b = e.currentTarget.getBoundingClientRect();
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            // Synthetic pointers can't be captured; the box still works without it.
          }
          const x = e.clientX - b.left;
          const y = e.clientY - b.top;
          setRect({ x0: x, y0: y, x1: x, y1: y, add: e.shiftKey || e.metaKey });
        }}
        onPointerMove={(e) => {
          if (e.pointerType === "touch") return finger(e, "move");
          if (!rect) return;
          if (e.buttons === 0) {
            finishBox(rect);
            setRect(null);
            return;
          }
          const b = e.currentTarget.getBoundingClientRect();
          setRect({ ...rect, x1: e.clientX - b.left, y1: e.clientY - b.top });
        }}
        onPointerUp={(e) => {
          if (e.pointerType === "touch") return finger(e, "up");
          const b = e.currentTarget.getBoundingClientRect();
          if (rect) finishBox({ ...rect, x1: e.clientX - b.left, y1: e.clientY - b.top });
          setRect(null);
        }}
        onPointerCancel={(e) => {
          if (e.pointerType === "touch") finger(e, "cancel");
        }}
        // A release outside the window, or a lost capture, still ends the box.
        onLostPointerCapture={(e) => {
          if (e.pointerType === "touch") return;
          if (rect) finishBox(rect);
          setRect(null);
        }}
      >
        {touch.anchor && <div className="box-corner" style={{ left: touch.anchor.x, top: touch.anchor.y }} />}
        {drawnBox && (
          <div
            className="box-rect"
            style={{
              left: Math.min(drawnBox.x0, drawnBox.x1),
              top: Math.min(drawnBox.y0, drawnBox.y1),
              width: Math.abs(drawnBox.x1 - drawnBox.x0),
              height: Math.abs(drawnBox.y1 - drawnBox.y0),
            }}
          />
        )}
      </div>
    )}
    </div>
  );
}
