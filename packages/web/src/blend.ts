// The page's half of the AI blend. OpenAI's image models work at a few
// fixed sizes, so the placed picture is padded to the nearest shape rather
// than stretched, which would change the piece's proportions. A mask opens
// only the piece and its shadow, grown a little so contact shadows can
// change. The result is cropped back, scaled to the photo's own size and
// pasted into the original photo through a feathered edge, so the room
// stays exactly as photographed. An image model can quietly change drawer
// counts and proportions, so a blend is labelled as not to scale, on screen
// and in the corner of every copy that gets saved.

export type BlendSize = "1024x1024" | "1536x1024" | "1024x1536";

export interface Fit {
  size: BlendSize;
  width: number;
  height: number;
  /** Where the photo sits inside the padded picture. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The nearest size the image model makes, and where a photo of this shape sits in it. */
export function fitFor(photoW: number, photoH: number): Fit {
  const aspect = photoW / photoH;
  const [size, width, height]: [BlendSize, number, number] =
    aspect >= 1.2 ? ["1536x1024", 1536, 1024] : aspect <= 1 / 1.2 ? ["1024x1536", 1024, 1536] : ["1024x1024", 1024, 1024];
  const scale = Math.min(width / photoW, height / photoH);
  const w = Math.round(photoW * scale);
  const h = Math.round(photoH * scale);
  return { size, width, height, x: Math.round((width - w) / 2), y: Math.round((height - h) / 2), w, h };
}

/** What a picture is: only an AI blend isn't to scale. The true-scale render, the photo composite and the plan views are. */
export type PictureKind = "blend" | "true-scale";

/** Over a blend on screen. */
export const BLEND_NOTICE = "AI blend: not to scale";
/** In the corner of a saved blend. */
export const BLEND_LABEL = "AI blend · not to scale";
/** Why AI blend is off, and how to turn it on. Said before anything is sent or paid for. */
export const BLEND_NEEDS_KEY = "AI blend needs an OpenAI API key. Add OPENAI_API_KEY to the .env file in the Woodchuck folder, then restart Woodchuck.";

/** The label's text size and its distance from the corner, as shares of the picture's width. */
export const LABEL_FONT_SHARE = 0.024;
export const LABEL_MARGIN_SHARE = 0.02;
const LABEL_MIN_FONT_PX = 14;

export interface Label {
  text: string;
  /** The text's height, in pixels of the picture it goes on. */
  fontPx: number;
  /** Space between the text and the edge of its box. */
  padPx: number;
  /** The top left of the box, measured from the picture's top left corner. */
  x: number;
  y: number;
}

/** The label a saved picture of this kind carries, if any. Blends get one and true-scale pictures never do. */
export function labelFor(kind: PictureKind, width: number): Label | null {
  if (kind !== "blend") return null;
  const fontPx = Math.max(LABEL_MIN_FONT_PX, Math.round(width * LABEL_FONT_SHARE));
  const margin = Math.round(width * LABEL_MARGIN_SHARE);
  return { text: BLEND_LABEL, fontPx, padPx: Math.round(fontPx * 0.45), x: margin, y: margin };
}

const load = async (src: string) => {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
};

const canvas = (w: number, h: number) => {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
};

const base64 = (c: HTMLCanvasElement) => {
  const url = c.toDataURL("image/png");
  return url.slice(url.indexOf(",") + 1);
};

/**
 * Where the model and its shadow are, grown by `grow` pixels so contact
 * shadows can change, then softened by `soften` pixels. It grows by
 * stamping the shape around a ring, which follows the outline: the gaps
 * between posts and shelves stay closed, so the wall behind isn't redrawn.
 */
function region(model: HTMLImageElement, w: number, h: number, grow: number, soften: number): HTMLCanvasElement {
  // The shape itself: anything the render drew, the shadow included.
  const shape = canvas(w, h);
  const sg = shape.getContext("2d")!;
  sg.drawImage(model, 0, 0, w, h);
  const px = sg.getImageData(0, 0, w, h);
  for (let i = 0; i < px.data.length; i += 4) {
    const on = px.data[i + 3]! > 8;
    px.data[i] = px.data[i + 1] = px.data[i + 2] = 0;
    px.data[i + 3] = on ? 255 : 0;
  }
  sg.putImageData(px, 0, 0);
  const grown = canvas(w, h);
  const gg = grown.getContext("2d")!;
  gg.drawImage(shape, 0, 0);
  for (const r of [grow / 3, (grow * 2) / 3, grow]) {
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      gg.drawImage(shape, Math.round(Math.cos(a) * r), Math.round(Math.sin(a) * r));
    }
  }
  if (soften <= 0) return grown;
  const soft = canvas(w, h);
  const og = soft.getContext("2d")!;
  og.filter = `blur(${soften}px)`;
  og.drawImage(grown, 0, 0);
  return soft;
}

