// One calm toolbar row: three fixed groups whose controls never move or
// vanish, and every view command from outside the window lands on the
// control that shows it.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readViewCommand, type ViewCommand } from "@woodchuck/core";
import { Toolbar, type ToolbarActions, type ToolbarMenu } from "../src/components/Toolbar.js";
import {
  allControls,
  applyView,
  cameraMenu,
  lookMenu,
  ROUTES,
  shareMenu,
  TIPS,
  toolbar,
  toolbarState,
  type ToolbarState,
  type ViewState,
} from "../src/toolbar.js";
import type { PointMode } from "../src/components/Viewport.js";

const base: ToolbarState = {
  mode: "3d",
  pointMode: "pick",
  view: "iso",
  xray: false,
  look: "plain",
  lighting: "daylight",
  inPhoto: false,
  hasPhoto: false,
  full: false,
  empty: false,
  paper: "A4",
};

const noop = () => {};
const actions: ToolbarActions = {
  onTool: noop,
  onCamera: noop,
  onFit: noop,
  onSeeThrough: noop,
  onLook: noop,
  onLighting: noop,
  onMode: noop,
  onRender: noop,
  onPhoto: noop,
  onFull: noop,
  onDrawings: noop,
};
const html = (state: ToolbarState, menu: ToolbarMenu = null) => renderToStaticMarkup(createElement(Toolbar, { state, menu, onMenu: noop, ...actions }));

/** The controls in the order the markup draws them, by data-control. */
const drawn = (markup: string) => [...markup.matchAll(/data-control="([^"]+)"/g)].map((m) => m[1]!);
/** Whether the markup draws a control greyed out. */
const greyed = (markup: string, id: string) => new RegExp(`<[^>]*aria-disabled="true"[^>]*data-control="${id.replace(".", "\\.")}"|<[^>]*data-control="${id.replace(".", "\\.")}"[^>]*aria-disabled="true"`).test(markup);

// Every combination a mode, look, tool or design can put the window in.
const states: ToolbarState[] = [];
for (const mode of ["3d", "2d"] as const)
  for (const look of ["plain", "finished"] as const)
    for (const pointMode of ["pick", "box", "pin", "pan"] as PointMode[])
      for (const empty of [false, true])
        for (const inPhoto of [false, true]) states.push({ ...base, mode, look, pointMode, empty, inPhoto: inPhoto && mode === "3d", hasPhoto: inPhoto, full: inPhoto });

