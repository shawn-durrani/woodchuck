// The phone layout's working parts. useLayout says whether the window is a
// phone, a portrait tablet or a desktop. usePhoneShell holds the bottom
// sheet: what it shows and how tall it is. The sheet follows the chat's and
// the side panel's open states, the same state a wider screen shows as its
// columns, so code that opens a tab or the panel opens the sheet there with
// no wiring of its own. Its heights reach the stylesheet as variables on
// the page, which move the model's strip, the toolbar and the tabs with it.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ServerState } from "../api";
import {
  follow,
  layoutFor,
  openFor,
  PEEK,
  PHONE_QUERY,
  sameSheet,
  sheetHeight,
  SHOW_IN_CHAT,
  snapAt,
  stripBottom,
  switched,
  TABLET_QUERY,
  TAP_SLOP,
  toggled,
  toolbarShown,
  undoNote,
  type Layout,
  type Sheet,
  type UndoSeen,
  type Watched,
} from "../phone";
import type { Tab } from "../tabs";

/** Whether the window is a phone, a portrait tablet or a desktop, as the media queries say. */
export function useLayout(): Layout {
  const read = (): Layout => {
    if (typeof matchMedia !== "function") return layoutFor(typeof innerWidth === "number" ? innerWidth : 1280);
    return matchMedia(PHONE_QUERY).matches ? "phone" : matchMedia(TABLET_QUERY).matches ? "tablet" : "desktop";
  };
  const [layout, setLayout] = useState<Layout>(read);
  useEffect(() => {
    const queries = [matchMedia(PHONE_QUERY), matchMedia(TABLET_QUERY)];
    const on = () => setLayout(read());
    on();
    for (const q of queries) q.addEventListener("change", on);
    return () => {
      for (const q of queries) q.removeEventListener("change", on);
    };
  }, []);
  return layout;
}

export interface PhoneShell {
  sheet: Sheet;
  /** Classes for the app's root, which the stylesheet arranges the phone by. */
  className: string;
  toggle: () => void;
  switchTo: (to: "chat" | "panels") => void;
  /** The handle's drag, in the screen's y. */
  drag: { start: (y: number) => void; move: (y: number) => void; end: () => void; cancel: () => void };
}

/** How long the sheet's height takes to settle, a little over its transition in styles.css. */
const SETTLE_MS = 320;

const setVar = (name: string, value: string) => {
  const style = document.documentElement.style;
  if (style.getPropertyValue(name) !== value) style.setProperty(name, value);
};
const VARS = ["--phone-sheet", "--phone-sheet-live", "--phone-strip", "--phone-panels-top", "--phone-panels-bottom", "--phone-kb"];

const sheetEl = () => document.querySelector<HTMLElement>(".app > aside.left");
/** Where the header ends, so an open sheet never covers it. */
const headBottom = () => Math.round(document.querySelector(".app > .topbar")?.getBoundingClientRect().bottom ?? 52);

