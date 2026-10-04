// Following Claude, tab by tab. While Claude works and you haven't touched
// anything since its turn began, the screen goes where Claude is working.
// A run of steps in one tab is one stop, and each stop stays on screen for
// at least DWELL_MS, so a turn of sixty edits doesn't jitter. Falling
// behind, it skips to Claude's latest few stops. Any touch ends it for the
// rest of the turn, and nothing moves after that. Show me how plays a past
// turn's stops the same way, slower, and a step's link shows one stop.
// Kept free of React, with the time passed in, so the tests can hold it.

import { describe, tabOf, type Described, type FinishSeen, type Lookup, type Place } from "./follow";
import type { MakeView, Tab } from "./tabs";

/** The least time a tab stays on screen while following. */
export const DWELL_MS = 1200;
/** Show me how goes slower. */
export const REPLAY_DWELL_MS = 2000;
/** How long the last stop stays lit once Claude's turn is over. */
export const LINGER_MS = 2500;
/** How long a step's link keeps its control lit. */
export const STEP_MS = 4000;
/** How many stops following keeps waiting, so it never trails Claude by much. */
export const MAX_BEHIND = 3;

/** One stop: a run of Claude's steps in one tab. */
export interface Stop {
  /** Counts up with each new stop, so a stop that grew isn't taken for a new one. */
  n: number;
  /** The tab, with Make's switch, or the place outside the side panel. */
  key: string;
  places: Place[];
  /** Parts the design showed moving under this stop's steps. */
  moved: string[];
  /** It has steps the design hasn't come back with yet. */
  fresh: boolean;
  /** When it came on screen. */
  at: number;
}

export type FollowMode = "live" | "replay" | "step";

export interface Follow {
  mode: FollowMode;
  /** False once you've touched anything, or it has played out. */
  on: boolean;
  shown: Stop | null;
  queue: Stop[];
  /** Claude's turn is over, or every step is already queued. */
  ended: boolean;
  /** When Claude's turn ended, so the last stop lingers after it. */
  endedAt: number;
  dwell: number;
  /** The last stop number given out. */
  n: number;
}

export const IDLE: Follow = { mode: "live", on: false, shown: null, queue: [], ended: true, endedAt: 0, dwell: DWELL_MS, n: 0 };

export function keyOf(place: Pick<Place, "area">): string {
  const { tab, make } = tabOf(place);
  return tab ? `${tab}${make ? `:${make}` : ""}` : place.area;
}

/** Puts a step on the stop it belongs to: the one on screen, the last waiting, or a new one. */
function add(f: Follow, place: Place, now: number, cap: number): Follow {
  const key = keyOf(place);
  if (!f.shown && !f.queue.length) {
    const n = f.n + 1;
    return { ...f, n, shown: { n, key, places: [place], moved: [], fresh: true, at: now } };
  }
  const last = f.queue.at(-1);
  if (!last && f.shown?.key === key) return { ...f, shown: { ...f.shown, places: [...f.shown.places, place], fresh: true } };
  if (last?.key === key) return { ...f, queue: [...f.queue.slice(0, -1), { ...last, places: [...last.places, place], fresh: true }] };
  const n = f.n + 1;
  const queue = [...f.queue, { n, key, places: [place], moved: [], fresh: true, at: now }];
  return { ...f, n, queue: queue.length > cap ? queue.slice(-cap) : queue };
}

/**
 * Claude's turn has begun, with nothing touched. Each start carries on
 * the stop numbers from what came before, so every stop is told apart.
 */
export function startLive(prev: Follow): Follow {
  return { ...IDLE, n: prev.n, mode: "live", on: true, ended: false };
}

/** A step Claude just took. Only live following takes them, and only until you touch something. */
export function push(f: Follow, place: Place, now: number): Follow {
  if (!f.on || f.mode !== "live") return f;
  return add(f, place, now, MAX_BEHIND);
}

/** Show me how: a past turn's steps, all queued at once, played slowly in order. */
export function startReplay(prev: Follow, places: Place[], now: number): Follow {
  let f: Follow = { ...IDLE, n: prev.n, mode: "replay", on: true, ended: true, dwell: REPLAY_DWELL_MS };
  for (const p of places) f = add(f, p, now, Infinity);
  return f.shown ? f : { ...IDLE, n: prev.n };
}

/** A step's link in the chat: one stop, lit for a few seconds. */
export function showStep(prev: Follow, place: Place, now: number): Follow {
  return add({ ...IDLE, n: prev.n, mode: "step", on: true, ended: true, dwell: STEP_MS }, place, now, 1);
}

/** The latest stop that passes the test, waiting or on screen, changed by fn. */
function latest(f: Follow, test: (s: Stop) => boolean, fn: (s: Stop) => Stop): Follow {
  for (let i = f.queue.length - 1; i >= 0; i--) {
    if (test(f.queue[i]!)) return { ...f, queue: f.queue.map((s, k) => (k === i ? fn(s) : s)) };
  }
  if (f.shown && test(f.shown)) return { ...f, shown: fn(f.shown) };
  return f;
}

