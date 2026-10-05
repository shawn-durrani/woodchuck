// Cuts made by hand, in the Shape section of a panel's Edit tab: the cut
// each Add button starts with, the operation a cut's fields make, the
// words and problems each cut shows, what a change would do while it's
// typed, and the small drawing of the part's face. Sam's hall cabinet is
// invented, and so is every size in it.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { applyOps, derive, emptyDesign, type Design, type DerivedPart, type Op, type Panel } from "@woodchuck/core";
import { draftView, previewChange, type PreviewResult } from "../src/ghost.js";
import {
  cutsNamed,
  cutTitle,
  draftNote,
  edgeChoices,
  faceDrawing,
  fieldGroups,
  fieldsOf,
  fieldValue,
  newCut,
  newCutFields,
  opOf,
  problemsFor,
  shapeProblems,
  slopeFields,
  withField,
  type CutFields,
} from "../src/shapeEdit.js";
import { boundText, parseBound } from "../src/bounds.js";
import { CutEditor, SHAPE_WHY, ShapeSection } from "../src/components/ShapeSection.js";
import { CutListPanel } from "../src/components/Panels.js";
import { stateOf } from "./bench.js";

const CABINET: Op[] = [
  { op: "set_param", name: "cab_h", expr: "720", unit: "mm", note: "Cabinet height" },
  { op: "set_param", name: "gap", expr: "4", unit: "mm" },
  { op: "define_material", id: "ply18", name: "18 mm birch ply", kind: "sheet", thickness_mm: 18, grained: true },
  { op: "define_material", id: "ply12", name: "12 mm birch ply", kind: "sheet", thickness_mm: 12, grained: true },
  {
    op: "add_panel",
    id: "side",
    name: "Cabinet side",
    material: "ply18",
    thickness_axis: "x",
    grain_axis: "y",
    x: { start: { at: "0" } },
    y: { start: { at: "0" }, end: { at: "cab_h" } },
    z: { start: { at: "0" }, size: "400" },
  },
  {
    op: "add_panel",
    id: "back",
    name: "Back",
    material: "ply12",
    thickness_axis: "z",
    grain_axis: "y",
    x: { start: { at: "40" }, size: "360" },
    y: { start: { at: "0" }, size: "420" },
    z: { start: { at: "-100" } },
  },
  {
    op: "add_panel",
    id: "shelf",
    name: "Shelf",
    material: "ply18",
    thickness_axis: "y",
    grain_axis: "x",
    x: { start: { at: "600" }, size: "500" },
    y: { start: { at: "300" } },
    z: { start: { at: "0" }, size: "300" },
  },
  {
    op: "add_panel",
    id: "rail",
    name: "Rail",
    material: "ply18",
    thickness_axis: "z",
    grain_axis: "x",
    x: { start: { at: "600" }, size: "500" },
    y: { start: { at: "0" }, size: "40" },
    z: { start: { at: "-100" } },
  },
  {
    op: "add_panel",
    id: "drawer_front",
    name: "Drawer front",
    material: "ply18",
    thickness_axis: "z",
    grain_axis: "x",
    x: { start: { at: "1200" }, size: "300" },
    y: { start: { at: "400" }, size: "100" },
    z: { start: { at: "450" } },
  },
  {
    op: "add_panel",
    id: "drawer_back",
    name: "Drawer back",
    material: "ply12",
    thickness_axis: "z",
    grain_axis: "x",
    x: { start: { at: "1200" }, size: "300" },
    y: { start: { at: "400" }, size: "160" },
    z: { end: { at: "30" } },
  },
  {
    op: "add_panel",
    id: "drawer_side",
    name: "Drawer side",
    material: "ply12",
    thickness_axis: "x",
    grain_axis: "z",
    x: { start: { at: "1200" } },
    y: { start: { at: "400" }, size: "160" },
    z: { start: { face: "drawer_back.front" }, end: { face: "drawer_front.back" } },
  },
];

const cabinet = (more: Op[] = []): Design => applyOps(emptyDesign("Sam's hall cabinet"), [...CABINET, ...more]);
const panelOf = (d: Design, id: string): Panel => d.parts.find((p) => p.id === id)!;
const partOf = (d: Design, id: string): DerivedPart => derive(d).byId.get(id)!;
/** The cut a kind of Add makes on a part, made, and the part with it. */
const added = (d: Design, id: string, kind: Parameters<typeof newCut>[0]) => {
  const made = newCut(kind, panelOf(d, id), partOf(d, id));
  const after = applyOps(d, [made.op]);
  return { ...made, design: after, part: partOf(after, id), panel: panelOf(after, id) };
};
const fits = (r: ReturnType<typeof previewChange>): PreviewResult => {
  if ("error" in r) throw new Error(r.error);
  return r;
};

