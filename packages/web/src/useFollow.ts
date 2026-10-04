// Following Claude on the page. The hook watches Claude's steps arrive in
// the chat and the design change under them, and moves the screen through
// the same state the side panel already uses: the open tab, Make's switch,
// whether the panel is open, the picked parts and the camera's frame. It
// lights the control Claude used, and any touch, click, key or focus in
// the app stops it for the rest of the turn. Show me how and a step's link
// in the chat go through it too. The decisions live in follow.ts and
// following.ts, which the tests hold.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Box, Design } from "@woodchuck/core";
import type { ChatItem, ServerState } from "./api";
import { boxOf } from "./checkFixes";
import { finishChanges, lookupOf, markSelector, movedParts, placeOf, type FinishSeen, type Place, type ToolLine } from "./follow";
import {
  chipFor,
  endTurn,
  IDLE,
  midTask,
  movesFor,
  nextAt,
  push,
  seeFinish,
  seeMoved,
  showStep,
  startLive,
  startReplay,
  stopView,
  tick,
  touch,
  type Follow,
} from "./following";
import type { MakeView, Tab } from "./tabs";

/** How following moves the screen: the same calls the app's own controls make. */
export interface FollowMoves {
  /** Opens a side panel tab, with Make's switch, as a click on the tab does, and opens the panel. */
  openTab: (tab: Tab, make?: MakeView) => void;
  /** Picks parts, as a click on them does. */
  pick: (ids: string[]) => void;
  /** Gives back the parts and faces you had picked before following picked its own. */
  restore: (picked: Picked) => void;
  /** Frames a box in the 3D view, as Show me does. */
  frame: (box: Box) => void;
  /** A short note over the 3D view. */
  note: (text: string) => void;
}

/** What you have picked: whole parts or single faces. */
export interface Picked {
  selection: string[];
  faces: string[];
}

/** The per-browser setting, on unless turned off. */
const SETTING = "woodchuck.follow";

function readSetting(): boolean {
  try {
    return localStorage.getItem(SETTING) !== "off";
  } catch {
    return true;
  }
}

/** A modifier on its own, as when switching apps, isn't a touch. */
const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn", "OS"]);

/** Where the keyboard is: in the chat box, in another field, or neither. A slider or a button isn't typing. */
function typingIn(el: Element | null): "chat" | "field" | null {
  if (!(el instanceof HTMLElement)) return null;
  const field = el.matches(
    'textarea, select, [contenteditable="true"], input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="button"]):not([type="submit"]):not([type="file"])',
  );
  if (!field) return null;
  return el.closest(".composer") ? "chat" : "field";
}

/** Marks the controls to light, and unmarks the rest. React leaves the attribute alone, so it survives a re-render. */
function light(marks: string[]) {
  const want = new Set<Element>();
  for (const m of marks) document.querySelectorAll(markSelector(m)).forEach((el) => want.add(el));
  document.querySelectorAll("[data-follow-lit]").forEach((el) => {
    if (!want.has(el)) el.removeAttribute("data-follow-lit");
  });
  want.forEach((el) => {
    if (!el.hasAttribute("data-follow-lit")) el.setAttribute("data-follow-lit", "");
  });
}

const NONE: string[] = [];
type Tool = Extract<ChatItem, { kind: "tool" }>;
type Said = Extract<ChatItem, { kind: "user" }>;

