// Issue #96: the workshop drawings leave each part sheet's machining notes
// off unless the woodworker ticks With notes beside the download.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DrawingsLink, drawingsUrl } from "../src/components/Panels.js";

const html = (notes: boolean) =>
  renderToStaticMarkup(createElement(DrawingsLink, { slug: "hall-table", paper: "A4", onPaper: () => undefined, notes, onNotes: () => undefined, onSaved: () => undefined }));

describe("the drawings download", () => {
  it("leaves the notes off unless asked", () => {
    expect(drawingsUrl("A4")).toBe("/api/drawings.pdf?paper=A4");
    expect(drawingsUrl("A3", true)).toBe("/api/drawings.pdf?paper=A3&notes=1");
  });

  it("offers a With notes tick, and links to the drawings with them when it's ticked", () => {
    expect(html(false)).toContain('href="/api/drawings.pdf?paper=A4"');
    expect(html(false)).toMatch(/<input type="checkbox"\/>With notes/);
    expect(html(true)).toContain('href="/api/drawings.pdf?paper=A4&amp;notes=1"');
    expect(html(true)).toMatch(/<input type="checkbox" checked=""\/>With notes/);
  });
});