describe("one toolbar row", () => {
  it("holds Tools, View and Share, in that order", () => {
    const groups = toolbar(base);
    expect(groups.map((g) => [g.label, g.controls.map((c) => c.label)])).toEqual([
      ["Tools", ["Select", "Box", "Pin", "Pan"]],
      ["View", ["Iso", "Fit", "See-through", "Look"]],
      ["Share", ["Share"]],
    ]);
    const markup = html(base);
    expect([...markup.matchAll(/role="group" aria-label="([^"]+)"/g)].map((m) => m[1])).toEqual(["Tools", "View", "Share"]);
    expect(drawn(markup)).toEqual(["tool.pick", "tool.box", "tool.pin", "tool.pan", "camera", "fit", "see-through", "look", "share"]);
  });

  it("keeps every control in its slot, whatever the mode, look or tool", () => {
    const slots = (s: ToolbarState) => toolbar(s).map((g) => g.controls.map((c) => `${c.id}:${c.label}`));
    for (const s of states) expect(slots(s), JSON.stringify(s)).toEqual(slots(base));
    // The menus keep theirs too.
    const ids = (s: ToolbarState) => [...allControls(s).keys()];
    for (const s of states) expect(ids(s)).toEqual(ids(base));
    for (const s of states) expect(drawn(html(s))).toEqual(drawn(html(base)));
  });

  it("leaves Faces to the Finish tab", () => {
    for (const s of states) expect([...allControls(s).values()].map((c) => c.label)).not.toContain("Faces");
  });

  it("greys out what can't act, and never hides it", () => {
    const flat = { ...base, mode: "2d" as const };
    const markup = html(flat);
    for (const id of ["tool.pick", "tool.box", "tool.pin", "tool.pan", "camera", "fit"]) {
      expect(drawn(markup)).toContain(id);
      expect(greyed(markup, id), id).toBe(true);
    }
    for (const id of ["see-through", "look", "share"]) expect(greyed(markup, id), id).toBe(false);
    expect(allControls(flat).get("tool.pin")!.tip).toMatch(/3D view/);

    const empty = { ...base, empty: true };
    const shareOpen = html(empty, "share");
    for (const id of ["share.render", "share.photo", "share.drawings"]) {
      expect(drawn(shareOpen)).toContain(id);
      expect(greyed(shareOpen, id), id).toBe(true);
      expect(allControls(empty).get(id)!.tip).toMatch(/Ask Claude to build something first/);
    }
    expect(greyed(shareOpen, "share.full")).toBe(false);
    expect(greyed(html(empty), "see-through")).toBe(true);
  });

  it("keeps lighting in the Look menu in every look, live only in Finished", () => {
    const plain = html(base, "look");
    for (const id of ["lighting.daylight", "lighting.evening", "lighting.workshop"]) {
      expect(drawn(plain)).toContain(id);
      expect(greyed(plain, id), id).toBe(true);
    }
    expect(plain).toContain("Lighting shows in the Finished look.");
    const finished = html({ ...base, look: "finished" }, "look");
    for (const id of ["lighting.daylight", "lighting.evening", "lighting.workshop"]) expect(greyed(finished, id), id).toBe(false);
    // A photo always shows the Finished look, so Plain waits and lighting works.
    const photo = lookMenu({ ...base, inPhoto: true, hasPhoto: true }).flatMap((s) => s.items);
    expect(photo.find((c) => c.id === "look.plain")!.disabled).toBe(true);
    expect(photo.find((c) => c.id === "lighting.evening")!.disabled).toBe(false);
    expect(lookMenu(base).map((s) => s.label)).toEqual(["Look", "Lighting", "Views"]);
  });

  it("names the menus' items as the phone layout does", () => {
    expect(cameraMenu(base).map((c) => c.label)).toEqual(["Iso", "Front", "Top", "Left", "Right", "Back"]);
    expect(lookMenu(base).flatMap((s) => s.items.map((c) => c.label))).toEqual(["Plain", "Finished", "Daylight", "Evening", "Workshop", "3D", "2D views"]);
    expect(shareMenu(base).map((c) => c.label)).toEqual(["Render", "Photo", "Full screen", "Workshop drawings (PDF)"]);
  });

  it("puts each shortcut in its control's tooltip", () => {
    const all = allControls(base);
    for (const [id, key] of [
      ["tool.pick", "V"],
      ["tool.box", "B"],
      ["tool.pin", "P"],
      ["tool.pan", "H"],
      ["fit", "F"],
      ["see-through", "X"],
      ["camera", "1 to 6"],
      ["camera.iso", "1"],
      ["camera.front", "2"],
      ["camera.top", "3"],
      ["camera.left", "4"],
      ["camera.right", "5"],
      ["camera.back", "6"],
    ] as const)
      expect(all.get(id)!.tip, id).toContain(`(${key})`);
    expect(TIPS.undo).toContain("(⌘Z)");
    expect(TIPS.redo).toContain("(⇧⌘Z)");
    expect(TIPS.chat).toContain("(⌘K)");
    expect(html(base)).toContain('title="Bring the whole model back into view (F)"');
  });
});

const view: ViewState = { mode: "3d", look: "plain", lighting: "daylight", view: "iso", planView: "front", xray: false, photo: false, full: false };
const rest = { pointMode: "pick" as PointMode, hasPhoto: true, empty: false, paper: "A4" as const };
/** A command from outside, then the toolbar as it would draw. */
const after = (v: ViewCommand, from: ViewState = view, hasPhoto = true) => {
  const r = applyView(from, readViewCommand(v), hasPhoto);
  return { ...r, controls: allControls(toolbarState(r.state, { ...rest, hasPhoto })), bar: toolbar(toolbarState(r.state, { ...rest, hasPhoto })) };
};

describe("view commands reach the toolbar", () => {
  it("has a home for every kind of command, and each home is a real control", () => {
    const every = readViewCommand({
      mode: "plan",
      look: "finished",
      lighting: "evening",
      view: "top",
      fit: true,
      turn: 20,
      zoom: 1.5,
      seeThrough: true,
      photo: true,
      render: true,
      fill: true,
      select: ["leg_fl"],
      drawer: "preview",
      from: "Crossband",
      note: "Have a look",
    });
    // An orbit can't go with the plan views or the photo, and a tab can't go with filling the window, so each comes on its own.
    const orbit = readViewCommand({ orbit: "start", orbitSpeed: 10 });
    const tab = readViewCommand({ tab: "make" });
    const routed = [...Object.keys(every), ...Object.keys(orbit), ...Object.keys(tab)].filter((k) => k !== "from" && k !== "note");
    expect(routed.sort()).toEqual(Object.keys(ROUTES).sort());
    const ids = [...allControls(base).keys()];
    for (const [key, home] of Object.entries(ROUTES)) {
      // The model, the drawer and the side panel's tab bar are homes outside the toolbar.
      if (home === "canvas" || home === "drawer" || home === "tabs") continue;
      expect(
        ids.some((id) => id === home || id.startsWith(`${home}.`)),
        `${key} goes to ${home}`,
      ).toBe(true);
    }
  });

  it("switches between the 3D view and the drawings in the Look menu", () => {
    const plan = after({ mode: "plan" });
    expect(plan.controls.get("views.2d")!.on).toBe(true);
    expect(plan.controls.get("tool.pick")!.disabled).toBe(true);
    const back = after({ mode: "3d" }, plan.state);
    expect(back.controls.get("views.3d")!.on).toBe(true);
    // A command that doesn't ask for the drawings shows the 3D view, as it always has.
    expect(after({ seeThrough: true }, plan.state).state.mode).toBe("3d");
    // A camera view with the drawings picks that drawing.
    expect(after({ mode: "plan", view: "left" }).state.planView).toBe("left");
    expect(after({ view: "left" }).state.planView).toBe("front");
  });

  it("sets the look and the lighting in the Look menu", () => {
    const finished = after({ look: "finished" });
    expect(finished.controls.get("look.finished")!.on).toBe(true);
    expect(finished.controls.get("lighting.daylight")!.disabled).toBe(false);
    // Lighting brings the Finished look, where it shows.
    const evening = after({ lighting: "evening" });
    expect(evening.controls.get("look.finished")!.on).toBe(true);
    expect(evening.controls.get("lighting.evening")!.on).toBe(true);
    expect(evening.controls.get("lighting.evening")!.disabled).toBe(false);
    expect(after({ look: "plain", lighting: "workshop" }, finished.state).controls.get("look.plain")!.on).toBe(true);
  });

  it("turns the camera menu, Fit and See-through", () => {
    const top = after({ view: "top" });
    expect(top.controls.get("camera.top")!.on).toBe(true);
    expect(top.bar[1]!.controls[0]!.label).toBe("Top");
    expect(top.effects.refit).toBe(true);
    expect(after({ fit: true }).effects.refit).toBe(true);
    expect(after({ seeThrough: true }).controls.get("see-through")!.on).toBe(true);
    expect(after({ seeThrough: false }, { ...view, xray: true }).controls.get("see-through")!.on).toBe(false);
  });

  it("works the Share menu: Photo, Full screen and Render", () => {
    expect(after({ photo: true }).controls.get("share.photo")!.on).toBe(true);
    // With no photo kept, there's nothing to place it in.
    expect(after({ photo: true }, view, false).controls.get("share.photo")!.on).toBe(false);
    expect(after({ fill: true }).controls.get("share.full")!.on).toBe(true);
    expect(after({ fill: false }, { ...view, full: true }).controls.get("share.full")!.on).toBe(false);
    expect(after({ render: true }).effects.render).toBe(true);
  });

  it("turns, zooms, picks parts and opens the drawer on the model itself", () => {
    expect(after({ turn: -30, zoom: 1.5 }).effects.nudge).toEqual({ turn: -30, zoom: 1.5 });
    expect(after({ zoom: 0.5 }).effects.nudge).toEqual({ turn: 0, zoom: 0.5 });
    expect(after({ select: ["leg_fl", "rail_front_top"] }).effects.select).toEqual(["leg_fl", "rail_front_top"]);
    expect(after({ select: [] }).effects.select).toEqual([]);
    expect(after({ drawer: "preview" }).effects.drawer).toBe("preview");
    expect(after({ drawer: { joint: "half_lap" } }).effects.drawer).toEqual({ joint: "half_lap" });
    expect(after({ drawer: "close" }).effects.drawer).toBe("close");
    // Nothing else moves for a command that only picks parts.
    const picked = after({ select: ["leg_fl"] });
    expect(picked.effects).toMatchObject({ refit: false, nudge: null, orbit: null, render: false, drawer: null });
    expect(picked.state).toEqual(view);
  });

  it("starts and stops an orbit, which keeps going through the look, lighting, zoom and Fit", () => {
    expect(after({ orbit: "start" }).effects.orbit).toBe(12);
    expect(after({ orbit: "start", orbitSpeed: -30, view: "front" }).effects.orbit).toBe(-30);
    expect(after({ orbit: "stop" }).effects.orbit).toBe("stop");
    for (const v of [{ look: "finished" }, { lighting: "evening" }, { zoom: 1.5 }, { turn: 20 }, { fit: true }, { seeThrough: true }, { select: ["leg_fl"] }] as ViewCommand[])
      expect(after(v).effects.orbit, JSON.stringify(v)).toBeNull();
  });

  it("stops an orbit for a camera view, the plan views or the room photo", () => {
    expect(after({ view: "top" }).effects.orbit).toBe("stop");
    expect(after({ mode: "plan" }).effects.orbit).toBe("stop");
    expect(after({ photo: true }).effects.orbit).toBe("stop");
    // With no photo kept, the photo can't come up, so nothing stops.
    expect(after({ photo: true }, view, false).effects.orbit).toBeNull();
  });

  it("opens a tab and leaves the view as it is, bringing the panels back from a full window", () => {
    const plan = after({ mode: "plan" }).state;
    const make = after({ tab: "make" }, plan);
    expect(make.state).toEqual(plan);
    expect(make.effects).toMatchObject({ tab: "make", refit: false, nudge: null, render: false, select: null, drawer: null });
    // An orbit keeps going while a tab opens.
    expect(after({ tab: "check" }).effects.orbit).toBeNull();
    expect(after({ tab: "check" }).state).toEqual(view);
    const full = after({ fill: true }).state;
    const back = after({ tab: "history" }, full);
    expect(back.state.full).toBe(false);
    expect(back.controls.get("share.full")!.on).toBe(false);
    // With anything else, the 3D view comes up, as for every other command.
    expect(after({ tab: "make", look: "finished" }, plan).state.mode).toBe("3d");
  });

  it("leaves the plan views up for a command that only stops an orbit", () => {
    const plan = after({ mode: "plan" }).state;
    expect(after({ orbit: "stop" }, plan).state).toEqual(plan);
    expect(after({ orbit: "stop", note: "Done" }, plan).state.mode).toBe("2d");
    // Anything more shows the 3D view, as every command does.
    expect(after({ orbit: "stop", look: "finished" }, plan).state.mode).toBe("3d");
  });
});
