// The pictures of a part its cuts shape: the plan views and the workshop
// drawings draw its true outline with its holes open, and a design with no
// cuts draws exactly as it did before. The tray and the panel are invented,
// and so is every size.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  applyOps,
  derive,
  emptyDesign,
  jointExample,
  JOINT_TYPES,
  outlineOnBlank,
  partFaces,
  recordConsoleOps,
  renderSheet,
  renderView,
  sheetSvg,
  shapeSig,
  solidOf,
  VIEW_NAMES,
  workshopDrawings,
  type Design,
  type JointType,
  type Mark,
  type Op,
  type Sheet,
} from "../src/index.js";

/** A tray whose sides slope from a tall back to a low front, and a panel with a round hole, a slot and a notch at its foot. */
const trayOps = (): Op[] => [
  { op: "define_material", id: "ply15", name: "15 mm birch ply", kind: "sheet", thickness_mm: 15, grained: true },
  { op: "set_param", name: "depth", expr: "380", unit: "mm" },
  { op: "set_param", name: "back_h", expr: "150", unit: "mm" },
  { op: "set_param", name: "front_h", expr: "80", unit: "mm" },
  ...(["side_l", "side_r"] as const).map(
    (id): Op => ({
      op: "add_panel",
      id,
      name: id === "side_l" ? "Tray side, left" : "Tray side, right",
      material: "ply15",
      thickness_axis: "x",
      grain_axis: "z",
      x: id === "side_l" ? { start: { at: "0" } } : { end: { at: "330" } },
      y: { start: { at: "0" }, size: "back_h" },
      z: { start: { at: "0" }, size: "depth" },
    }),
  ),
  {
    op: "add_panel",
    id: "back",
    name: "Tray back",
    material: "ply15",
    thickness_axis: "z",
    grain_axis: "x",
    x: { start: { face: "side_l.right" }, end: { face: "side_r.left" } },
    y: { start: { at: "0" }, size: "back_h" },
    z: { start: { face: "side_l.back" } },
  },
  {
    op: "add_panel",
    id: "front",
    name: "Tray front",
    material: "ply15",
    thickness_axis: "z",
    grain_axis: "x",
    x: { start: { face: "side_l.right" }, end: { face: "side_r.left" } },
    y: { start: { at: "0" }, size: "front_h" },
    z: { end: { face: "side_l.front" } },
  },
  // The back's dado sits in each side's inner face. The right side's is on its lower face, so its drawing turns it over.
  { op: "add_joint", id: "back_l", type: "dado", host: "side_l", guest: "back", depth: "5" },
  { op: "add_joint", id: "back_r", type: "dado", host: "side_r", guest: "back", depth: "5" },
  { op: "set_edge_cut", id: "side_l", cut: "slope", edge: "top", start: { face: "back.top" }, end: { face: "front.top" } },
  { op: "set_edge_cut", id: "side_r", cut: "slope", edge: "top", start: { face: "back.top" }, end: { face: "front.top" } },
  {
    op: "add_panel",
    id: "panel",
    name: "Divider panel",
    material: "ply15",
    thickness_axis: "z",
    grain_axis: "y",
    x: { start: { at: "400" }, size: "360" },
    y: { start: { at: "0" }, size: "420" },
    z: { start: { at: "100" } },
  },
  { op: "set_cutout", id: "panel", cut: "cable", shape: "circle", centre: { x: { at: "490" }, y: { at: "320" } }, diameter: "40" },
  { op: "set_cutout", id: "panel", cut: "slot", shape: "rect", x: { start: { at: "560" }, size: "140" }, y: { start: { at: "300" }, size: "36" }, radius: "18" },
  { op: "set_cutout", id: "panel", cut: "kick", shape: "rect", x: { start: { at: "390" }, size: "80" }, y: { start: { at: "-10" }, size: "60" } },
];

const tray = (): Design => applyOps(emptyDesign("Shaped tray"), trayOps());
const sha = (v: unknown) => createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex");