/** The steps that move parts: sizes, parts and a material's thickness. */
const MOVES = new Set(["sizes", "part", "layout"]);

/** What the design showed a finish doing, put on Claude's latest finish step. */
export function seeFinish(f: Follow, seen: FinishSeen[]): Follow {
  const main = seen[0];
  if (!f.on || f.mode !== "live" || !main) return f;
  return latest(f, (s) => s.key === "finish", (s) => {
    let i = s.places.findLastIndex((p) => p.tool === "set_finish" && !p.finish);
    if (i < 0) i = s.places.findLastIndex((p) => p.tool === "set_finish");
    if (i < 0) return s;
    return { ...s, places: s.places.map((p, k) => (k === i ? { ...p, finish: main } : p)) };
  });
}

/**
 * The design came back from the server, with the parts that moved. They're
 * framed with the first stop whose steps move parts and that the design
 * hadn't come back for yet. With no such stop, the camera stays put, so a
 * late move never pulls it away from a stop that moved nothing.
 */
export function seeMoved(f: Follow, parts: string[]): Follow {
  if (!f.on || f.mode !== "live") return f;
  const all = [...(f.shown ? [f.shown] : []), ...f.queue];
  if (!all.some((s) => s.fresh)) return f;
  const first = all.find((s) => s.fresh && s.places.some((p) => MOVES.has(p.area)));
  const settle = (s: Stop): Stop => ({ ...s, fresh: false, moved: parts.length && s === first ? [...new Set([...s.moved, ...parts])] : s.moved });
  return { ...f, shown: f.shown && settle(f.shown), queue: f.queue.map(settle) };
}

/** Claude's turn is over. What's waiting still plays, then the last stop lingers and goes. */
export function endTurn(f: Follow, now: number): Follow {
  return f.mode === "live" && !f.ended ? { ...f, ended: true, endedAt: now } : f;
}

/** You touched something: nothing more moves, and the highlight goes. */
export function touch(f: Follow): Follow {
  return f.on ? { ...f, on: false, shown: null, queue: [] } : f;
}

/** Moves on to the next stop once the one on screen has had its time, and finishes once all have. */
export function tick(f: Follow, now: number): Follow {
  if (!f.on) return f;
  const next = f.queue[0];
  if (next) {
    if (f.shown && now - f.shown.at < f.dwell) return f;
    return { ...f, shown: { ...next, at: now }, queue: f.queue.slice(1) };
  }
  if (!f.ended) return f;
  if (f.shown && now < goneAt(f, f.shown)) return f;
  return { ...f, on: false, shown: null };
}

/** When the last stop goes: a step's link after its own time, Show me how after a linger, and following a linger after Claude's turn ends. */
function goneAt(f: Follow, last: Stop): number {
  if (f.mode === "step") return last.at + f.dwell;
  if (f.mode === "replay") return last.at + Math.max(f.dwell, LINGER_MS);
  return Math.max(last.at + f.dwell, f.endedAt + LINGER_MS);
}

/** When tick has something to do next, or null when it waits on Claude or is done. */
export function nextAt(f: Follow): number | null {
  if (!f.on) return null;
  if (f.queue.length) return f.shown ? f.shown.at + f.dwell : 0;
  if (!f.ended) return null;
  return f.shown ? goneAt(f, f.shown) : 0;
}

/** The chip over the 3D view: "Following Claude · stop" while following, or Show me how's own words. */
export function chipFor(f: Follow): "live" | "replay" | null {
  if (!f.on || f.mode === "step") return null;
  return f.mode;
}

/** A stop as the screen shows it: its tab, what lights, what's picked and framed, and its caption. */
export interface StopView extends Described {
  n: number;
  /** Steps in this stop besides the one the caption names. */
  more: number;
  /** The newest step's own mark, to scroll into view. */
  focus: string | null;
}

export function stopView(stop: Stop, look: Lookup): StopView {
  const all = stop.places.map((p) => describe(p, look));
  const last = all.at(-1)!;
  const exists = new Set(look.parts.map((p) => p.id));
  const frame = [...new Set([...all.flatMap((d) => d.frame), ...stop.moved])].filter((id) => exists.has(id));
  return {
    ...last,
    n: stop.n,
    marks: [...new Set(all.flatMap((d) => d.marks))],
    frame,
    more: all.length - 1,
    focus: last.marks.find((m) => !m.startsWith("tab:")) ?? null,
  };
}

/** What a newly shown stop asks of the side panel: its tab and Make's switch, if it has one. Nothing once following is off. */
export function movesFor(f: Follow, applied: number | null): { tab: Tab; make?: MakeView } | null {
  if (!f.on || !f.shown || f.shown.n === applied) return null;
  const place = f.shown.places[0]!;
  const { tab, make } = tabOf(place);
  if (!tab) return null;
  return make ? { tab, make } : { tab };
}

/** Whether the turn starts with you in the middle of something: a press held down, a panel being dragged, or typing in a field other than the chat box. */
export function midTask(now: { held: boolean; dragging: boolean; typing: "chat" | "field" | null }): boolean {
  return now.held || now.dragging || now.typing === "field";
}
