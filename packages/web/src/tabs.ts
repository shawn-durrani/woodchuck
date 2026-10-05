// The side panel's five tabs, and the page for everything outside the open
// design. Edit holds the part you picked over the design's sizes, Finish
// its timber and colours, Make the cut list, cut layout and drawings, Check
// its problems, and History every change and version. Designs, the parts
// library, missing tools and your workshop are app-wide, so they live on one
// page from the design menu. The phone layout uses the same tabs under the
// same names.
// Kept free of React so the tests can hold it.

import type { JointType, SideTab } from "@woodchuck/core";
import type { ServerState } from "./api";
import { ghostShown, hideGhost, showGhost, type GhostPref } from "./ghost";
import type { ViewEffects } from "./toolbar";

/** The same five names a view command from another chat opens. */
export type Tab = SideTab;

export const TABS: { id: Tab; label: string; tip: string }[] = [
  { id: "edit", label: "Edit", tip: "The part you picked, and the design's sizes" },
  { id: "finish", label: "Finish", tip: "Timber and colours" },
  { id: "make", label: "Make", tip: "The workshop drawings, the cut list and the cut layout" },
  { id: "check", label: "Check", tip: "What the checks found, with ways to fix each problem" },
  { id: "history", label: "History", tip: "Every change you or Claude made, with Undo, Redo and Restore" },
];

/** The eleven panels the side panel had, each still somewhere. */
export type Panel = "part" | "params" | "finish" | "cut" | "layout" | "problems" | "history" | "versions" | "designs" | "library" | "requests";

/** What each tab holds, top to bottom. Make holds its two as a switch. */
export const TAB_PANELS: Record<Tab, Panel[]> = {
  edit: ["part", "params"],
  finish: ["finish"],
  make: ["cut", "layout"],
  check: ["problems"],
  history: ["history", "versions"],
};

/** The sections of the All designs and parts page, in order. Your workshop is new, so it was never one of the old panels. */
export type Section = "designs" | "library" | "tools" | "workshop";
export const ALL_SECTIONS: { id: Section; label: string; panel: Panel | "workshop" }[] = [
  { id: "designs", label: "Designs", panel: "designs" },
  { id: "library", label: "Parts library", panel: "library" },
  { id: "tools", label: "Missing tools", panel: "requests" },
  { id: "workshop", label: "Your workshop", panel: "workshop" },
];

/** Where an old panel lives now: in a tab, or on the All designs and parts page. */
export type Home = { tab: Tab; make?: MakeView } | { page: "all"; section: Section };

export function homeOf(panel: Panel): Home {
  const section = ALL_SECTIONS.find((s) => s.panel === panel);
  if (section) return { page: "all", section: section.id };
  const tab = (Object.keys(TAB_PANELS) as Tab[]).find((t) => TAB_PANELS[t].includes(panel))!;
  if (tab === "make") return { tab, make: panel === "layout" ? "layout" : "list" };
  return { tab };
}

/** Make's two-way switch. */
export type MakeView = "list" | "layout";
export const MAKE_VIEWS: { id: MakeView; label: string }[] = [
  { id: "list", label: "Cut list" },
  { id: "layout", label: "Cut layout" },
];

export const isTab = (v: unknown): v is Tab => TABS.some((t) => t.id === v);

/**
 * The tab a browser remembered, which may be one of the old eleven from
 * before the five. An old one opens where its panel lives now, and anything
 * else opens Edit.
 */
export function readTab(stored: string | null): Tab {
  if (isTab(stored)) return stored;
  const old = (["part", "params", "finish", "cut", "layout", "problems", "history", "versions", "designs", "library", "requests"] as Panel[]).find((p) => p === stored);
  const home = old ? homeOf(old) : null;
  return home && "tab" in home ? home.tab : "edit";
}

export const readMake = (stored: string | null): MakeView => (stored === "layout" ? "layout" : "list");

/**
 * The tab a click on a part opens: Edit, from the model, the cut list or
 * anywhere else. Picking parts while you try colours keeps you in Finish,
 * since a colour goes on what you've picked.
 */
export const tabAfterPick = (current: Tab): Tab => (current === "finish" ? "finish" : "edit");

/** The status pill opens Check. */
export const PILL_TAB: Tab = "check";

/** The count on the Check tab, coloured by the worst problem. */
export function checkCount(report: Pick<ServerState["report"], "issues" | "errors">): { n: number; tone: "bad" | "warn" } | null {
  if (!report.issues.length) return null;
  return { n: report.issues.length, tone: report.errors ? "bad" : "warn" };
}

/** What waits for you on each section of the All designs and parts page. */
export function waitingIn(state: Pick<ServerState, "library" | "tool_requests">): Record<Section, number> {
  return {
    designs: 0,
    library: state.library.proposals.length,
    tools: state.tool_requests.filter((r) => r.status === "open").length,
    workshop: 0,
  };
}

/** What the app does for a view command's drawer and parts to pick, now that the waiting change is drawn on the model. */
export interface Routed {
  /** How the ghost of the waiting change should be left. Undefined leaves it alone. */
  ghost?: GhostPref;
  /** Close the drawer, or open a worked example in it. */
  drawer?: "close" | { joint: JointType };
  /** Parts to pick, and the tab that opens for them or the tab asked for. */
  select?: string[];
  tab?: Tab;
  /** Open the side panel too, as for a tab asked for by name. */
  panel?: boolean;
  /** The 3D view, where the ghost shows. */
  show3d?: boolean;
  /** Said in the window when the command can't do what it asks. */
  note?: string;
}

/**
 * A view command's drawer and highlight. "preview" shows the waiting change
 * on the model, "close" closes the drawer and puts the ghost away, and a
 * joint opens its worked example in the drawer. Parts to pick open Edit, as
 * a click on them does. A tab asked for by name opens, and brings the side
 * panel back if it's folded.
 */
export function routeView(e: Pick<ViewEffects, "drawer" | "select" | "tab">, ctx: { liveId: string | null; pref: GhostPref | null; tab: Tab }): Routed {
  const out: Routed = {};
  if (e.drawer === "preview") {
    if (ctx.liveId) {
      out.ghost = showGhost(ctx.liveId, ctx.pref);
      out.show3d = true;
    } else out.note = "Claude isn't waiting on a suggested change.";
  } else if (e.drawer === "close") {
    out.drawer = "close";
    if (ctx.liveId && ghostShown(ctx.liveId, ctx.pref)) out.ghost = hideGhost(ctx.liveId, ctx.pref);
  } else if (e.drawer) out.drawer = { joint: e.drawer.joint };
  if (e.select) {
    out.select = e.select;
    if (e.select.length) out.tab = tabAfterPick(ctx.tab);
  }
  if (e.tab) {
    out.tab = e.tab;
    out.panel = true;
  }
  return out;
}
