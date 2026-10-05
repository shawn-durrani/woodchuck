// Issue #42: the views Claude looks at can show the finished look. Each face
// takes its timber's average colour with its finish on it, by the same
// arithmetic as the colour cards, so Claude can check colours before it says
// they're on. The plain look stays as it was, byte for byte, which the
// digests in pictures.test.ts hold. The bedside cabinet and the shaped panel
// are invented, and so is every size.

import { describe, expect, it } from "vitest";
import {
  applyOps,
  derive,
  emptyDesign,
  finishedColour,
  recordConsoleOps,
  renderSheet,
  renderView,
  type Design,
  type Op,
  type ViewName,
} from "../src/index.js";

const OAK = "tasmanian_oak";
const BIRCH = "birch_ply";
const AMSTERDAM = "satin_wood_oil/amsterdam";
const NATUR = "satin_wood_oil/natur";
const WHITE = "osmo_polyx/white_3040";

/** A bedside cabinet: oak sides, top and door, and a birch ply back. */
const cabinetOps = (): Op[] => [
  { op: "define_material", id: "oak19", name: "19 mm oak board", kind: "solid", thickness_mm: 19, grained: true, species: OAK },
  { op: "define_material", id: "ply12", name: "12 mm birch ply", kind: "sheet", thickness_mm: 12, grained: true },
  ...(["side_l", "side_r"] as const).map(
    (id): Op => ({
      op: "add_panel",
      id,
      name: id === "side_l" ? "Left side" : "Right side",
      material: "oak19",
      thickness_axis: "x",
      grain_axis: "y",
      x: id === "side_l" ? { start: { at: "0" } } : { end: { at: "450" } },
      y: { start: { at: "0" }, size: "500" },
      z: { start: { at: "0" }, size: "350" },
    }),
  ),
  {
    op: "add_panel",
    id: "top",
    name: "Top",
    material: "oak19",
    thickness_axis: "y",
    grain_axis: "x",
    x: { start: { at: "0" }, end: { at: "450" } },
    y: { start: { face: "side_l.top" } },
    z: { start: { at: "0" }, size: "350" },
  },
  {
    op: "add_panel",
    id: "back",
    name: "Back",
    material: "ply12",
    thickness_axis: "z",
    grain_axis: "x",
    x: { start: { face: "side_l.right" }, end: { face: "side_r.left" } },
    y: { start: { at: "0" }, size: "500" },
    z: { start: { at: "0" } },
  },
  {
    op: "add_panel",
    id: "door",
    name: "Door",
    material: "oak19",
    thickness_axis: "z",
    grain_axis: "y",
    x: { start: { face: "side_l.left" }, end: { face: "side_r.right" } },
    y: { start: { at: "0" }, size: "500" },
    z: { start: { face: "side_l.front" } },
  },
  // The oak in a dark oil, the top and the door in clear oil, and the door's front in a whitewash.
  { op: "set_finish", targets: ["material:oak19"], finish: "amsterdam" },
  { op: "set_finish", targets: ["top", "door"], finish: "natur" },
  { op: "set_finish", targets: ["door.front"], finish: "white_3040" },
];

const cabinet = (): Design => applyOps(emptyDesign("Bedside cabinet"), cabinetOps());

/** Every face's fill in a drawing, in the order it's painted. */
const fills = (svg: string) => [...svg.matchAll(/<(?:polygon|path) [^>]*?fill="([^"]+)"/g)].map((m) => m[1]!);

/** One part alone from one side, in the finished look. */
const seen = (design: Design, view: ViewName, id: string) => fills(renderView(view, derive(design), { finished: design, isolate: [id] }).svg);

/** A colour in the light a face catches, as the plain look shades its faces. */
const lit = (hex: string, f: number) =>
  `#${[1, 3, 5].map((i) => Math.max(0, Math.min(255, Math.round(parseInt(hex.slice(i, i + 2), 16) * f))).toString(16).padStart(2, "0")).join("")}`;