export function useFollow(state: ServerState | null, picked: Picked, moves: FollowMoves) {
  const [f, setF] = useState<Follow>(IDLE);
  const [enabled, setEnabledState] = useState(readSetting);
  const fRef = useRef(f);
  fRef.current = f;
  const movesRef = useRef(moves);
  movesRef.current = moves;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const stateRef = useRef(state);
  stateRef.current = state;
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  /** What you had picked before following or Show me how picked parts, and what they picked. */
  const borrowed = useRef<{ before: Picked; mine: string } | null>(null);
  /** The last state looked at, the tool lines already taken, and the design as the turn began. */
  const seen = useRef<ServerState | null>(null);
  const handled = useRef(new Set<string>());
  const before = useRef<Design | null>(null);
  /** A press is down somewhere in the page. */
  const held = useRef(false);
  /** What the design showed each of Claude's finishes doing, by its chat line, for Show me how later. */
  const finishSeen = useRef(new Map<string, FinishSeen>());
  const lastFinish = useRef<string | null>(null);

  const setEnabled = useCallback((on: boolean) => {
    setEnabledState(on);
    try {
      localStorage.setItem(SETTING, on ? "on" : "off");
    } catch {
      // Storage can be refused; the setting just won't be remembered.
    }
    if (!on) setF((g) => (g.mode === "live" ? touch(g) : g));
  }, []);

  useEffect(() => {
    const down = () => (held.current = true);
    const up = () => (held.current = false);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    window.addEventListener("blur", up);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      window.removeEventListener("blur", up);
    };
  }, []);

  // Claude's turn beginning and ending, each step it takes, and what the design shows changing.
  useEffect(() => {
    if (!state) return;
    const was = seen.current;
    seen.current = state;
    const lines = state.chat.filter((c): c is Tool | Said => c.kind === "tool" || c.kind === "user");
    if (!was || was.project.slug !== state.project.slug) {
      // A design you've just opened shows as it is.
      handled.current = new Set(lines.map((c) => c.id));
      if (was) setF((g) => touch(g));
      return;
    }
    const now = Date.now();
    const fresh = lines.filter((c) => !handled.current.has(c.id));
    for (const c of fresh) handled.current.add(c.id);
    // A turn begins with your message, or when the server says Claude is busy, whichever this window sees first.
    // A message sent while Claude works is part of the turn it was sent into.
    if ((state.busy && !was.busy) || fresh.some((c) => c.kind === "user" && !c.during)) {
      const quiet =
        enabledRef.current &&
        !midTask({ held: held.current, dragging: document.body.classList.contains("dragging"), typing: typingIn(document.activeElement) });
      const going = fRef.current;
      if (!(going.mode === "live" && going.on && !going.ended)) before.current = was.design;
      setF((g) => {
        // Following that's already under way carries on, and so does Show me how or a step's link.
        if (g.on && (g.mode !== "live" || !g.ended)) return g;
        return quiet ? startLive(g) : { ...IDLE, n: g.n };
      });
    }
    const places = fresh.filter((c): c is Tool => c.kind === "tool").map(placeOf).filter((p): p is Place => p !== null);
    // A whole state from the server, not just a chat line, says whether Claude is still busy.
    const whole = was.design !== state.design;
    const finishes = whole ? finishChanges(was.design.finishes, state.design.finishes) : [];
    for (const p of places) if (p.tool === "set_finish" && p.line) lastFinish.current = p.line;
    if (finishes[0] && lastFinish.current) {
      finishSeen.current.set(lastFinish.current, finishes[0]);
      lastFinish.current = null;
    }
    const moved = was.derived !== state.derived ? movedParts(was.derived.parts, state.derived.parts) : [];
    const ended = !state.busy && (was.busy || whole);
    if (!places.length && !whole && !ended) return;
    setF((g) => {
      let h = g;
      for (const p of places) h = push(h, p, now);
      h = seeFinish(h, finishes);
      h = seeMoved(h, moved);
      return ended ? endTurn(h, now) : h;
    });
  }, [state]);

  // Each stop has its time on screen, then the next comes on.
  useEffect(() => {
    const at = nextAt(f);
    if (at === null) return;
    const t = setTimeout(() => setF((g) => tick(g, Date.now())), Math.max(0, at - Date.now()) + 10);
    return () => clearTimeout(t);
  }, [f]);

  /** Stops following, with a note while Claude carries on, unless quiet. */
  const stop = useCallback((quiet = false) => {
    const g = fRef.current;
    if (!g.on) return;
    setF((h) => touch(h));
    if (g.mode === "live" && stateRef.current?.busy && !quiet) movesRef.current.note("Stopped following. Claude is still working.");
  }, []);

  // Hands on: any touch, click, wheel, key or focus in the app stops it, except the chip's own stop.
  const watching = f.on;
  useEffect(() => {
    if (!watching) return;
    /** What had the focus when the window lost it, which gets it back without a touch. */
    let away: Element | null = null;
    const leave = () => (away = document.activeElement);
    const hands = (e: Event) => {
      if (!e.isTrusted) return;
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest("[data-follow-stop]")) return;
      if (e instanceof KeyboardEvent && MODIFIERS.has(e.key)) return;
      if (e.type === "focusin" && t && t === away) {
        away = null;
        return;
      }
      // Stopping Claude itself, from the chat box, needs no note about following.
      stop(!!t?.closest(".composer button"));
    };
    const events = ["pointerdown", "wheel", "keydown", "focusin"] as const;
    for (const type of events) document.addEventListener(type, hands, { capture: true, passive: true });
    window.addEventListener("blur", leave);
    return () => {
      for (const type of events) document.removeEventListener(type, hands, { capture: true });
      window.removeEventListener("blur", leave);
    };
  }, [watching, stop]);

  const look = useMemo(
    () => (state ? lookupOf(state, before.current) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state?.design, state?.derived],
  );
  const view = f.on && f.shown && look ? stopView(f.shown, look) : null;
  const shownN = view?.n ?? null;

  // A new stop opens its tab, as a click on the tab would.
  const applied = useRef<number | null>(null);
  useEffect(() => {
    const m = movesFor(fRef.current, applied.current);
    applied.current = shownN;
    if (m) movesRef.current.openTab(m.tab, m.make);
  }, [shownN]);

  // The parts Claude worked on are picked, as a click on them picks them.
  const pickKey = view ? view.pick.join("\n") : "";
  useEffect(() => {
    if (!pickKey) return;
    // A step's link keeps its pick, as Show me does. Following and Show me how give yours back when they end.
    if (fRef.current.mode !== "step") borrowed.current = { before: borrowed.current?.before ?? pickedRef.current, mine: pickKey };
    movesRef.current.pick(pickKey.split("\n"));
  }, [pickKey, shownN]);
  useEffect(() => {
    const b = borrowed.current;
    if (f.on || !b) return;
    borrowed.current = null;
    // Only if the pick is still the one following made, so a part you've clicked since stays picked.
    const now = pickedRef.current;
    if (!now.faces.length && now.selection.join("\n") === b.mine) movesRef.current.restore(b.before);
  }, [f.on]);

  // The camera glides to frame them, a moment after they settle, and never during a drag.
  const frameKey = view ? view.frame.join("\n") : "";
  useEffect(() => {
    if (!frameKey) return;
    const t = setTimeout(() => {
      if (!fRef.current.on || held.current || document.body.classList.contains("dragging")) return;
      const box = stateRef.current ? boxOf(stateRef.current.derived.parts, frameKey.split("\n")) : null;
      if (box) movesRef.current.frame(box);
    }, 300);
    return () => clearTimeout(t);
  }, [frameKey]);

  // The control Claude used lights pink, after every render, since a tab's controls come and go.
  const marks = view?.marks ?? NONE;
  useLayoutEffect(() => light(marks));
  useEffect(() => () => light(NONE), []);

  // The newest one scrolls into view in the side panel.
  const focus = view?.focus ?? null;
  useEffect(() => {
    if (!focus || focus.startsWith("control:")) return;
    const t = setTimeout(() => document.querySelector(markSelector(focus))?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 150);
    return () => clearTimeout(t);
  }, [focus, shownN]);

  /** A finish step with what the design showed it doing, when this window saw it happen. */
  const remembered = useCallback((p: Place): Place => {
    const seen = p.line && !p.finish ? finishSeen.current.get(p.line) : undefined;
    return seen ? { ...p, finish: seen } : p;
  }, []);

  return {
    /** The per-browser setting, "Follow Claude while it works". */
    enabled,
    setEnabled,
    /** What the chip over the 3D view says, if it shows. */
    chip: chipFor(f),
    /** The stop on screen: its caption, what's lit, picked and framed. */
    view,
    /** The chip's stop. */
    stop: useCallback(() => stop(), [stop]),
    /** Show me how: plays a past turn's steps, slowly, tab by tab. */
    replay: useCallback((places: Place[]) => setF((g) => startReplay(g, places.map(remembered), Date.now())), [remembered]),
    /** A step's link: opens its tab and lights its control. */
    showStep: useCallback((place: Place) => setF((g) => showStep(g, remembered(place), Date.now())), [remembered]),
    /** Where a chat line shows, with what this window saw a finish do. */
    placeOf: useCallback((line: ToolLine) => {
      const p = placeOf(line);
      return p && remembered(p);
    }, [remembered]),
  };
}