describe("the edges a slope can take", () => {
  it("offers a panel's four edges and never its broad faces, top first as the drawing shows them", () => {
    const d = cabinet();
    expect(edgeChoices(panelOf(d, "side"))).toEqual(["top", "bottom", "back", "front"]);
    expect(edgeChoices(panelOf(d, "back"))).toEqual(["top", "bottom", "left", "right"]);
    expect(edgeChoices(panelOf(d, "shelf"))).toEqual(["back", "front", "left", "right"]);
  });
});

describe("what each Add button starts with", () => {
  it("slopes a side's top from its full height at the back to two thirds at the front, on its own top", () => {
    const d = cabinet();
    expect(newCutFields("slope", panelOf(d, "side"), partOf(d, "side"))).toEqual({
      kind: "edge",
      edge: "top",
      start: "@side.top",
      end: "@side.top - 240",
      start_along: "",
      end_along: "",
      note: "",
    });
    const r = added(d, "side", "slope");
    expect(r.cut).toBe("slope");
    expect(r.op).toEqual({ op: "set_edge_cut", id: "side", cut: "slope", edge: "top", start: { face: "side.top" }, end: { face: "side.top", offset: "-240" } });
    // The side's grain runs up it, so its top is an end, in the cut list's words.
    expect(r.part.profile!.cuts[0]!.text).toBe("top end sloped from 720 at the back edge to 480 at the front edge, 31°");
  });

  it("slopes a flat part's front instead, since it has no top edge", () => {
    const d = cabinet();
    expect(newCutFields("slope", panelOf(d, "shelf"), partOf(d, "shelf"))).toMatchObject({ edge: "front", start: "@shelf.front", end: "@shelf.front - 100" });
    expect(added(d, "shelf", "slope").part.profile!.cuts[0]!.text).toBe("front edge sloped from 300 at the left end to 200 at the right end, 11.3°");
  });

  it("follows the part when it grows, since its ends sit on the part's own top", () => {
    const d = applyOps(added(cabinet(), "side", "slope").design, [{ op: "set_param", name: "cab_h", expr: "800", unit: "mm" }]);
    const cut = partOf(d, "side").profile!.cuts[0]!;
    expect([cut.start_mm, cut.end_mm]).toEqual([800, 560]);
  });

  it("centres a 35 mm round hole, smaller on a narrow part", () => {
    const d = cabinet();
    const r = added(d, "back", "round");
    expect(r.cut).toBe("hole");
    expect(fieldsOf(r.panel.cuts![0]!, r.panel)).toEqual({ kind: "circle", centre: { x: "@back.left + 180", y: "@back.bottom + 210" }, diameter: "35", note: "" });
    expect(r.part.profile!.cuts[0]!.text).toBe("35 mm hole, centre 210 from the bottom and 180 from the left");
    expect(newCutFields("round", panelOf(d, "rail"), partOf(d, "rail"))).toMatchObject({ diameter: "20", centre: { x: "@rail.left + 250", y: "@rail.bottom + 20" } });
  });

  it("centres a rectangle 120 along the grain and 60 across it, and a slot 120 × 30 with round ends", () => {
    const d = cabinet();
    const rect = added(d, "back", "rect");
    expect(fieldsOf(rect.panel.cuts![0]!, rect.panel)).toEqual({
      kind: "rect",
      spans: { x: { start: "@back.left + 150", end: "", size: "60" }, y: { start: "@back.bottom + 150", end: "", size: "120" } },
      radius: "",
      note: "",
    });
    expect(rect.part.profile!.cuts[0]!.text).toBe("120 × 60 cutout, 150 from the bottom and 150 from the left");
    expect(cutTitle(rect.panel.cuts![0]!, rect.part)).toBe("Rectangular hole");
    const slot = added(d, "back", "slot");
    expect(slot.panel.cuts![0]).toMatchObject({ id: "slot", radius: "15", y: { size: "120" }, x: { size: "30" } });
    expect(slot.part.profile!.cuts[0]!.text).toBe("120 × 30 cutout with 15 mm round corners, 150 from the bottom and 165 from the left");
    expect(cutTitle(slot.panel.cuts![0]!, slot.part)).toBe("Slot");
  });

  it("takes a 100 × 75 notch out of a side's bottom front corner, for a toe kick", () => {
    const r = added(cabinet(), "side", "notch");
    expect(fieldsOf(r.panel.cuts![0]!, r.panel)).toEqual({
      kind: "rect",
      spans: { y: { start: "@side.bottom", end: "", size: "100" }, z: { start: "", end: "@side.front", size: "75" } },
      radius: "",
      note: "",
    });
    expect(r.part.profile!.cuts[0]!.text).toBe("100 × 75 notch out of the bottom front corner");
    expect(cutTitle(r.panel.cuts![0]!, r.part)).toBe("Notch");
  });

  it("puts a notch at the bottom left of an upright facing forward, and keeps it within half the part", () => {
    const d = cabinet();
    expect(newCutFields("notch", panelOf(d, "back"), partOf(d, "back"))).toMatchObject({
      spans: { x: { start: "@back.left", size: "75" }, y: { start: "@back.bottom", size: "100" } },
    });
    expect(newCutFields("notch", panelOf(d, "rail"), partOf(d, "rail"))).toMatchObject({ spans: { y: { size: "20" } } });
  });

  it("gives a second cut of a kind its own id", () => {
    const once = added(cabinet(), "back", "round").design;
    expect(newCut("round", panelOf(once, "back"), partOf(once, "back")).cut).toBe("hole_2");
    expect(newCut("rect", panelOf(once, "back"), partOf(once, "back")).cut).toBe("hole_2");
    expect(newCut("slot", panelOf(once, "back"), partOf(once, "back")).cut).toBe("slot");
  });
});

