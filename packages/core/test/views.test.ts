// The 2D views are drawn on a sheet whose colours the app can choose.

import { describe, expect, it } from "vitest";
import {
  applyOps,
  derive,
  emptyDesign,
  paperFromParams,
  paperParams,
  renderPartPreview,
  renderSheet,
  renderView,
  WHITE_PAPER,
  type Design,
  type Op,
} from "../src/index.js";

const ops: Op[] = [
  { op: "define_material", id: "ply18", name: "18 mm ply", kind: "sheet", thickness_mm: 18, grained: true, sheet_sizes_mm: [[2440, 1220]] },
  {
    op: "add_panel",
    id: "left",
    name: "Left",
    material: "ply18",
    thickness_axis: "x",
    grain_axis: "y",
    x: { start: { at: "0" } },
    y: { start: { at: "0" }, size: "600" },
    z: { start: { at: "0" }, size: "300" },
  },
  {
    op: "add_panel",
    id: "right",
    name: "Right",
    material: "ply18",
    thickness_axis: "x",
    grain_axis: "y",
    x: { start: { at: "500" } },
    y: { start: { at: "0" }, size: "600" },
    z: { start: { at: "0" }, size: "300" },
  },
];
const design = (): Design => applyOps(emptyDesign("t"), ops);

const DARK = { background: "#18181b", rule: "#27272a", ink: "#f4f4f5", mid: "#a1a1aa", edge: "#a1a1aa", label: "#f4f4f5" };

describe("the paper a view is drawn on", () => {
  it("is white with dark ink unless asked otherwise", () => {
    const svg = renderView("front", derive(design())).svg;
    expect(svg).toContain(`<rect width="640" height="480" fill="#ffffff"/>`);
    expect(svg).toContain(`font-weight="bold" fill="#333333">Front`);
    expect(svg).toContain('stroke="#555555"');
    expect(svg).not.toContain("#18181b");
    expect(renderSheet(["front"], derive(design())).svg).toContain('fill="#ffffff" stroke="#dddddd"');
  });

  it("takes the colours of a dark theme for the sheet, the title and the sizes", () => {
    const svg = renderView("front", derive(design()), { paper: DARK }).svg;
    expect(svg).toContain(`<rect width="640" height="480" fill="#18181b"/>`);
    expect(svg).toContain(`font-weight="bold" fill="#f4f4f5">Front`);
    // The size lines and their figures.
    expect(svg).toContain('stroke="#a1a1aa"');
    expect(svg).toContain('font-size="11" fill="#f4f4f5"');
    expect(svg).not.toContain('fill="#ffffff"');
    expect(svg).not.toContain('fill="#333333"');
  });

  it("keeps the timber's own colours on a dark sheet", () => {
    const light = renderView("iso", derive(design())).svg;
    const dark = renderView("iso", derive(design()), { paper: DARK }).svg;
    const fills = (svg: string) => [...svg.matchAll(/<polygon[^>]*fill="(#[0-9a-f]{6})"/g)].map((m) => m[1]);
    expect(fills(dark)).toEqual(fills(light));
    expect(fills(dark).length).toBeGreaterThan(0);
  });

  it("outlines a see-through part, and names it, in the sheet's ink, since there's no fill to show it", () => {
    const d = derive(design());
    const light = renderView("front", d, { xray: true }).svg;
    const dark = renderView("front", d, { xray: true, paper: DARK }).svg;
    // On white paper the outline and the name are the dark browns they always were.
    expect(light).toContain('stroke="#3b2f25"');
    expect(light).toContain('fill="#1d1712" stroke="#ffffff"');
    // On a dark sheet they turn light, with the sheet's colour as the halo.
    expect(dark).not.toContain('stroke="#3b2f25"');
    expect(dark).toContain('stroke="#a1a1aa" stroke-width="0.8"');
    expect(dark).toContain('fill="#f4f4f5" stroke="#18181b"');
  });

  it("draws a sheet of views, and a part's preview, on the paper too", () => {
    const sheet = renderSheet(["front", "top"], derive(design()), { paper: DARK }).svg;
    expect(sheet).toContain('fill="#18181b" stroke="#27272a"');
    expect(sheet).not.toContain('stroke="#dddddd"');
    const part = { id: "slide", name: "Slide", kind: "drawer_slide", shape: [{ name: "body", min_mm: [0, 0, 0] as [number, number, number], max_mm: [450, 12, 45] as [number, number, number] }] };
    expect(renderPartPreview(part)).toContain('fill="#ffffff" stroke="#dddddd"');
    expect(renderPartPreview(part, 360, 220, DARK)).toContain('fill="#18181b" stroke="#27272a"');
  });

  it("draws only colours it can trust, since they go straight into the picture", () => {
    const bad = { background: 'red" onload="alert(1)', rule: "#12345", ink: "url(#x)", mid: "#ggg000", edge: "", label: undefined as unknown as string };
    const svg = renderView("front", derive(design()), { paper: bad, xray: true }).svg;
    expect(svg).not.toContain("onload");
    expect(svg).not.toContain("url(#x)");
    expect(svg).not.toContain("red");
    expect(svg).toContain(`<rect width="640" height="480" fill="${WHITE_PAPER.background}"/>`);
    // The same picture as no paper at all.
    expect(svg).toBe(renderView("front", derive(design()), { xray: true }).svg);
  });

  it("travels in the address as plain hex, and anything else is dropped on the way back", () => {
    const query = paperParams(DARK);
    expect(query).toBe("paper-background=18181b&paper-rule=27272a&paper-ink=f4f4f5&paper-mid=a1a1aa&paper-edge=a1a1aa&paper-label=f4f4f5");
    expect(paperFromParams(new URLSearchParams(query))).toEqual(DARK);
    expect(paperFromParams(new URLSearchParams("paper-background=red&paper-ink=%23f4f4f5&paper-mid=a1a1aa%22%3E&paper-rule=ABCDEF"))).toEqual({ rule: "#ABCDEF" });
    expect(paperParams({ background: "nope", ink: "#F4F4F5" })).toBe("paper-ink=f4f4f5");
    expect(paperFromParams(new URLSearchParams(""))).toEqual({});
  });
});
