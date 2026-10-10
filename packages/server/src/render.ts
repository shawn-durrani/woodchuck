// Turns the SVG views into PNGs, which is what Claude can look at. The plain
// look colours each material flatly. The finished look colours each face
// with its timber and finish, from the same arithmetic as the 3D view's
// Finished look, so Claude can check colours here without a browser.

import { Resvg } from "@resvg/resvg-js";
import { derive, renderSheet, sheetSvg, type Design, type Sheet, type ViewName } from "@woodchuck/core";

export type RenderLook = "plain" | "finished";

export interface RenderOptions {
  highlight?: string[];
  isolate?: string[];
  xray?: boolean;
  /** Plain unless it says finished. */
  look?: RenderLook;
}

/** The sheet of views as SVG, before it's turned into a PNG. */
export function renderSvg(design: Design, views: ViewName[], opts: RenderOptions = {}): string {
  const { look, ...rest } = opts;
  return renderSheet(views, derive(design), { labels: true, ...rest, ...(look === "finished" ? { finished: design } : {}) }).svg;
}

export function renderPng(design: Design, views: ViewName[], opts: RenderOptions = {}): Buffer {
  const png = new Resvg(renderSvg(design, views, opts), { font: { loadSystemFonts: true, defaultFontFamily: "Helvetica" } }).render().asPng();
  return Buffer.from(png);
}

/** One sheet of the workshop drawings as a PNG on white, this many pixels wide, for a chat to look at. */
export function sheetPng(sheet: Sheet, width_px = 1600): Buffer {
  const png = new Resvg(sheetSvg(sheet), { background: "#ffffff", fitTo: { mode: "width", value: width_px }, font: { loadSystemFonts: true, defaultFontFamily: "Helvetica" } }).render().asPng();
  return Buffer.from(png);
}
