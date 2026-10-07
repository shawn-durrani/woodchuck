// What the window shows, for another chat that asks to see it: the
// pictures it sends and the words that go with them. The words are worked
// out here, free of the page, so the tests can hold them.

/** A picture the window sends, at most 1568 px on its longer side, as a model reads best. */
export interface Shot {
  media_type: "image/jpeg";
  data: string;
}

/** The longest side a picture for a model needs. */
export const SHOT_SIDE = 1568;

/** What the window is showing, as the words with a screenshot say it. */
export interface WindowView {
  design: string;
  /** The 3D model, or one of the plan views by name. */
  mode: "3d" | "2d";
  view: string;
  planView: string;
  look: "plain" | "finished";
  seeThrough: boolean;
  /** From 0, together, to 1, fully apart, or null when Explode is off. */
  explode: number | null;
  /** A joint pulled apart on its own, by id. */
  joint: string | null;
  /** A joint's section and sizes, open beside the model. */
  section: string | null;
  picked: string[];
  inPhoto: boolean;
  /** The room photo is in the picture too. */
  withPhoto: boolean;
}

/** Says what a screenshot shows, so the model that reads it knows what it's looking at. */
export function describeWindow(w: WindowView): string {
  if (w.mode === "2d") return `The ${w.design} window shows the ${w.planView} plan view, a 2D drawing with its sizes${w.seeThrough ? ", see-through" : ""}.`;
  const bits = [`the 3D model in the ${w.look === "finished" ? "Finished" : "Plain"} look, from the woodworker's own camera angle, starting from the ${w.view} view`];
  if (w.joint) bits.push(`joint ${w.joint} pulled apart on its own, with the rest faded`);
  else if (w.explode !== null) bits.push(w.explode >= 1 ? "the piece pulled apart" : w.explode <= 0 ? "the piece together, with Explode on" : "the piece partly pulled apart");
  if (w.seeThrough) bits.push("see-through on");
  if (w.picked.length) bits.push(`${w.picked.length > 3 ? `${w.picked.slice(0, 3).join(", ")} and ${w.picked.length - 3} more` : w.picked.join(", ")} picked`);
  if (w.inPhoto) bits.push(w.withPhoto ? "placed in the room photo" : "placed in the room photo, which is left out of the picture");
  const said = bits.length > 1 ? `${bits.slice(0, -1).join(", ")} and ${bits.at(-1)}` : bits[0];
  const section = w.section ? ` The second picture is joint ${w.section} cut through, with its sizes, as the drawer beside the model shows it.` : "";
  return `The ${w.design} window shows ${said}.${section}`;
}

/** Draws an image onto a canvas no bigger than the longest side a model needs, on white, and returns it as JPEG. */
export function toShot(img: CanvasImageSource, width: number, height: number): Shot | null {
  const scale = Math.min(1, SHOT_SIDE / Math.max(width, height, 1));
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(width * scale));
  out.height = Math.max(1, Math.round(height * scale));
  const g = out.getContext("2d");
  if (!g) return null;
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, out.width, out.height);
  g.drawImage(img, 0, 0, out.width, out.height);
  const url = out.toDataURL("image/jpeg", 0.85);
  return { media_type: "image/jpeg", data: url.slice(url.indexOf(",") + 1) };
}

/** Loads an image from a URL or SVG markup, ready to draw. */
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("The picture didn't load"));
    img.src = src.startsWith("<") ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(src)}` : src;
  });
}
