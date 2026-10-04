// The side panel's five tabs, where each of the old eleven went, the All
// designs and parts page, and where a view command's drawer and highlight
// land now that the waiting change is drawn on the model.

import { describe, expect, it } from "vitest";
import { readViewCommand } from "@woodchuck/core";
import { needsYou } from "../src/designMenu.js";
import { hideGhost, type GhostPref } from "../src/ghost.js";
import { applyView, type ViewState } from "../src/toolbar.js";
import {
  ALL_SECTIONS,
  checkCount,
  homeOf,
  MAKE_VIEWS,
  PILL_TAB,
  readMake,
  readTab,
  routeView,
  TAB_PANELS,
  TABS,
  tabAfterPick,
  waitingIn,
  type Panel,
  type Tab,
} from "../src/tabs.js";

const OLD: Panel[] = ["part", "finish", "params", "cut", "layout", "problems", "history", "versions", "designs", "library", "requests"];

describe("the five tabs", () => {
  it("are Edit, Finish, Make, Check and History, in that order", () => {
    expect(TABS.map((t) => t.label)).toEqual(["Edit", "Finish", "Make", "Check", "History"]);
    for (const t of TABS) expect(t.tip.length, t.id).toBeGreaterThan(10);
  });

  it("hold every old tab's panel, each in exactly one place", () => {
    const inTabs = Object.values(TAB_PANELS).flat();
    // Your workshop is new, so it was never one of the old panels.
    const onPage = ALL_SECTIONS.map((s) => s.panel).filter((p) => p !== "workshop");
    expect([...inTabs, ...onPage].sort()).toEqual([...OLD].sort());
    expect(new Set([...inTabs, ...onPage]).size).toBe(OLD.length);
  });

  it("put the part over the sizes in Edit, and the cut list and layout in Make", () => {
    expect(TAB_PANELS).toEqual({
      edit: ["part", "params"],
      finish: ["finish"],
      make: ["cut", "layout"],
      check: ["problems"],
      history: ["history", "versions"],
    });
    expect(MAKE_VIEWS.map((v) => v.label)).toEqual(["Cut list", "Cut layout"]);
  });

  it("say where each old panel lives now", () => {
    expect(homeOf("part")).toEqual({ tab: "edit" });
    expect(homeOf("params")).toEqual({ tab: "edit" });
    expect(homeOf("finish")).toEqual({ tab: "finish" });
    expect(homeOf("cut")).toEqual({ tab: "make", make: "list" });
    expect(homeOf("layout")).toEqual({ tab: "make", make: "layout" });
    expect(homeOf("problems")).toEqual({ tab: "check" });
    expect(homeOf("history")).toEqual({ tab: "history" });
    expect(homeOf("versions")).toEqual({ tab: "history" });
    expect(homeOf("designs")).toEqual({ page: "all", section: "designs" });
    expect(homeOf("library")).toEqual({ page: "all", section: "library" });
    expect(homeOf("requests")).toEqual({ page: "all", section: "tools" });
  });

  it("open the tab a browser remembered, taking an old tab to where it went", () => {
    for (const t of TABS) expect(readTab(t.id)).toBe(t.id);
    expect(readTab("params")).toBe("edit");
    expect(readTab("part")).toBe("edit");
    expect(readTab("cut")).toBe("make");
    expect(readTab("layout")).toBe("make");
    expect(readTab("problems")).toBe("check");
    expect(readTab("versions")).toBe("history");
    // The app-wide lists are a page now, so the panel opens on Edit.
    for (const gone of ["designs", "library", "requests", null, "", "neon"]) expect(readTab(gone)).toBe("edit");
    expect(readMake("layout")).toBe("layout");
    expect(readMake(null)).toBe("list");
    expect(readMake("cut")).toBe("list");
  });
});

describe("picking a part opens Edit", () => {
  it("from the model, the cut list or any tab", () => {
    for (const t of ["edit", "make", "check", "history"] as Tab[]) expect(tabAfterPick(t), t).toBe("edit");
  });

  it("but keeps you in Finish, where a colour goes on what you've picked", () => {
    expect(tabAfterPick("finish")).toBe("finish");
  });
});

describe("the status pill and the Check tab", () => {
  it("the pill opens Check", () => {
    expect(PILL_TAB).toBe("check");
  });

  it("Check carries the count of problems, red when one is an error", () => {
    expect(checkCount({ issues: [], errors: 0 })).toBeNull();
    const warn = { key: "w", severity: "warning", code: "floating", message: "Nothing holds up shelf_slat", parts: ["shelf_slat"] } as const;
    const err = { key: "e", severity: "error", code: "rule_failed", message: "Books don't fit (rule book_room)", parts: [] } as const;
    expect(checkCount({ issues: [warn], errors: 0 })).toEqual({ n: 1, tone: "warn" });
    expect(checkCount({ issues: [warn, err], errors: 1 })).toEqual({ n: 2, tone: "bad" });
  });
});