describe("a shaped part's solid", () => {
  const d = derive(tray());

  it("is its outline carried through its thickness, where its box would be", () => {
    const side = solidOf(d.byId.get("side_l")!)!;
    expect(side.t_mm).toEqual([0, 15]);
    expect(side.caps.map((c) => c.face)).toEqual(["left", "right"]);
    expect(side.caps[1].loops[0]).toEqual([
      [15, 0, 0],
      [15, 150, 0],
      [15, 80, 380],
      [15, 0, 380],
    ]);
    // Each wall counts as the face its edge does, so the slope is the top.
    expect(side.walls.map((w) => w.face)).toEqual(["back", "top", "front", "bottom"]);
    const top = side.walls[1]!;
    expect(top.normal[1]).toBeGreaterThan(0.98);
    expect(top.normal[2]).toBeCloseTo(70 / Math.hypot(70, 380), 9);
  });

  it("gives a hole's walls the faces they look towards", () => {
    const panel = solidOf(d.byId.get("panel")!)!;
    expect(panel.loops).toHaveLength(3);
    const slot = panel.faces[2]!;
    expect(new Set(slot)).toEqual(new Set(["left", "right", "bottom", "top"]));
  });

  it("has no solid and no shape key without cuts", () => {
    const back = d.byId.get("back")!;
    expect(solidOf(back)).toBeNull();
    expect(shapeSig(back)).toBe("");
    expect(shapeSig(d.byId.get("panel")!)).not.toBe("");
  });

  it("lays its outline on the blank along its length, for the cutting layout", () => {
    const on = outlineOnBlank(d.byId.get("side_l")!)!;
    expect(on.outline).toEqual([
      [0, 0],
      [0, 150],
      [380, 80],
      [380, 0],
    ]);
    expect(outlineOnBlank(d.byId.get("panel")!)!.holes).toHaveLength(2);
  });
});

describe("the plan views of a shaped part", () => {
  const d = derive(tray());
  const ys = (fs: ReturnType<typeof partFaces>) => fs.flatMap((f) => f.pts.map((p) => p[1]));

  it("show a sloped side's true outline from the side", () => {
    const faces = partFaces("left", d.byId.get("side_l")!);
    expect(faces).toHaveLength(1);
    expect(faces[0]!.pts).toEqual([
      [0, -0],
      [0, -150],
      [380, -80],
      [380, -0],
    ]);
  });

  it("show the slope rising behind the front end from the front, up to the back's height", () => {
    const faces = partFaces("front", d.byId.get("side_l")!);
    expect(faces).toHaveLength(2);
    expect(Math.min(...ys(faces))).toBe(-150);
    // The front end stops at the front's height, and the slope carries on above it.
    expect(faces.some((f) => Math.min(...f.pts.map((p) => p[1])) === -80)).toBe(true);
  });

  it("leave a panel's holes open, drawn by the even-odd rule", () => {
    const faces = partFaces("front", d.byId.get("panel")!);
    expect(faces).toHaveLength(1);
    expect(faces[0]!.holes).toHaveLength(2);
    const svg = renderView("front", d).svg;
    const path = /<path d="([^"]+)" fill-rule="evenodd"/.exec(svg);
    expect(path).not.toBeNull();
    expect(path![1]!.match(/M/g)).toHaveLength(3);
  });

  it("draw the walls seen through a hole before the face with the hole in it", () => {
    const faces = partFaces("iso", d.byId.get("panel")!);
    expect(faces.at(-1)!.holes).toHaveLength(2);
    expect(faces.length).toBeGreaterThan(10);
  });

  it("leave out walls hidden behind wood when looking along the face", () => {
    // From the left, the outer edge hides the holes' walls, and the notch's wall shows below it.
    const faces = partFaces("left", d.byId.get("panel")!);
    expect(faces).toHaveLength(2);
    expect(faces.map((f) => Math.max(...f.pts.map((p) => -p[1]))).sort((a, b) => a - b)).toEqual([50, 420]);
  });
});

const shapes = (s: Sheet) => s.marks.filter((m): m is Extract<Mark, { kind: "shape" }> => m.kind === "shape");
const texts = (s: Sheet) => s.marks.flatMap((m) => (m.kind === "text" ? [m.text] : []));

