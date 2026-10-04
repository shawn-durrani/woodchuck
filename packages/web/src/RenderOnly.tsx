// The page the server photographs to make a picture of the open design:
// just the 3D view, filling the window, in the look, lighting and camera
// view the address asks for. With preview=<id> it draws the design with
// that preview's change made, without making it. It marks the page ready
// once the design has arrived and a few frames have drawn, so the shot
// isn't taken half-built.

import { useEffect, useMemo, useRef } from "react";
import { applyOps, derive } from "@woodchuck/core";
import { useServer } from "./api";
import { LIGHTINGS, type Lighting } from "./components/Lights";
import { Viewport, type CameraView, type Look, type ViewportApi } from "./components/Viewport";

const VIEWS: CameraView[] = ["iso", "front", "top", "left", "right", "back"];
const noop = () => {};

export function RenderOnly({ params }: { params: URLSearchParams }) {
  const { state } = useServer("render");
  const api = useRef<ViewportApi | null>(null);
  const look: Look = params.get("look") === "plain" ? "plain" : "finished";
  const lighting = (LIGHTINGS.find((l) => l.id === params.get("lighting"))?.id ?? "daylight") as Lighting;
  const view = (VIEWS.find((v) => v === params.get("view")) ?? "iso") as CameraView;

  useEffect(() => {
    if (!state) return;
    let frames = 0;
    let raf = 0;
    const tick = () => {
      if (++frames < 6) raf = requestAnimationFrame(tick);
      else setTimeout(() => (document.body.dataset.ready = "1"), 600);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state !== null]);

  // A preview's change, worked out on a copy of the design.
  const previewId = params.get("preview");
  const shown = useMemo(() => {
    if (!state) return null;
    const item = previewId ? state.chat.find((c) => c.kind === "preview" && c.id === previewId) : undefined;
    if (item?.kind !== "preview") return { design: state.design, derived: state.derived };
    try {
      const design = applyOps(state.design, item.ops);
      return { design, derived: derive(design) };
    } catch {
      return { design: state.design, derived: state.derived };
    }
  }, [state, previewId]);

  if (!state || !shown) return null;
  return (
    <div className="render-only">
      <Viewport
        parts={shown.derived.parts}
        joints={shown.derived.joints}
        hardware={shown.derived.hardware}
        selection={[]}
        highlight={[]}
        view={view}
        xray={false}
        fitKey={`render:${view}`}
        mode="pick"
        pins={[]}
        apiRef={api}
        onSelect={noop}
        onPin={noop}
        design={shown.design}
        look={look}
        lighting={lighting}
        faceMode={false}
        faces={[]}
        onFaces={noop}
      />
    </div>
  );
}