describe("the All designs and parts page", () => {
  const state = (proposals: number, statuses: string[]) => ({
    library: { parts: [], pending: {}, broken: [], proposals: Array.from({ length: proposals }, (_, i) => ({ id: `pp_${i}` })) },
    tool_requests: statuses.map((status, i) => ({ id: `t${i}`, status })),
  });

  it("has Designs, Parts library, Missing tools and Your workshop, in that order", () => {
    expect(ALL_SECTIONS.map((s) => s.label)).toEqual(["Designs", "Parts library", "Missing tools", "Your workshop"]);
    expect(ALL_SECTIONS.map((s) => s.panel)).toEqual(["designs", "library", "requests", "workshop"]);
  });

  it("says which sections need you, and the design menu's badge counts the same", () => {
    const s = state(1, ["open", "built", "open", "declined", "approved"]);
    expect(waitingIn(s as never)).toEqual({ designs: 0, library: 1, tools: 2, workshop: 0 });
    const w = waitingIn(s as never);
    expect(needsYou(s as never)).toBe(w.designs + w.library + w.tools + w.workshop);
    expect(waitingIn(state(0, ["built"]) as never)).toEqual({ designs: 0, library: 0, tools: 0, workshop: 0 });
  });
});

describe("view commands land on the new tabs and the ghost", () => {
  const view: ViewState = { mode: "3d", look: "plain", lighting: "daylight", view: "iso", planView: "front", xray: false, photo: false, full: false };
  /** A command as Crossband's woodchuck_view sends it, through the same checks as /api/view. */
  const route = (cmd: Record<string, unknown>, ctx: { liveId: string | null; pref?: GhostPref | null; tab?: Tab }) => {
    const { effects } = applyView(view, readViewCommand({ ...cmd, from: "Crossband" }), false);
    return routeView(effects, { liveId: ctx.liveId, pref: ctx.pref ?? null, tab: ctx.tab ?? "make" });
  };

  it("drawer: preview shows the waiting change on the model, never in the drawer", () => {
    const r = route({ drawer: "preview" }, { liveId: "v1" });
    expect(r.ghost).toEqual({ id: "v1", side: "now", hidden: false });
    expect(r.drawer).toBeUndefined();
    expect(r.show3d).toBe(true);
    // A ghost you'd put away comes back, on the side it was on.
    const back = route({ drawer: "preview" }, { liveId: "v1", pref: { id: "v1", side: "after", hidden: true } });
    expect(back.ghost).toEqual({ id: "v1", side: "after", hidden: false });
  });

  it("drawer: preview with nothing waiting says so and changes nothing", () => {
    const r = route({ drawer: "preview" }, { liveId: null });
    expect(r.ghost).toBeUndefined();
    expect(r.drawer).toBeUndefined();
    expect(r.note).toBe("Claude isn't waiting on a suggested change.");
  });

  it("drawer: a joint opens its worked example in the drawer", () => {
    expect(route({ drawer: { joint: "half_lap" } }, { liveId: "v1" })).toEqual({ drawer: { joint: "half_lap" } });
  });

  it("drawer: close closes the drawer and puts the ghost away", () => {
    const r = route({ drawer: "close" }, { liveId: "v1" });
    expect(r.drawer).toBe("close");
    expect(r.ghost).toEqual(hideGhost("v1", null));
    expect(route({ drawer: "close" }, { liveId: null })).toEqual({ drawer: "close" });
  });

  it("highlight picks the parts and opens Edit, as a click on them does", () => {
    // Crossband's highlight arrives as select.
    const r = route({ select: ["leg_fl", "rail_front_top"] }, { liveId: null, tab: "make" });
    expect(r.select).toEqual(["leg_fl", "rail_front_top"]);
    expect(r.tab).toBe("edit");
    expect(route({ select: ["leg_fl"] }, { liveId: null, tab: "finish" }).tab).toBe("finish");
    // Clearing the highlight leaves the tab alone.
    const cleared = route({ select: [] }, { liveId: null, tab: "history" });
    expect(cleared.select).toEqual([]);
    expect(cleared.tab).toBeUndefined();
  });

  it("leaves the ghost and the tabs alone for a command about the camera", () => {
    expect(route({ view: "front", fit: true }, { liveId: "v1" })).toEqual({});
  });
});