describe("the workshop drawings of a shaped part", () => {
  const design = tray();
  const d = derive(design);
  const sheets = workshopDrawings(design, d, { date: "5 October 2026" });
  const sheet = (name: string) => sheets.find((s) => s.kind === "part" && s.title.endsWith(name))!;

  it("size a slope's angle and the height left at the right end", () => {
    const side = sheet("Tray side, left");
    expect(side.dims).toContainEqual({ view: "face", along: "top edge", kind: "angle", values_mm: [380, 70], angle_deg: 10.4 });
    expect(side.dims).toContainEqual({ view: "face", along: "right end", kind: "chain", values_mm: [80, 70] });
    expect(texts(side)).toContain("10.4°");
    expect(texts(side)).toContain("Top edge cut on a slope from 0 along, 150 up to 380 along, 80 up, 10.4°.");
    expect(texts(side)).toContain("Machining and shape");
  });

  it("turn the slope over with the part when its work is on the far face", () => {
    const side = sheet("Tray side, right");
    expect(side.dims).toContainEqual({ view: "face", along: "bottom edge", kind: "angle", values_mm: [380, 70], angle_deg: 10.4 });
    expect(side.dims).toContainEqual({ view: "face", along: "right end", kind: "chain", values_mm: [70, 80] });
    expect(texts(side)).toContain("Bottom edge cut on a slope from 0 along, 0 up to 380 along, 70 up, 10.4°.");
    // On the face view the full-length edge is now at the top, and the slope drops to the left end's corner.
    const face = shapes(side).find((m) => m.points_mm.length === 4 && m.stroke_mm === 0.35 && new Set(m.points_mm.map((p) => p[1])).size === 3)!;
    const lowest = Math.max(...face.points_mm.map((p) => p[1]));
    const left = Math.min(...face.points_mm.map((p) => p[0]));
    expect(face.points_mm.filter((p) => p[1] === lowest)).toEqual([[left, lowest]]);
  });

  it("draw a panel's holes open, and size and place each one", () => {
    const panel = sheet("Divider panel");
    const face = shapes(panel).find((m) => m.holes_mm)!;
    expect(face.holes_mm).toHaveLength(2);
    expect(panel.dims).toContainEqual({ view: "face", along: "length", kind: "chain", values_mm: [50, 250, 20, 16, 84] });
    expect(panel.dims).toContainEqual({ view: "face", along: "width", kind: "chain", values_mm: [70, 290] });
    expect(panel.dims).toContainEqual({ view: "face", along: "right end", kind: "chain", values_mm: [90, 70, 140, 60] });
    expect(texts(panel)).toEqual(
      expect.arrayContaining([
        "Shape",
        "Ø40 hole right through, centre 320 along, 90 up.",
        "36 × 140 cutout right through, corners rounded to 18, from 300 along, 160 up.",
      ]),
    );
    expect(sheetSvg(panel)).toMatch(/<path d="M[^"]+ZM[^"]+ZM[^"]+Z" fill-rule="evenodd" fill="#ffffff"/);
  });

  it("draw the true shapes on the general arrangement", () => {
    const front = shapes(sheets[0]!).filter((m) => m.holes_mm);
    expect(front).toHaveLength(1);
    expect(front[0]!.holes_mm).toHaveLength(2);
  });
});