describe("the operation a cut's fields make", () => {
  it("reads each box the way a part's own sizes are read: a number, a sum or an @face with an offset", () => {
    const d = added(cabinet(), "drawer_side", "slope").design;
    const fields = fieldsOf(panelOf(d, "drawer_side").cuts![0]!, panelOf(d, "drawer_side"));
    const typed = withField(withField(fields, "start", "@drawer_back.top"), "end", "@drawer_front.top - gap / 2");
    expect(opOf("drawer_side", "slope", typed)).toEqual({
      op: "set_edge_cut",
      id: "drawer_side",
      cut: "slope",
      edge: "top",
      start: { face: "drawer_back.top" },
      end: { face: "drawer_front.top", offset: "-(gap / 2)" },
    });
    const after = applyOps(d, [opOf("drawer_side", "slope", typed)]);
    expect(partOf(after, "drawer_side").profile!.cuts[0]!.text).toBe("top edge sloped from 160 at the back end to 98 at the front end, 8.4°");
    expect(opOf("drawer_side", "slope", withField(typed, "start", "cab_h - 600"))).toMatchObject({ start: { at: "cab_h - 600" } });
  });

  it("builds a cutout's spans, radius and note, and a circle's centre", () => {
    const rect: CutFields = { kind: "rect", spans: { x: { start: "@back.left + gap * 10", end: "", size: "60" }, y: { start: "", end: "@back.top - 50", size: "120" } }, radius: "30", note: "cable slot" };
    expect(opOf("back", "slot", rect)).toEqual({
      op: "set_cutout",
      id: "back",
      cut: "slot",
      shape: "rect",
      x: { start: { face: "back.left", offset: "gap * 10" }, size: "60" },
      y: { end: { face: "back.top", offset: "-50" }, size: "120" },
      radius: "30",
      note: "cable slot",
    });
    const round: CutFields = { kind: "circle", centre: { x: "220", y: "@back.top - 80" }, diameter: "gap * 9", note: "" };
    expect(opOf("back", "hole", round)).toEqual({ op: "set_cutout", id: "back", cut: "hole", shape: "circle", centre: { x: { at: "220" }, y: { face: "back.top", offset: "-80" } }, diameter: "gap * 9" });
  });

  it("makes the same cut again from the fields it shows, for every kind", () => {
    let d = cabinet();
    for (const [id, kind] of [
      ["side", "slope"],
      ["side", "notch"],
      ["back", "round"],
      ["back", "slot"],
    ] as const) d = added(d, id, kind).design;
    for (const p of d.parts.filter((x) => x.cuts)) {
      for (const cut of p.cuts!) {
        const again = applyOps(d, [opOf(p.id, cut.id, fieldsOf(cut, p))]);
        expect(panelOf(again, p.id)).toEqual(p);
      }
    }
  });

  it("reads and changes one box by its key", () => {
    const f = newCutFields("rect", panelOf(cabinet(), "back"), partOf(cabinet(), "back"));
    expect(fieldValue(f, "y.size")).toBe("120");
    expect(fieldValue(withField(f, "y.end", "@back.top"), "y.end")).toBe("@back.top");
    expect(fieldValue(withField(f, "radius", "10"), "radius")).toBe("10");
    expect(fieldValue(withField(f, "note", "for a cable"), "note")).toBe("for a cable");
  });

  it("keeps a bound's text and its offset the same through a field", () => {
    for (const text of ["450", "@side.top", "@side.top - 240", "@side.bottom + gap * 2", "@drawer_front.top - (gap / 2)"]) expect(boundText(parseBound(text))).toBe(text);
  });
});

