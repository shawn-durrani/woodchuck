// A request to change what an open Woodchuck window shows, sent from
// outside the window, such as from a Crossband chat. It changes only the
// view, never the design: the 3D or plan views, the look, lighting and
// camera, see-through, the room photo, filling the window, which parts
// are picked, what's open in the drawer and which side panel tab is open.
// It can pull the piece apart, or just one of its joints.
// It can also ask the window to save a picture of what it shows, or to keep
// turning the model slowly until it's told to stop.

import { JOINT_LIBRARY } from "./joints.js";
import { JOINT_TYPES, type JointType } from "./types.js";

export const LOOKS = ["plain", "finished"] as const;
export const LIGHTINGS_ALLOWED = ["daylight", "evening", "workshop"] as const;
export const CAMERA_VIEWS = ["iso", "front", "top", "left", "right", "back"] as const;

/**
 * The side panel's five tabs, by the names on screen. Edit holds the picked
 * part and the design's sizes, Finish the timber and colours, Make the
 * drawings, cut list and cut layout, Check the problems, and History every
 * change and version.
 */
export const SIDE_TABS = ["edit", "finish", "make", "check", "history"] as const;
export type SideTab = (typeof SIDE_TABS)[number];
const TAB_LABELS: Record<SideTab, string> = { edit: "Edit", finish: "Finish", make: "Make", check: "Check", history: "History" };

/**
 * How fast an orbit turns the model, in degrees a second. The default is a
 * slow showcase spin, once round in half a minute. Positive turns it to the
 * right, as turn does.
 */
export const ORBIT_SPEED = { default: 12, min: 1, max: 60 } as const;

/** A joint's id, or one array copy's, such as shelf_dado#2. */
const JOINT_ID = /^[a-z][a-z0-9_]*(#[0-9]+)?$/;

export interface ViewCommand {
  /** The 3D view, or the 2D plan views. */
  mode?: "3d" | "plan";
  look?: (typeof LOOKS)[number];
  lighting?: (typeof LIGHTINGS_ALLOWED)[number];
  view?: (typeof CAMERA_VIEWS)[number];
  /** Bring the whole model back into view. */
  fit?: boolean;
  /** Turn the camera around the model by this many degrees; positive turns it to the right. */
  turn?: number;
  /** Move the camera closer (above 1) or further away (below 1) by this factor. */
  zoom?: number;
  /** Keep turning the camera around the model until told to stop, or stop it. */
  orbit?: "start" | "stop";
  /** How fast an orbit turns, in degrees a second; positive turns it to the right. Set whenever orbit is "start". */
  orbitSpeed?: number;
  /** See-through, to show the joints. */
  seeThrough?: boolean;
  /** Pull the piece apart, from 0, together, to 1, fully apart. */
  explode?: number;
  /** Pull one of the design's joints apart on the model, by its id, or "" to go back to the whole piece. */
  focusJoint?: string;
  /** Place the design in its room photo, or take it out. */
  photo?: boolean;
  /** Save a picture of what the window shows, as its Render button does. */
  render?: boolean;
  /** Fill the window with the 3D view (true), or bring the panels back (false). */
  fill?: boolean;
  /** Parts to pick, so they're highlighted. An empty list clears the selection. */
  select?: string[];
  /** Open the waiting preview or a joint example in the drawer, or close it. */
  drawer?: "preview" | "close" | { joint: JointType };
  /** Open this tab of the side panel, bringing the panel back if it's folded. */
  tab?: SideTab;
  /** Who asked, for the note in the window, such as "Crossband". */
  from?: string;
  /** What to say in the window instead of describing the view change. */
  note?: string;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], what: string): T | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (!allowed.includes(v as T)) throw new Error(`${what} "${String(v)}" isn't one of ${allowed.join(", ")}`);
  return v as T;
}

