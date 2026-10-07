// The toolbar over the model: one row in three fixed groups. Tools say how
// a click in the model reads, View sets how you look at it, and Share
// sends it out of the app. Every control keeps its slot whatever the look,
// tool or mode, and one that can't act is disabled, never hidden, so a
// habitual click always lands where it did. The phone layout uses the
// same menus under the same names. Kept free of React so the tests can
// hold the structure.

import { ORBIT_SPEED, type ViewCommand } from "@woodchuck/core";
import type { CameraView, Look, PointMode } from "./components/Viewport";
import { LIGHTINGS, type Lighting } from "./lighting";

/** The 3D model, or one large 2D drawing. */
export type Mode = "3d" | "2d";
/** The drawings the 2D view can show. */
export type PlanView = "front" | "top" | "left" | "right" | "iso";
export type Paper = "A4" | "A3";

/** A tooltip with its keyboard shortcut, as every control shows it. */
export const withKey = (tip: string, key?: string) => (key ? `${tip} (${key})` : tip);

export const KEYS = { undo: "⌘Z", redo: "⇧⌘Z", fit: "F", seeThrough: "X", explode: "E", chat: "⌘K", cameras: "1 to 6" } as const;

/** The tooltips of the shortcut controls outside the toolbar. */
export const TIPS = {
  undo: withKey("Undo the last change set", KEYS.undo),
  redo: withKey("Redo the change set you undid", KEYS.redo),
  chat: withKey("The chat box", KEYS.chat),
} as const;

/** Why undo, redo and switching designs are greyed out mid-build. Edits and the chat still work. */
export const WAIT_FOR_CLAUDE = "Claude is working. Wait or stop it first.";

export const TOOLS: { id: PointMode; label: string; key: string; tip: string }[] = [
  { id: "pick", label: "Select", key: "V", tip: "Click a part; shift-click for more" },
  { id: "box", label: "Box", key: "B", tip: "Drag a box to select every part inside it; hold shift to add" },
  { id: "pin", label: "Pin", key: "P", tip: "Click spots on the model to drop numbered pins for Claude" },
  { id: "pan", label: "Pan", key: "H", tip: "Drag to move the view; right-drag rotates" },
];

export const CAMERAS: { id: CameraView; label: string; key: string }[] = [
  { id: "iso", label: "Iso", key: "1" },
  { id: "front", label: "Front", key: "2" },
  { id: "top", label: "Top", key: "3" },
  { id: "left", label: "Left", key: "4" },
  { id: "right", label: "Right", key: "5" },
  { id: "back", label: "Back", key: "6" },
];

export const PLAN_VIEWS: { id: PlanView; label: string }[] = [
  { id: "front", label: "Front" },
  { id: "top", label: "Top" },
  { id: "left", label: "Left" },
  { id: "right", label: "Right" },
  { id: "iso", label: "Iso" },
];

export const isPlanView = (v: string): v is PlanView => PLAN_VIEWS.some((p) => p.id === v);

/** What the toolbar draws from: the window's view settings and the design's state. */
export interface ToolbarState {
  mode: Mode;
  pointMode: PointMode;
  view: CameraView;
  xray: boolean;
  look: Look;
  lighting: Lighting;
  /** The design sits in its room photo now. */
  inPhoto: boolean;
  /** A room photo is kept with the design. */
  hasPhoto: boolean;
  /** The view fills the window, with the chat and panels put away. */
  full: boolean;
  /** The design has no parts yet. */
  empty: boolean;
  paper: Paper;
  /** The piece, or one of its joints, is pulled apart. */
  exploded: boolean;
  /** A suggested change is drawn on the model, which shows the piece together. */
  ghost: boolean;
}

export interface Control {
  id: string;
  label: string;
  /** The tooltip, with the shortcut when there is one. A disabled control's tip says why. */
  tip: string;
  key?: string;
  disabled: boolean;
  /** A toggle or a choice that's on. */
  on?: boolean;
}

export type GroupId = "tools" | "view" | "share";
export interface Group {
  id: GroupId;
  label: string;
  controls: Control[];
}

const IN_2D = "This works in the 3D view. Choose 3D in the Look menu to go back.";
const NOTHING_YET = "Ask Claude to build something first.";