describe("what the design says while you type", () => {
  const d = added(cabinet(), "drawer_side", "slope").design;
  const state = stateOf(d);
  const fields = fieldsOf(panelOf(d, "drawer_side").cuts![0]!, panelOf(d, "drawer_side"));
  const typing = (key: string, text: string) => draftNote(previewChange(state, [opOf("drawer_side", "slope", withField(fields, key, text))]), "drawer_side", "slope");

  it("gives the cut's new words, angle and end heights as you type", () => {
    expect(typing("end", "@drawer_front.top")).toEqual({ error: null, note: "top edge sloped from 160 at the back end to 100 at the front end, 8.1°", problems: [] });
  });

  it("gives the design's refusal for a face that isn't there, or a broad face", () => {
    expect(typing("end", "@drawer_frnt.top").error).toBe('There\'s no part called "drawer_frnt" for drawer_side cut slope end, which sits against drawer_frnt.top. Check the name, or add the part first.');
    expect(typing("end", "@drawer_front.left").error).toBe("drawer_side cut slope end is on the y axis, so its face must be bottom or top, not left");
    expect(draftNote(previewChange(state, [opOf("drawer_side", "slope", { ...fields, edge: "left" })]), "drawer_side", "slope").error).toBe(
      "drawer_side cut slope can't take wood from the left face, which is a broad face of drawer_side. Pick one of its edges: bottom, top, back, front",
    );
    expect(typing("start", "").error).toBe("drawer_side cut slope needs start and end: where its new edge sits on y at each end of its run");
  });

  it("gives the cut's own problems, such as a line that misses the wood", () => {
    const missed = typing("end", "@drawer_side.top + 50");
    expect(missed.error).toBeNull();
    expect(missed.note).toBeNull();
    expect(missed.problems).toEqual([{ severity: "warning", message: "Cut slope on drawer_side: its line misses the wood, so it takes nothing off. Check where it starts and ends" }]);
  });

  it("draws the typed change as a ghost over the model as it is", () => {
    const result = fits(previewChange(state, [opOf("drawer_side", "slope", withField(fields, "end", "@drawer_front.top"))]));
    const view = draftView(state, result);
    expect(view.parts).toBe(state.derived.parts);
    expect(view.ghost!.parts.map((g) => g.id)).toEqual(["drawer_side"]);
    expect(view.ghost!.parts[0]!.profile!.cuts[0]!.end_mm).toBe(100);
    expect(view.ghost!.faded).toEqual(["drawer_side"]);
  });
});