/** Checks a view command from outside. Throws an Error that says what's wrong. */
export function readViewCommand(input: unknown): ViewCommand {
  if (typeof input !== "object" || input === null) throw new Error("Send the view as an object");
  const o = input as Record<string, unknown>;
  const c: ViewCommand = {};
  const mode = oneOf(o.mode, ["3d", "plan"] as const, "mode");
  if (mode) c.mode = mode;
  const look = oneOf(o.look, LOOKS, "look");
  const lighting = oneOf(o.lighting, LIGHTINGS_ALLOWED, "lighting");
  const view = oneOf(o.view, CAMERA_VIEWS, "view");
  if (look) c.look = look;
  if (lighting) c.lighting = lighting;
  if (view) c.view = view;
  if (o.fit === true) c.fit = true;
  if (o.turn !== undefined && o.turn !== null) {
    const t = Number(o.turn);
    if (!Number.isFinite(t) || Math.abs(t) > 360) throw new Error("turn must be a number of degrees between -360 and 360");
    if (t !== 0) c.turn = t;
  }
  if (o.zoom !== undefined && o.zoom !== null) {
    const z = Number(o.zoom);
    if (!Number.isFinite(z) || z < 0.2 || z > 5) throw new Error("zoom must be a factor between 0.2 and 5");
    if (z !== 1) c.zoom = z;
  }
  const orbit = oneOf(o.orbit, ["start", "stop"] as const, "orbit");
  if (o.orbitSpeed !== undefined && o.orbitSpeed !== null) {
    const s = Number(o.orbitSpeed);
    const { min, max } = ORBIT_SPEED;
    if (!Number.isFinite(s) || Math.abs(s) < min || Math.abs(s) > max) {
      throw new Error(`orbitSpeed must be between ${min} and ${max} degrees a second, or -${min} to -${max} to turn left`);
    }
    if (orbit !== "start") throw new Error('orbitSpeed goes with orbit "start"');
    c.orbitSpeed = s;
  }
  if (orbit === "start") {
    // The plan views and a room photo hold the camera still.
    if (mode === "plan") throw new Error("orbit turns the 3D view, so it can't go with the plan views");
    if (o.photo === true) throw new Error("orbit would move the camera off the room photo's line-up");
    c.orbit = "start";
    c.orbitSpeed ??= ORBIT_SPEED.default;
  } else if (orbit) c.orbit = orbit;
  if (typeof o.seeThrough === "boolean") c.seeThrough = o.seeThrough;
  if (o.explode !== undefined && o.explode !== null) {
    const x = Number(o.explode);
    if (!Number.isFinite(x) || x < 0 || x > 1) throw new Error("explode must be between 0, together, and 1, fully apart");
    c.explode = x;
  }
  if (o.focusJoint !== undefined && o.focusJoint !== null) {
    if (typeof o.focusJoint !== "string" || (o.focusJoint !== "" && !JOINT_ID.test(o.focusJoint))) throw new Error('focusJoint must be a joint id from the design, such as "rail_in_leg", or "" for the whole piece');
    c.focusJoint = o.focusJoint;
  }
  // The plan views and a room photo show the piece together.
  if ((c.explode || c.focusJoint) && mode === "plan") throw new Error("explode and focusJoint pull the 3D view apart, so they can't go with the plan views");
  if ((c.explode || c.focusJoint) && o.photo === true) throw new Error("the room photo shows the piece together, so it can't go with explode or focusJoint");
  if (typeof o.photo === "boolean") c.photo = o.photo;
  if (o.render === true) c.render = true;
  if (typeof o.fill === "boolean") c.fill = o.fill;
  if (o.select !== undefined) {
    if (!Array.isArray(o.select) || o.select.some((s) => typeof s !== "string")) throw new Error("select must be a list of part ids");
    c.select = o.select as string[];
  }
  if (o.drawer !== undefined && o.drawer !== null) {
    if (o.drawer === "preview" || o.drawer === "close") c.drawer = o.drawer;
    else if (typeof o.drawer === "object" && JOINT_TYPES.includes((o.drawer as { joint?: JointType }).joint as JointType)) {
      c.drawer = { joint: (o.drawer as { joint: JointType }).joint };
    } else throw new Error(`drawer must be "preview", "close" or {"joint": one of ${JOINT_TYPES.join(", ")}}`);
  }
  const tab = oneOf(o.tab, SIDE_TABS, "tab");
  if (tab) {
    // A tab shows in the side panel, which filling the window hides.
    if (o.fill === true) throw new Error("tab opens the side panel, so it can't go with fill");
    c.tab = tab;
  }
  if (typeof o.from === "string" && o.from.trim()) c.from = o.from.trim().slice(0, 40);
  if (typeof o.note === "string" && o.note.trim()) c.note = o.note.trim().slice(0, 160);
  if (Object.keys(c).filter((k) => k !== "from").length === 0) {
    throw new Error("Say what to change: mode, look, lighting, view, fit, turn, zoom, orbit, seeThrough, explode, focusJoint, photo, fill, select, drawer, tab or render");
  }
  return c;
}

/** The change in a few words, for the note in the window and the tool's reply. */
export function describeView(c: ViewCommand): string {
  const parts: string[] = [];
  if (c.mode) parts.push(c.mode === "plan" ? "the plan views" : "the 3D view");
  if (c.look) parts.push(c.look === "finished" ? "the Finished look" : "the Plain look");
  if (c.lighting) parts.push(`${c.lighting} light`);
  if (c.view) parts.push(c.view === "iso" ? "the iso view" : `the ${c.view} view`);
  if (c.fit) parts.push("the whole model in view");
  if (c.turn) parts.push(`turned ${Math.abs(c.turn)}° to the ${c.turn > 0 ? "right" : "left"}`);
  if (c.zoom) parts.push(c.zoom > 1 ? "zoomed in" : "zoomed out");
  if (c.orbit === "start") {
    const s = c.orbitSpeed ?? ORBIT_SPEED.default;
    parts.push(`the model turning ${Math.abs(s)}° a second to the ${s > 0 ? "right" : "left"}`);
  } else if (c.orbit === "stop") parts.push("the model held still");
  if (c.seeThrough !== undefined) parts.push(c.seeThrough ? "see-through on" : "see-through off");
  const apart = (x: number) => (x === 0 ? "back together" : x === 1 ? "pulled apart" : "partly pulled apart");
  if (c.focusJoint) parts.push(`joint ${c.focusJoint} ${apart(c.explode ?? 1)}, with its section and sizes`);
  else if (c.focusJoint === "") parts.push(`the whole piece ${apart(c.explode ?? 0)}`);
  else if (c.explode !== undefined) parts.push(`the piece ${apart(c.explode)}`);
  if (c.photo !== undefined) parts.push(c.photo ? "the room photo" : "the photo put away");
  if (c.fill === true) parts.push("the 3D view filling the window");
  if (c.fill === false) parts.push("the panels back");
  if (c.select) parts.push(c.select.length ? `${c.select.slice(0, 3).join(", ")}${c.select.length > 3 ? ` and ${c.select.length - 3} more` : ""} picked` : "nothing picked");
  if (c.drawer === "preview") parts.push("the waiting preview open");
  else if (c.drawer === "close") parts.push("the drawer closed");
  else if (c.drawer) parts.push(`a worked ${JOINT_LIBRARY[c.drawer.joint].name.toLowerCase()} open`);
  if (c.tab) parts.push(`the ${TAB_LABELS[c.tab]} tab open`);
  const said = parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  if (c.render) return said ? `${said}, then a picture saved` : "a picture saved";
  return said;
}