export function usePhoneShell(o: {
  phone: boolean;
  /** The app has drawn its columns, once the design has loaded. */
  ready: boolean;
  chat: boolean;
  panels: boolean;
  /** The chat's and the side panel's setters. The phone's own changes aren't remembered, so a wider window keeps its columns. */
  setChat: (open: boolean, remember?: boolean) => void;
  setPanels: (open: boolean, remember?: boolean) => void;
  tab: Tab;
  picked: string;
  page: boolean;
}): PhoneShell {
  const { phone, ready } = o;
  const [sheet, setSheetState] = useState<Sheet>(PEEK);
  const now = useRef(sheet);
  now.current = sheet;
  const was = useRef<Watched | null>(null);
  /** The chat and the side panel as a wider window had them, put back when the window widens again. */
  const desk = useRef<{ chat: boolean; panels: boolean } | null>(null);
  /** The height of the sheet's bar, waiting bar and chat box, which is the sheet when it's down. */
  const peek = useRef(140);
  const strip = useRef<number | null>(null);
  const settling = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dragging = useRef<{ y: number; from: number; h: number; moved: boolean } | null>(null);

  const setSheet = useCallback((s: Sheet) => {
    if (sameSheet(s, now.current)) return;
    now.current = s;
    setSheetState(s);
  }, []);

  // The sheet follows the app's state, and the app's state follows the
  // sheet. This runs before every paint, so neither shows a stale state.
  const watched: Watched = { chat: o.chat, panels: o.panels, tab: o.tab, picked: o.picked, page: o.page };
  useLayoutEffect(() => {
    if (!phone) {
      // A phone turned on its side is a narrow window, which starts with the chat folded.
      if (desk.current) {
        o.setChat(desk.current.chat && !matchMedia(TABLET_QUERY).matches, false);
        o.setPanels(desk.current.panels, false);
        desk.current = null;
      }
      was.current = null;
      return;
    }
    let next = now.current;
    if (!was.current) {
      desk.current = { chat: o.chat, panels: o.panels };
      next = PEEK;
    } else next = follow(next, was.current, watched);
    was.current = watched;
    setSheet(next);
    const want = openFor(next);
    if (want.chat !== o.chat) o.setChat(want.chat, false);
    if (want.panels !== o.panels) o.setPanels(want.panels, false);
  });

  /** Moves the model's strip to suit the sheet. A bigger model moves at once, under the sheet, and a smaller one once the sheet has settled over it. */
  const placeStrip = useCallback((force = false) => {
    if (dragging.current) return;
    const target = stripBottom(now.current, peek.current, innerHeight, headBottom());
    if (strip.current === target) return;
    if (!force && strip.current !== null && target > strip.current && settling.current) return;
    strip.current = target;
    setVar("--phone-strip", `${target}px`);
  }, []);

  /** Sets the sheet's height for a sheet, and lets it settle. */
  const placeSheet = useCallback(
    (s: Sheet) => {
      const h = sheetHeight(s, innerHeight, headBottom(), peek.current);
      setVar("--phone-sheet", h === null ? "auto" : `${h}px`);
      clearTimeout(settling.current);
      settling.current = setTimeout(() => {
        settling.current = undefined;
        placeStrip(true);
      }, SETTLE_MS);
      placeStrip();
    },
    [placeStrip],
  );

  useLayoutEffect(() => {
    if (phone && ready) placeSheet(sheet);
  }, [phone, ready, sheet, placeSheet]);

  // Measures the sheet as it moves: its live top for the toolbar, the room
  // over its waiting bar for the tabs, and its height when down.
  useLayoutEffect(() => {
    if (!phone || !ready) return;
    const left = sheetEl();
    if (!left) return;
    const measure = () => {
      const r = left.getBoundingClientRect();
      setVar("--phone-sheet-live", `${Math.round(innerHeight - r.top)}px`);
      const log = left.querySelector<HTMLElement>(".chat-log");
      const logH = log?.offsetHeight ?? 0;
      if (log && logH > 0) {
        const lr = log.getBoundingClientRect();
        setVar("--phone-panels-top", `${Math.round(lr.top)}px`);
        setVar("--phone-panels-bottom", `${Math.round(innerHeight - lr.bottom)}px`);
      }
      if (!dragging.current && !settling.current) {
        peek.current = Math.round(left.offsetHeight - logH);
        placeStrip();
      }
    };
    const watch = new ResizeObserver(measure);
    watch.observe(left);
    const log = left.querySelector(".chat-log");
    if (log) watch.observe(log);
    // A new waiting bar or a longer chat box changes the sheet's height when it's down.
    const parts = new MutationObserver(measure);
    const chat = left.querySelector(".chat");
    if (chat) parts.observe(chat, { childList: true });
    const onResize = () => {
      placeSheet(now.current);
      measure();
    };
    addEventListener("resize", onResize);
    measure();
    return () => {
      watch.disconnect();
      parts.disconnect();
      removeEventListener("resize", onResize);
    };
  }, [phone, ready, placeSheet, placeStrip]);

  // The keyboard: the sheet rides on it, so the chat box stays in sight.
  // A pinch zoom also shrinks the visible area, so only a field with the
  // focus at normal scale counts.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!phone || !vv) return;
    const on = () => {
      const typing = document.activeElement?.matches("textarea, input, select") ?? false;
      const kb = typing && vv.scale < 1.01 ? Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop)) : 0;
      setVar("--phone-kb", `${kb}px`);
    };
    vv.addEventListener("resize", on);
    vv.addEventListener("scroll", on);
    document.addEventListener("focusout", on);
    return () => {
      vv.removeEventListener("resize", on);
      vv.removeEventListener("scroll", on);
      document.removeEventListener("focusout", on);
    };
  }, [phone]);

  // Typing opens the chat. "show in chat" opens it, then brings the card into view.
  useEffect(() => {
    if (!phone || !ready) return;
    const left = sheetEl();
    const isBox = (t: EventTarget | null) => t instanceof HTMLTextAreaElement && !!t.closest(".composer");
    const onFocus = (e: FocusEvent) => {
      if (isBox(e.target) && now.current.mode === "peek") setSheet({ mode: "chat", tall: false });
    };
    const onSend = (e: Event) => {
      const enter = e instanceof KeyboardEvent ? e.key === "Enter" && !e.shiftKey && isBox(e.target) && !!(e.target as HTMLTextAreaElement).value.trim() : true;
      if (enter && now.current.mode !== "chat") setSheet({ mode: "chat", tall: false });
    };
    const onShow = (e: Event) => {
      if (now.current.mode === "chat") return;
      setSheet({ mode: "chat", tall: false });
      const id = (e as CustomEvent<string>).detail;
      setTimeout(() => document.getElementById(`chat-${id}`)?.scrollIntoView({ block: "center" }), SETTLE_MS);
    };
    left?.addEventListener("focusin", onFocus);
    left?.addEventListener("submit", onSend, true);
    left?.addEventListener("keydown", onSend, true);
    addEventListener(SHOW_IN_CHAT, onShow);
    return () => {
      left?.removeEventListener("focusin", onFocus);
      left?.removeEventListener("submit", onSend, true);
      left?.removeEventListener("keydown", onSend, true);
      removeEventListener(SHOW_IN_CHAT, onShow);
    };
  }, [phone, ready, setSheet]);

  // Leaving the phone layout takes its variables away.
  useEffect(() => {
    if (phone) return;
    for (const v of VARS) document.documentElement.style.removeProperty(v);
    strip.current = null;
  }, [phone]);

  const drag = useMemo(
    () => ({
      start(y: number) {
        const left = sheetEl();
        if (!left) return;
        dragging.current = { y, from: left.offsetHeight, h: left.offsetHeight, moved: false };
      },
      move(y: number) {
        const d = dragging.current;
        if (!d) return;
        if (!d.moved && Math.abs(y - d.y) < TAP_SLOP) return;
        if (!d.moved) {
          d.moved = true;
          document.documentElement.classList.add("phone-dragging");
        }
        d.h = Math.round(Math.min(Math.max(d.from - (y - d.y), peek.current), innerHeight - headBottom()));
        setVar("--phone-sheet", `${d.h}px`);
      },
      end() {
        const d = dragging.current;
        dragging.current = null;
        document.documentElement.classList.remove("phone-dragging");
        if (!d) return;
        const s = now.current;
        const next = d.moved ? snapAt({ from: d.from, to: d.h }, s.mode === "panels" ? "panels" : "chat", innerHeight, headBottom(), peek.current) : toggled(s);
        setSheet(next);
        // A drag that comes back to where it was still needs its height put back.
        placeSheet(next);
      },
      cancel() {
        const d = dragging.current;
        dragging.current = null;
        document.documentElement.classList.remove("phone-dragging");
        if (d) placeSheet(now.current);
      },
    }),
    [placeSheet, setSheet],
  );

  return {
    sheet,
    className: `phone sheet-${sheet.mode}${sheet.tall ? " sheet-tall" : ""}${toolbarShown(sheet) ? "" : " toolbar-away"}`,
    toggle: () => setSheet(toggled(now.current)),
    switchTo: (to) => setSheet(switched(now.current, to, o.tab)),
    drag,
  };
}

/** How long the note after an undo stays, in ms. */
const NOTE_MS = 6000;

/** The note after an undo on a phone, which holds Redo. Null when there's nothing to say. */
export function useUndoneNote(phone: boolean, state: ServerState | null): { undone: string | null; dismiss: () => void } {
  const seen = useRef<UndoSeen | null>(null);
  const [undone, setUndone] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const key = state ? `${state.project.slug}:${state.history.length}:${state.redo}` : "";
  useEffect(() => {
    if (!state) return;
    const now: UndoSeen = { design: state.project.slug, history: state.history.length, redo: state.redo, last: state.history.at(-1)?.label ?? null };
    const r = undoNote(seen.current, now);
    seen.current = now;
    if (!phone || r === "clear") setUndone(null);
    else if (r) {
      setUndone(r.undone);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setUndone(null), NOTE_MS);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, phone]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return { undone, dismiss: () => setUndone(null) };
}