describe("each cut's words and problems", () => {
  it("names a cut by what it does", () => {
    let d = added(cabinet(), "drawer_side", "slope").design;
    const side = () => partOf(d, "drawer_side");
    expect(cutTitle(panelOf(d, "drawer_side").cuts![0]!, side())).toBe("Sloped edge");
    d = applyOps(d, [{ op: "set_edge_cut", id: "drawer_side", cut: "slope", edge: "top", start: { face: "drawer_side.top", offset: "100" }, end: { face: "drawer_side.top", offset: "-40" } }]);
    expect(cutTitle(panelOf(d, "drawer_side").cuts![0]!, side())).toBe("Corner cut");
    d = applyOps(d, [{ op: "set_cutout", id: "drawer_side", cut: "pull", shape: "circle", centre: { y: { at: "560" }, z: { at: "200" } }, diameter: "30" }]);
    expect(cutTitle(panelOf(d, "drawer_side").cuts![1]!, side())).toBe("Round notch");
  });

  it("finds the cuts a problem names, alone or in a list", () => {
    expect(cutsNamed("Cut slope on side: its line misses the wood")).toEqual(["slope"]);
    expect(cutsNamed("Cuts hole and slot on back leave only 3 mm of wood between them")).toEqual(["hole", "slot"]);
    expect(cutsNamed("Joint j: cuts a, b and kick on side take away all the wood")).toEqual(["a", "b", "kick"]);
  });

  it("puts each problem on the cut it names, and the rest on the shape as a whole", () => {
    const close: Op[] = [
      { op: "set_cutout", id: "back", cut: "hole", shape: "circle", centre: { x: { at: "220" }, y: { at: "210" } }, diameter: "35" },
      { op: "set_cutout", id: "back", cut: "slot", shape: "rect", x: { start: { at: "240" }, size: "20" }, y: { start: { at: "150" }, size: "120" } },
    ];
    const d = cabinet(close);
    const issues = stateOf(d).report.issues;
    expect(problemsFor(issues, "back", "slot").map((i) => i.code)).toEqual(["cut_web"]);
    expect(problemsFor(issues, "back", "hole").map((i) => i.code)).toEqual(["cut_web"]);
    expect(problemsFor(issues, "side", "hole")).toEqual([]);
    expect(shapeProblems(issues, panelOf(d, "back"))).toEqual([]);
    const split = cabinet([...close, { op: "set_cutout", id: "back", cut: "split", shape: "rect", x: { start: { at: "0" }, end: { at: "500" } }, y: { start: { at: "380" }, size: "10" } }]);
    expect(shapeProblems(stateOf(split).report.issues, panelOf(split, "back")).map((i) => i.code)).toEqual(["cut_severs"]);
  });
});

describe("the face drawn small", () => {
  it("draws a side from the side, back on the left, with the cut edge lit and the wood left at each end", () => {
    const r = added(cabinet(), "drawer_side", "slope");
    const drawing = faceDrawing(r.part, { edge: "top", cut: "slope" });
    expect(drawing.edges.map((e) => [e.face, e.on])).toEqual([
      ["top", true],
      ["bottom", false],
      ["back", false],
      ["front", false],
    ]);
    expect(drawing.ends.map((e) => e.text)).toEqual(["160", "107"]);
    // The back end is on the left and stands higher.
    const [back, front] = drawing.ends;
    expect(back!.x).toBeLessThan(front!.x);
    expect(back!.y).toBeLessThan(front!.y);
    expect(drawing.wood).not.toBe(drawing.blank);
  });

  it("draws a flat part from above with its back at the top, a long thin one deep enough to read, and lights a hole", () => {
    const shelf = faceDrawing(partOf(cabinet(), "shelf"));
    expect(shelf.edges.map((e) => e.face)).toEqual(["back", "front", "left", "right"]);
    const rail = faceDrawing(partOf(cabinet(), "rail"));
    expect(rail.height - 36).toBeGreaterThanOrEqual(40);
    const r = added(cabinet(), "back", "round");
    expect(faceDrawing(r.part, { cut: "hole" }).hole).toMatch(/^M/);
    expect(faceDrawing(r.part, { cut: "other" }).hole).toBeNull();
  });
});

describe("the editor's boxes", () => {
  it("names a slope's ends by the part's own ends, and folds away the rarely used ones", () => {
    const d = cabinet();
    const groups = fieldGroups(panelOf(d, "drawer_side"), slopeFields(panelOf(d, "drawer_side"), partOf(d, "drawer_side"), "top"));
    expect(groups.map((g) => [g.title, g.fields.map((f) => f.label), !!g.more])).toEqual([
      ["Where the new top edge sits on y", ["at the back end", "at the front end"], false],
      ["Measure those somewhere else along z", ["back point", "front point"], true],
      ["Note", ["note"], true],
    ]);
  });

  it("gives a rectangle start, end and size on each axis, and a circle its centre", () => {
    const d = cabinet();
    const back = panelOf(d, "back");
    expect(fieldGroups(back, newCutFields("rect", back, partOf(d, "back"))).map((g) => g.fields.map((f) => f.key))).toEqual([
      ["x.start", "x.end", "x.size"],
      ["y.start", "y.end", "y.size"],
      ["radius"],
      ["note"],
    ]);
    expect(fieldGroups(back, newCutFields("round", back, partOf(d, "back")))[0]!.fields.map((f) => f.key)).toEqual(["centre.x", "centre.y"]);
  });
});