/** The row of controls, in its three groups, always in this order. */
export function toolbar(s: ToolbarState): Group[] {
  const flat = s.mode === "2d";
  const camera = CAMERAS.find((c) => c.id === s.view) ?? CAMERAS[0]!;
  return [
    {
      id: "tools",
      label: "Tools",
      controls: TOOLS.map((t) => ({
        id: `tool.${t.id}`,
        label: t.label,
        key: t.key,
        tip: flat ? IN_2D : withKey(t.tip, t.key),
        disabled: flat,
        on: s.pointMode === t.id,
      })),
    },
    {
      id: "view",
      label: "View",
      controls: [
        {
          id: "camera",
          label: camera.label,
          key: KEYS.cameras,
          tip: flat ? "Pick a drawing above the 2D view, or choose 3D in the Look menu." : withKey("Look from the front, top, a side, the back or a corner", KEYS.cameras),
          disabled: flat,
        },
        { id: "fit", label: "Fit", key: KEYS.fit, tip: flat ? IN_2D : withKey("Bring the whole model back into view", KEYS.fit), disabled: flat },
        {
          id: "see-through",
          label: "See-through",
          key: KEYS.seeThrough,
          tip: s.empty && !s.xray ? `Nothing to see through yet. ${NOTHING_YET}` : withKey("Show how the joints go together", KEYS.seeThrough),
          disabled: s.empty && !s.xray,
          on: s.xray,
        },
        explodeControl(s),
        { id: "look", label: "Look", tip: "Plain or Finished, the lighting, and the 3D or 2D views", disabled: false },
      ],
    },
    { id: "share", label: "Share", controls: [{ id: "share", label: "Share", tip: "Render, Photo, Full screen and the workshop drawings", disabled: false }] },
  ];
}

/** Explode, which pulls the piece apart. It works only on the 3D model as it is, so the plan views, the room photo and a suggested change hold it together. */
function explodeControl(s: ToolbarState): Control {
  const why = s.mode === "2d" ? IN_2D : s.inPhoto ? "The room photo shows the piece together." : s.ghost ? "A suggested change shows on the piece together. Answer it or hide it first." : s.empty ? `Nothing to pull apart yet. ${NOTHING_YET}` : null;
  return {
    id: "explode",
    label: "Explode",
    key: KEYS.explode,
    tip: why ?? withKey("Pull the piece apart the way it goes together, with a slider to put it back", KEYS.explode),
    disabled: why !== null,
    on: s.exploded && why === null,
  };
}

/**
 * The toolbar folded into four buttons, for a phone or a narrow window:
 * Select, Fit, Look and Share. Select opens the four tools and shows the
 * one that's on. The camera views, See-through and Explode move into
 * Look's menu.
 */
export function compactToolbar(s: ToolbarState): Control[] {
  const [tools, view, share] = toolbar(s);
  const tool = tools!.controls.find((c) => c.on) ?? tools!.controls[0]!;
  const byId = new Map(view!.controls.map((c) => [c.id, c]));
  return [
    { id: "tools", label: tool.label, tip: s.mode === "2d" ? IN_2D : "Select, Box, Pin or Pan", disabled: s.mode === "2d" },
    byId.get("fit")!,
    byId.get("look")!,
    share!.controls[0]!,
  ];
}

/** The camera menu: one choice, with its number key. */
export function cameraMenu(s: ToolbarState): Control[] {
  return CAMERAS.map((c) => ({ id: `camera.${c.id}`, label: c.label, key: c.key, tip: withKey(`The ${c.id === "iso" ? "corner" : c.id} view`, c.key), disabled: s.mode === "2d", on: s.view === c.id }));
}

export interface MenuSection {
  id: "look" | "lighting" | "views";
  label: string;
  items: Control[];
  /** Why a section's choices are off, when they are. */
  note?: string;
}