// Digests of what main drew for every example before shapes were drawn:
// [the plan views, the workshop drawings]. A change that means to alter
// these drawings updates them in the same pull request. The drawings
// gained the cutting plan and the cut list's Board column with #78.
const BEFORE_SHAPES: Record<string, [string, string]> = {
  "record console": ["c2e8d75fb9314e713793e0cc55aad873c40d7bcd1cc967784caf48a8efefffed", "d91649569547be0db5ebc74dffd45bcb13fd7163a514200f16ff39de2fd2c0bd"],
  butt: ["7247cd9ea1ca5482186c13ba2922a186ed4b2fb8b483748ea28cd347965d83b0", "481923743716d9161ebe74124aea46ee2581cc20bacfc0c54b796ca66879d93e"],
  screws: ["80c80001aeb814d1522da28ab2a6f58e1810c3ea5a3f9dceb6184aaa2067e5bf", "8d867388cd7042c45c6fcc592a80bdc6c3043994d2001d16172f03daae395a4b"],
  pocket_screws: ["579504124c9069ea76bce798f33c7192bbd38abad4673dd8ae8dd4a2f860309b", "78d5232fb017135c497da4affb26d26e759f91936bec5d94edb15eba75c0bc93"],
  dowels: ["0c0a4b4f4380a39ccb0d1ba2415ecbebd90393c8b99710c345159e1fde911fba", "a074d016e418fad2b320e27eadb9f38127c632fcbdf32c1552b1052df64ed0fa"],
  // Added with the joint, after shapes were drawn.
  domino: ["d59610663fe3851968f0ff479095ac27c2567d7b7d89fdd7ceb339b3e8e274e2", "281a7811b2ba03cec4b31064cdb057f33c60f7101c3aeef6e814f88ba1cbec68"],
  dado: ["68d3800fbe2b97ccd10fa5144e851a6f9a799b760a3f5027cf81869fd55af310", "03a4334bf60102fe7b845973938f929de6d12d5ca7e774e67fdea8a47a51f8f2"],
  groove: ["5f4bbabe437e152dbd4b6fe2ad2854ac202ab14231be19a2bf57dc4e97d773ec", "506ae9694bcc53a0c691a4d7a06c8ce880f4337af15b8301e2cb437c2a07d6a9"],
  rabbet: ["8166246aaa16084cfd00e3aa7010ec809511d0d5ba1224800eeb4571e130e593", "2634740e5da00f7c6af73963cb05156da4ff4c32409c9afa45c52c8e758be4ae"],
  tongue: ["b21ea74097ee2200876f66074e78786ef80440a202aeacd27bda7c44b5543054", "b730d9db71cdff590ec9cba32265ef5e3e7083be482cd7d494325a7c7a1b74b5"],
  // Added with the joint, after shapes were drawn.
  dado_rabbet: ["94dde0ba7aebd3eb1c63ae186c10183b72e6e8fd61dec69978c736fd73c6d595", "445fcc28f83f65d645cf8172f52c0f11c548dc98a420e76a23d009132deb3da5"],
  mortise_tenon: ["6db2fca2304fd851370cedb9f100cfda9f1d4ed0e588259609cd951a83408a77", "3fc9156c640d4315a8d700fd102373b58832e70eaa3507b4d089b800b8635b6c"],
  half_lap: ["a5d3209d053cd81ff12af550185b21751a687d67f5a739f79d5ae256eed3d388", "da56e6a4ef021e23ab418d80ca3e71117faf1dbdcabb15032cfbb5e5be20c9ba"],
  box_joint: ["fec73086083b6fa9e781d5588388d310c88ab815d9e5e4ddf4586fdbd464ee34", "a5fbed5144a9c3051c1f2de21219ce775396d003aa96d0f9a6af632df491c9fe"],
  through_slot: ["c76c7ef6bbb6a76a811e341b39cf52ac606bf7d67e16c5286afa0a490c77b536", "074789a7266f213a9f3a58e77c0f686c8b5d081222c96bead926bf10db403449"],
};

describe("designs with no cuts", () => {
  it("cover every example", () => {
    expect(Object.keys(BEFORE_SHAPES)).toEqual(["record console", ...JOINT_TYPES]);
  });

  it.each(Object.keys(BEFORE_SHAPES))("draw the %s example exactly as before shapes were drawn", (name) => {
    const design = name === "record console" ? applyOps(emptyDesign("test"), recordConsoleOps()) : jointExample(name as JointType);
    const d = derive(design);
    const views = [
      ...VIEW_NAMES.map((v) => renderView(v, d).svg),
      ...VIEW_NAMES.map((v) => renderView(v, d, { xray: true }).svg),
      renderSheet(["front", "top", "left", "iso"], d, { labels: true }).svg,
      renderSheet(["front", "top", "left", "iso"], d, { labels: true, xray: true, highlight: [d.parts[0]!.id] }).svg,
    ];
    const sheets = workshopDrawings(design, d, { date: "5 October 2026" });
    expect([sha(views), sha([JSON.stringify(sheets), ...sheets.map(sheetSvg)])]).toEqual(BEFORE_SHAPES[name]);
  });
});