describe("the Shape section", () => {
  const d = added(added(cabinet(), "side", "slope").design, "side", "notch").design;
  const state = stateOf(d);
  const part = state.derived.parts.find((p) => p.id === "side")!;
  const html = (canEdit = true) => renderToStaticMarkup(createElement(ShapeSection, { now: state, part, panel: panelOf(d, "side"), canEdit }));

  it("says what cuts are for, and lists each with its words and its buttons", () => {
    const out = html();
    expect(out).toContain(SHAPE_WHY);
    expect(out).toContain("2 cuts");
    expect(out).toContain("<strong>Sloped edge</strong>");
    expect(out).toContain("top end sloped from 720 at the back edge to 480 at the front edge, 31°");
    expect(out).toContain("100 × 75 notch out of the bottom front corner");
    expect(out.match(/>Edit<\/button>/g)).toHaveLength(2);
    expect(out.match(/>Remove<\/button>/g)).toHaveLength(2);
    for (const add of ["Slope an edge", "Cut a hole", "Notch"]) expect(out).toContain(`>${add}</button>`);
    expect(out).toContain('data-place="cut:side.slope"');
  });

  it("offers no buttons on an array copy, which shares its original's cuts", () => {
    const out = html(false);
    expect(out).not.toContain(">Edit</button>");
    expect(out).not.toContain(">Slope an edge</button>");
    expect(out).toContain("Copies share the first one&#x27;s cuts");
  });

  it("shows a cut's problem under it", () => {
    const bad = applyOps(d, [{ op: "set_edge_cut", id: "side", cut: "slope", edge: "top", start: { at: "900" }, end: { at: "900" } }]);
    const s = stateOf(bad);
    const out = renderToStaticMarkup(createElement(ShapeSection, { now: s, part: s.derived.parts.find((p) => p.id === "side")!, panel: panelOf(bad, "side"), canEdit: true }));
    expect(out).toContain("It takes no wood as it stands.");
    expect(out).toContain("Cut slope on side: its line misses the wood, so it takes nothing off.");
  });
});

describe("a cut's editor", () => {
  const editor = (d: Design, id: string) => {
    const state = stateOf(d);
    const panel = panelOf(d, id);
    return renderToStaticMarkup(
      createElement(CutEditor, { now: state, part: state.derived.parts.find((p) => p.id === id)!, panel, cut: panel.cuts![0]!, onResult: () => true }),
    );
  };

  it("offers a slope's four edges as one choice, its ends as fields, and draws the face with the edge lit", () => {
    const out = editor(added(cabinet(), "drawer_side", "slope").design, "drawer_side");
    expect(out.match(/role="radio"/g)).toHaveLength(4);
    expect(out).toContain('aria-checked="true" class="on">top</button>');
    expect(out).toContain("Where the new top edge sits on y");
    expect(out).toContain('value="@drawer_side.top"');
    expect(out).toContain('value="@drawer_side.top - 53"');
    expect(out).toContain('<line class="fd-edge on"');
    expect(out).toContain(">160</text>");
    expect(out).toContain("Enter or leaving the box makes it, and Esc puts it back.");
  });

  it("gives a hole its centre and diameter, and folds the note away", () => {
    const out = editor(added(cabinet(), "back", "round").design, "back");
    expect(out).not.toContain('role="radio"');
    expect(out).toContain('value="@back.left + 180"');
    expect(out).toContain('value="35"');
    expect(out).toContain('<path class="fd-hole"');
    expect(out).toMatch(/<details class="cut-more"><summary class="small">More<\/summary>/);
  });
});

describe("the cut list", () => {
  it("shows each shaped row's notes under its name", () => {
    const d = added(cabinet(), "back", "round").design;
    const out = renderToStaticMarkup(createElement(CutListPanel, { state: stateOf(d), onSelect: () => {} }));
    expect(out).toContain('<div class="shape-note small muted">35 mm hole, centre 210 from the bottom and 180 from the left</div>');
    expect(out).toContain("A shaped part is cut from the blank these sizes give");
    expect(renderToStaticMarkup(createElement(CutListPanel, { state: stateOf(cabinet()), onSelect: () => {} }))).not.toContain("shape-note");
  });
});
