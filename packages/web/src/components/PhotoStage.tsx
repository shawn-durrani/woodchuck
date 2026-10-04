// Placing the design in a photo of the room. The 3D view takes the photo's
// shape, as big as fits, with the photo behind a see-through canvas, so
// what you line up is exactly what Render saves. A bar along the bottom
// sets the lens and the shadow, and changes or removes the photo.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { BLEND_NEEDS_KEY, BLEND_NOTICE } from "../blend";
import { savedNote } from "../signals";

export interface PhotoSettings {
  /** The camera's vertical field of view, in degrees, to match the photo's lens. */
  fov: number;
  /** How dark the model's shadow on the photo's floor is, from 0 to 1. */
  shadow: number;
}

export const DEFAULT_PHOTO: PhotoSettings = { fov: 50, shadow: 0.35 };

/** Reads a photo file, shrinks it to at most 3000 pixels across, and returns JPEG data. */
export async function readPhoto(file: File): Promise<{ media_type: "image/jpeg"; data: string }> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, 3000 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    const data = c.toDataURL("image/jpeg", 0.9);
    return { media_type: "image/jpeg", data: data.slice(data.indexOf(",") + 1) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Draws the model's picture over the photo, at the photo's own size. Returns a PNG data URL. */
export async function compose(photoUrl: string, modelPng: string): Promise<string> {
  const load = async (src: string) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    return img;
  };
  const [photo, model] = await Promise.all([load(photoUrl), load(modelPng)]);
  const c = document.createElement("canvas");
  c.width = photo.naturalWidth;
  c.height = photo.naturalHeight;
  const g = c.getContext("2d")!;
  g.drawImage(photo, 0, 0);
  g.drawImage(model, 0, 0, c.width, c.height);
  return c.toDataURL("image/png");
}

/** The pictures of one AI blend. */
export interface BlendPictures {
  /** The true-scale placement, with no label. */
  before: string;
  /** The blend, shown under a live label. */
  after: string;
  /** The blend with its label drawn in, which is the copy that gets saved. */
  labelled: string;
}

/** The AI blend's result beside the plain placement, to compare and save. A blend always shows its not-to-scale label, with a way back to the true-scale picture. */
function BlendResult({ result, name, onClose, onSaved }: { result: BlendPictures; name: string; onClose: () => void; onSaved: (text: string) => void }) {
  const [side, setSide] = useState<"after" | "before">("after");
  return (
    <div className="blend-result" role="dialog" aria-label="AI blend">
      <img src={side === "after" ? result.after : result.before} alt={side === "after" ? "Blended by AI, not to scale" : "As placed, to scale"} />
      {side === "after" && (
        <div className="blend-label">
          <span>{BLEND_NOTICE}</span>
          <button onClick={() => setSide("before")}>Back to true scale</button>
        </div>
      )}
      <div className="blend-bar">
        <div className="seg">
          <button className={side === "before" ? "on" : ""} onClick={() => setSide("before")}>
            True scale
          </button>
          <button className={side === "after" ? "on" : ""} onClick={() => setSide("after")}>
            AI blend
          </button>
        </div>
        <a
          className="button primary"
          href={result.labelled}
          download={`${name} (blended).png`}
          title="Saves the AI blend, with its not-to-scale label in the corner"
          onClick={() => onSaved(savedNote("the AI blend, labelled not to scale,", `${name} (blended).png`))}
        >
          Save blend
        </a>
        <button onClick={onClose}>Close</button>
        <span className="muted small">Blended by OpenAI. It can quietly change drawer counts and proportions, so don't size anything from it.</span>
      </div>
    </div>
  );
}

export function PhotoStage({
  url,
  settings,
  onSettings,
  onChange,
  onRemove,
  onDone,
  busy,
  children,
  onBlend,
  canBlend,
  error,
  onSaved,
  blending,
  blendResult,
  onCloseBlend,
  name,
}: {
  url: string;
  settings: PhotoSettings;
  onSettings: (s: PhotoSettings) => void;
  onChange: (file: File) => void;
  onRemove: () => void;
  onDone: () => void;
  busy: boolean;
  children: ReactNode;
  /** Sends the placed picture to the AI blend. */
  onBlend: () => void;
  /** Whether the server has an OpenAI key, so the blend can run at all. */
  canBlend: boolean;
  /** An error from the photo or the blend, shown on the photo bar. */
  error: ReactNode;
  /** Says what was saved, when you save the blend. */
  onSaved: (text: string) => void;
  blending: boolean;
  blendResult: BlendPictures | null;
  onCloseBlend: () => void;
  /** The design's name, for the saved file. */
  name: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const [aspect, setAspect] = useState<number | null>(null);
  const [room, setRoom] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const img = new Image();
    img.onload = () => setAspect(img.naturalWidth / img.naturalHeight);
    img.src = url;
  }, [url]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setRoom({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // As big as fits, in the photo's shape.
  const size = aspect && room.w && room.h ? (room.w / room.h > aspect ? { w: room.h * aspect, h: room.h } : { w: room.w, h: room.w / aspect }) : null;

  return (
    <div className="photo-room" ref={box}>
      {size && (
        <div className="photo-stage" style={{ width: size.w, height: size.h }}>
          <img className="photo-backdrop" src={url} alt="Your photo of the room" />
          {children}
          {blending && <div className="blend-working">Blending the light with OpenAI. This takes up to a minute…</div>}
          {blendResult && <BlendResult result={blendResult} name={name} onClose={onCloseBlend} onSaved={onSaved} />}
        </div>
      )}
      <div className="photo-bar">
        {error}
        <label title="Match the lens the photo was taken with. Most phone photos are around 50 to 60 degrees">
          Lens
          <input type="range" min={20} max={80} step={1} value={settings.fov} onChange={(e) => onSettings({ ...settings, fov: Number(e.target.value) })} />
          <span>{settings.fov}°</span>
        </label>
        <label title="How dark the shadow on the floor is">
          Shadow
          <input type="range" min={0} max={0.8} step={0.05} value={settings.shadow} onChange={(e) => onSettings({ ...settings, shadow: Number(e.target.value) })} />
        </label>
        {/* A disabled button shows no tooltip in some browsers, so the reason sits on a wrapper. */}
        <span
          className="blend-slot"
          title={
            canBlend
              ? "Ask OpenAI to relight the piece so it matches the room. Only the piece and its shadow change. It sends the photo to OpenAI and costs money"
              : BLEND_NEEDS_KEY
          }
        >
          <button disabled={blending || !canBlend} aria-describedby={canBlend ? undefined : "blend-needs-key"} onClick={onBlend}>
            AI blend
          </button>
          {!canBlend && (
            <span id="blend-needs-key" hidden>
              {BLEND_NEEDS_KEY}
            </span>
          )}
        </span>
        <button disabled={busy} onClick={() => file.current?.click()}>
          Change photo
        </button>
        <button disabled={busy} onClick={onRemove}>
          Remove photo
        </button>
        <button className="primary" onClick={onDone}>
          Done
        </button>
        <span className="muted small">Drag to turn, right-drag to move, scroll to zoom, until the piece sits on the floor.</span>
        <input
          ref={file}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onChange(f);
            e.target.value = "";
          }}
        />
      </div>
    </div>
  );
}