/** The padded picture and its mask, ready to send. */
export async function blendInputs(photoUrl: string, modelPng: string): Promise<{ fit: Fit; image: string; mask: string }> {
  const [photo, model] = await Promise.all([load(photoUrl), load(modelPng)]);
  const fit = fitFor(photo.naturalWidth, photo.naturalHeight);
  const img = canvas(fit.width, fit.height);
  const g = img.getContext("2d")!;
  g.fillStyle = "#808080";
  g.fillRect(0, 0, fit.width, fit.height);
  g.drawImage(photo, fit.x, fit.y, fit.w, fit.h);
  g.drawImage(model, fit.x, fit.y, fit.w, fit.h);
  // The mask: opaque keeps a pixel; fully transparent lets the model change it.
  const open = region(model, fit.w, fit.h, Math.max(4, Math.round(fit.w * 0.008)), 0);
  const mask = canvas(fit.width, fit.height);
  const m = mask.getContext("2d")!;
  m.fillStyle = "#ffffff";
  m.fillRect(0, 0, fit.width, fit.height);
  m.globalCompositeOperation = "destination-out";
  m.drawImage(open, fit.x, fit.y);
  return { fit, image: base64(img), mask: base64(mask) };
}

/** The blended picture cropped back and pasted into the photo at its own size. Returns a PNG data URL. */
export async function pasteBack(photoUrl: string, modelPng: string, resultUrl: string, fit: Fit): Promise<string> {
  const [photo, model, result] = await Promise.all([load(photoUrl), load(modelPng), load(resultUrl)]);
  const W = photo.naturalWidth;
  const H = photo.naturalHeight;
  // The result scaled to the photo, through a feathered copy of the open region.
  const sx = result.naturalWidth / fit.width;
  const sy = result.naturalHeight / fit.height;
  const part = canvas(W, H);
  const pg = part.getContext("2d")!;
  pg.drawImage(result, fit.x * sx, fit.y * sy, fit.w * sx, fit.h * sy, 0, 0, W, H);
  pg.globalCompositeOperation = "destination-in";
  pg.drawImage(region(model, W, H, Math.max(4, Math.round(W * 0.008)), Math.max(2, Math.round(W * 0.003))), 0, 0);
  const out = canvas(W, H);
  const og = out.getContext("2d")!;
  og.drawImage(photo, 0, 0);
  og.drawImage(part, 0, 0);
  return out.toDataURL("image/png");
}

/**
 * The picture with its label drawn in the top left corner, when its kind
 * calls for one. Every picture that gets saved goes through here, so a
 * saved blend can't leave without the words. Returns a PNG data URL, or the
 * picture itself when it needs no label.
 */
export async function withLabel(pictureUrl: string, kind: PictureKind): Promise<string> {
  const img = await load(pictureUrl);
  const label = labelFor(kind, img.naturalWidth);
  if (!label) return pictureUrl;
  const out = canvas(img.naturalWidth, img.naturalHeight);
  const g = out.getContext("2d")!;
  g.drawImage(img, 0, 0);
  g.font = `600 ${label.fontPx}px -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif`;
  g.textBaseline = "middle";
  const w = Math.ceil(g.measureText(label.text).width) + label.padPx * 2;
  const h = label.fontPx + label.padPx * 2;
  g.fillStyle = "rgba(43, 36, 29, 0.9)";
  g.beginPath();
  g.roundRect(label.x, label.y, w, h, label.padPx);
  g.fill();
  g.fillStyle = "#ffffff";
  g.fillText(label.text, label.x + label.padPx, label.y + h / 2);
  return out.toDataURL("image/png");
}