describe("the finished look", () => {
  it("gives a part its material's finish", () => {
    expect(seen(cabinet(), "front", "side_l")).toEqual([finishedColour(OAK, AMSTERDAM)]);
  });

  it("gives a part's own finish over its material's", () => {
    expect(seen(cabinet(), "front", "top")).toEqual([finishedColour(OAK, NATUR)]);
  });

  it("gives a face's own finish over its part's, and the part's to its other faces", () => {
    expect(seen(cabinet(), "front", "door")).toEqual([finishedColour(OAK, WHITE)]);
    // The top catches more light than a front, as in the plain look.
    expect(seen(cabinet(), "top", "door")).toEqual([lit(finishedColour(OAK, NATUR), 1.08)]);
  });

  it("draws unfinished timber bare, in the species its material's name gives away", () => {
    expect(seen(cabinet(), "front", "back")).toEqual([finishedColour(BIRCH, undefined)]);
    // A finish the cards don't know shows bare too, as in the 3D view.
    const unknown = { ...cabinet(), finishes: { ...cabinet().finishes, back: "satin_wood_oil/nope" } };
    expect(seen(unknown, "front", "back")).toEqual([finishedColour(BIRCH, undefined)]);
  });

  it("follows an array's finish to its copies", () => {
    const design = applyOps(emptyDesign("t"), [
      ...recordConsoleOps(),
      { op: "set_finish", targets: ["material:carcass_30", "material:top_30"], finish: "amsterdam" },
      { op: "set_finish", targets: ["false_front"], finish: "roussillon" },
    ]);
    // The original's id draws it with its four copies.
    expect(seen(design, "front", "false_front")).toEqual(Array(5).fill(finishedColour(BIRCH, "satin_wood_oil/roussillon")));
    expect(seen(design, "front", "false_front#3")).toEqual([finishedColour(BIRCH, "satin_wood_oil/roussillon")]);
    expect(seen(design, "front", "left_side")).toEqual([finishedColour(BIRCH, AMSTERDAM)]);
    expect(seen(design, "front", "drawer_side_l#2")).toEqual([finishedColour(BIRCH, undefined)]);
  });

  it("keeps a stand-in hatched", () => {
    const design = applyOps(cabinet(), [{ op: "add_unverified_box", id: "lamp", name: "Lamp", min_mm: [100, 519, 100], max_mm: [200, 700, 200], reason: "Its base isn't known yet" }]);
    expect(seen(design, "front", "lamp")).toEqual(["url(#unverified)"]);
  });

  it("names the look in each view's title", () => {
    const design = cabinet();
    const svg = renderSheet(["front", "top"], derive(design), { labels: true, finished: design }).svg;
    expect(svg).toContain(">Front, finished</text>");
    expect(svg).toContain(">Top (plan), finished</text>");
  });

  it("leaves the plain look alone whatever the finishes", () => {
    const plain = (design: Design) => renderSheet(["front", "top", "left", "iso"], derive(design), { labels: true }).svg;
    const bare = applyOps(emptyDesign("Bedside cabinet"), cabinetOps().filter((op) => op.op !== "set_finish"));
    expect(plain(cabinet())).toBe(plain(bare));
    expect(plain(cabinet())).not.toContain(finishedColour(OAK, AMSTERDAM));
  });
});

describe("the finished look of a shaped part", () => {
  const ops: Op[] = [
    { op: "define_material", id: "ply15", name: "15 mm birch ply", kind: "sheet", thickness_mm: 15, grained: true },
    {
      op: "add_panel",
      id: "panel",
      name: "Divider panel",
      material: "ply15",
      thickness_axis: "z",
      grain_axis: "y",
      x: { start: { at: "0" }, size: "360" },
      y: { start: { at: "0" }, size: "420" },
      z: { start: { at: "0" } },
    },
    { op: "set_cutout", id: "panel", cut: "cable", shape: "circle", centre: { x: { at: "90" }, y: { at: "320" } }, diameter: "40" },
    { op: "set_cutout", id: "panel", cut: "slot", shape: "rect", x: { start: { at: "160" }, size: "140" }, y: { start: { at: "300" }, size: "36" }, radius: "18" },
    {
      op: "add_panel",
      id: "side",
      name: "Sloped side",
      material: "ply15",
      thickness_axis: "x",
      grain_axis: "z",
      x: { start: { at: "500" } },
      y: { start: { at: "0" }, size: "150" },
      z: { start: { at: "0" }, size: "380" },
    },
    { op: "set_edge_cut", id: "side", cut: "slope", edge: "top", start: { at: "150" }, end: { at: "80" } },
    { op: "set_finish", targets: ["panel"], finish: "ankara" },
    { op: "set_finish", targets: ["side.top"], finish: "tokyo" },
  ];
  const design = applyOps(emptyDesign("Shaped parts"), ops);

  it("keeps its holes open in its finish", () => {
    const svg = renderView("front", derive(design), { finished: design, isolate: ["panel"] }).svg;
    const path = /<path d="([^"]+)" fill-rule="evenodd" fill="([^"]+)"/.exec(svg);
    expect(path).not.toBeNull();
    expect(path![1]!.match(/M/g)).toHaveLength(3);
    expect(path![2]).toBe(finishedColour(BIRCH, "satin_wood_oil/ankara"));
  });

  it("gives a slope its top's finish, and the rest of the part its own", () => {
    // From the front, the slope rises behind the bare front end.
    const faces = seen(design, "front", "side");
    const bare = finishedColour(BIRCH, undefined);
    expect(faces).toHaveLength(2);
    expect(faces.at(-1)).toBe(bare);
    // Tokyo is near black on any timber, in whatever light the slope catches.
    expect(parseInt(faces[0]!.slice(1, 3), 16)).toBeLessThan(40);
  });
});