/** The Look menu: Plain or Finished, the lighting, and 3D or the 2D views. */
export function lookMenu(s: ToolbarState): MenuSection[] {
  const flat = s.mode === "2d";
  const finished = s.look === "finished" || s.inPhoto;
  const lit = finished && !flat;
  return [
    {
      id: "look",
      label: "Look",
      items: [
        {
          id: "look.plain",
          label: "Plain",
          tip: s.inPhoto ? "A photo always shows the Finished look" : "Plain colours for working on the design",
          disabled: flat || s.inPhoto,
          on: !finished,
        },
        { id: "look.finished", label: "Finished", tip: "The timber and its finish, under real light", disabled: flat, on: finished },
      ],
      ...(flat ? { note: "Plain and Finished are for the 3D view." } : {}),
    },
    {
      id: "lighting",
      label: "Lighting",
      items: LIGHTINGS.map((l) => ({ id: `lighting.${l.id}`, label: l.label, tip: l.tip, disabled: !lit, on: s.lighting === l.id })),
      ...(lit ? {} : { note: flat ? "Lighting is for the 3D view." : "Lighting shows in the Finished look." }),
    },
    {
      id: "views",
      label: "Views",
      items: [
        { id: "views.3d", label: "3D", tip: "The model, to turn and pick parts in", disabled: false, on: !flat },
        { id: "views.2d", label: "2D views", tip: "One large drawing at a time, with its sizes", disabled: false, on: flat },
      ],
    },
  ];
}

/** The Share menu: a picture, the room photo, full screen and the workshop drawings. */
export function shareMenu(s: ToolbarState): Control[] {
  const flat = s.mode === "2d";
  return [
    {
      id: "share.render",
      label: "Render",
      tip: s.empty
        ? `Nothing to render yet. ${NOTHING_YET}`
        : flat
          ? "Save the plan views as a picture"
          : s.inPhoto
            ? "Save the photo with the design in it"
            : "Save a full-size picture of this view",
      disabled: s.empty,
    },
    {
      id: "share.photo",
      label: "Photo",
      tip: s.empty && !s.inPhoto ? `Nothing to place in a photo yet. ${NOTHING_YET}` : s.hasPhoto ? "Place the design in your photo of the room" : "Load a photo of the room to place the design in",
      disabled: s.empty && !s.inPhoto,
      on: s.inPhoto,
    },
    { id: "share.full", label: "Full screen", tip: s.full ? "Bring back the chat and panels (Esc)" : "Fill the screen with the view", disabled: false, on: s.full },
    {
      id: "share.drawings",
      label: "Workshop drawings (PDF)",
      tip: s.empty ? `Nothing to draw yet. ${NOTHING_YET}` : `Plans, a drawing of each part, and the cut, drilling and hardware lists, on ${s.paper} to print at 100%`,
      disabled: s.empty,
    },
  ];
}

/** Every control the toolbar and its menus hold, by id. */
export function allControls(s: ToolbarState): Map<string, Control> {
  const all = [...toolbar(s).flatMap((g) => g.controls), ...cameraMenu(s), ...lookMenu(s).flatMap((m) => m.items), ...shareMenu(s)];
  return new Map(all.map((c) => [c.id, c]));
}

/**
 * Where each part of a view command from outside the window lands: the
 * control that shows it, or a menu's choices by their shared prefix. Turn,
 * zoom, an orbit and the parts to pick act on the model itself, the
 * drawer is its own, and a tab opens in the side panel's tab bar. Typed so a new kind of command can't arrive without a home.
 */
export const ROUTES: Record<Exclude<keyof ViewCommand, "from" | "note">, string> = {
  mode: "views",
  look: "look",
  lighting: "lighting",
  view: "camera",
  fit: "fit",
  turn: "canvas",
  zoom: "canvas",
  orbit: "canvas",
  orbitSpeed: "canvas",
  seeThrough: "see-through",
  explode: "explode",
  focusJoint: "explode",
  photo: "share.photo",
  photoLens: "share.photo",
  photoShadow: "share.photo",
  blend: "share.photo",
  render: "share.render",
  fill: "share.full",
  select: "canvas",
  drawer: "drawer",
  tab: "tabs",
};

/** The view settings a command from outside can change. */
export interface ViewState {
  mode: Mode;
  look: Look;
  lighting: Lighting;
  view: CameraView;
  planView: PlanView;
  xray: boolean;
  /** Placed in the room photo. */
  photo: boolean;
  full: boolean;
  /** How far the piece is pulled apart, from 0, together, to 1. */
  explode: number;
  /** The joint pulled apart on its own, or null for the whole piece. */
  focusJoint: string | null;
}

