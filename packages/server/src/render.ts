// Turns the SVG views into PNGs, which is what Claude can look at.

import { Resvg } from "@resvg/resvg-js";
import { derive, renderSheet, type Design, type ViewName } from "@woodchuck/core";

export function renderPng(design: Design, views: ViewName[], opts: { highlight?: string[]; isolate?: string[]; xray?: boolean } = {}): Buffer {
  const sheet = renderSheet(views, derive(design), { labels: true, ...opts });
  const png = new Resvg(sheet.svg, { font: { loadSystemFonts: true, defaultFontFamily: "Helvetica" } }).render().asPng();
  return Buffer.from(png);
}