/** What a command asks of the window beyond its settings. */
export interface ViewEffects {
  /** Frame the whole model again. */
  refit: boolean;
  nudge: { turn: number; zoom: number } | null;
  /** Start turning the model at this many degrees a second, stop it, or leave it as it is (null). */
  orbit: number | "stop" | null;
  render: boolean;
  select: string[] | null;
  drawer: ViewCommand["drawer"] | null;
  /** The side panel tab to open, with the panel. */
  tab: ViewCommand["tab"] | null;
  /** A joint to frame, pulled apart. */
  focus: string | null;
}

/**
 * A view command applied to the window's settings. A command shows the 3D
 * view unless it asks for the plan views, as it always has, but one that
 * only stops an orbit or opens a tab leaves the view as it is. A tab brings
 * the panels back when the 3D view fills the window. Asking for the Finished
 * look's lighting brings the Finished look, since lighting only shows
 * there. A camera view with the plan views picks that drawing too. An
 * orbit stops for a camera view, the plan views or the room photo, as it
 * does when you choose them yourself. A joint to focus on comes fully
 * apart unless the command says how far, and going back to the whole
 * piece puts it together, as an explode of 0 does. Pulling it apart puts
 * the room photo away, and the room photo puts it together.
 */
export function applyView(s: ViewState, v: ViewCommand, hasPhoto: boolean): { state: ViewState; effects: ViewEffects } {
  const keepsMode =
    (v.orbit === "stop" || !!v.tab) && Object.keys(v).every((k) => k === "from" || k === "note" || k === "tab" || (k === "orbit" && v.orbit === "stop"));
  const next: ViewState = { ...s, mode: v.mode === "plan" ? "2d" : keepsMode ? s.mode : "3d" };
  if (v.seeThrough !== undefined) next.xray = v.seeThrough;
  if (v.photo !== undefined) next.photo = v.photo && hasPhoto;
  if (v.look) next.look = v.look;
  else if (v.lighting) next.look = "finished";
  if (v.lighting) next.lighting = v.lighting;
  if (v.view) {
    next.view = v.view;
    if (next.mode === "2d" && isPlanView(v.view)) next.planView = v.view;
  }
  if (v.fill !== undefined) next.full = v.fill;
  if (v.tab) next.full = false;
  if (v.focusJoint !== undefined) {
    next.focusJoint = v.focusJoint || null;
    next.explode = v.explode ?? (v.focusJoint ? 1 : 0);
  } else if (v.explode !== undefined) {
    next.explode = v.explode;
    if (v.explode === 0) next.focusJoint = null;
  }
  // The blend relights the piece in its photo, so the photo shows.
  if (v.blend && hasPhoto) next.photo = true;
  if (next.photo && hasPhoto && (v.photo || v.blend)) {
    next.explode = 0;
    next.focusJoint = null;
  } else if (next.explode > 0 && (v.explode !== undefined || v.focusJoint)) next.photo = false;
  return {
    state: next,
    effects: {
      refit: !!(v.view || v.fit),
      nudge: v.turn || v.zoom ? { turn: v.turn ?? 0, zoom: v.zoom ?? 1 } : null,
      orbit: v.orbit === "start" ? (v.orbitSpeed ?? ORBIT_SPEED.default) : v.orbit === "stop" || v.view || next.mode === "2d" || (v.photo && hasPhoto) ? "stop" : null,
      render: !!v.render,
      select: v.select ?? null,
      drawer: v.drawer ?? null,
      tab: v.tab ?? null,
      focus: next.focusJoint && v.focusJoint ? next.focusJoint : null,
    },
  };
}

/** The toolbar's view of a window's settings. */
export function toolbarState(
  v: ViewState,
  rest: { pointMode: PointMode; hasPhoto: boolean; empty: boolean; paper: Paper; ghost?: boolean; exploded?: boolean },
): ToolbarState {
  return {
    mode: v.mode,
    pointMode: rest.pointMode,
    view: v.view,
    xray: v.xray,
    look: v.look,
    lighting: v.lighting,
    inPhoto: v.photo && rest.hasPhoto && v.mode === "3d",
    hasPhoto: rest.hasPhoto,
    full: v.full,
    empty: rest.empty,
    paper: rest.paper,
    exploded: rest.exploded ?? (v.explode > 0 || v.focusJoint !== null),
    ghost: !!rest.ghost,
  };
}
