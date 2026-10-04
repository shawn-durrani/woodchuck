// The phone layout: the same screen, rearranged below 640 px. The model
// fills the screen under a slim header, and one bottom sheet holds the chat
// or the side panel's five tabs, with the waiting bar and the chat box on
// its bottom edge. The sheet follows the same state that opens the chat and
// the side panel on a wider screen, so whatever opens a tab or the panel in
// code opens the sheet at that tab. Between 640 and 1000 px it's the
// desktop layout with the chat folded at the start. Kept free of React so
// the tests can hold it.

import type { Tab } from "./tabs";

/** One breakpoint, as in Crossband: narrower than this is a phone. */
export const PHONE_MAX = 640;
/** Narrower than this, and not a phone, is a portrait tablet or a narrow window. */
export const TABLET_MAX = 1000;
/** The same breakpoints as media queries, which styles.css uses too. */
export const PHONE_QUERY = "(max-width: 639.98px)";
export const TABLET_QUERY = "(min-width: 640px) and (max-width: 999.98px)";

export type Layout = "phone" | "tablet" | "desktop";

export const layoutFor = (width: number): Layout => (width < PHONE_MAX ? "phone" : width < TABLET_MAX ? "tablet" : "desktop");

/** What the sheet shows: just its bar and the chat box (peek), the chat, or the five tabs. */
export type SheetMode = "peek" | "chat" | "panels";

export interface Sheet {
  mode: SheetMode;
  /** Pulled up to its tall height, where the model hides behind it. */
  tall: boolean;
}

export const PEEK: Sheet = { mode: "peek", tall: false };

/** Each open height as a share of the screen's height, from the mock-up's 844 px phone: chat 600 or 740, the tabs 500 or 700. */
export const SHARES: Record<Exclude<SheetMode, "peek">, readonly [half: number, tall: number]> = {
  chat: [0.71, 0.88],
  panels: [0.59, 0.83],
};

/** The room the toolbar takes over the sheet's top edge: 44 px of buttons with 10 px either side. */
export const TOOLBAR_ZONE = 64;

/** A drag shorter than this, in CSS px, is a tap on the handle. */
export const TAP_SLOP = 6;

/** A drag longer than this, in CSS px, moves the sheet at least one height in its direction. */
export const STEP = 48;

export const sameSheet = (a: Sheet, b: Sheet) => a.mode === b.mode && a.tall === b.tall;

/** The least room an open sheet keeps for the chat or the tabs, over a tall waiting bar. */
export const MIN_BODY = 240;

/**
 * The sheet's height in CSS px for an open sheet. It keeps room for the
 * chat or the tabs over a tall waiting bar, and never covers the header.
 * Peek has no set height: it's as tall as its bar, the waiting bar and the
 * chat box, which is the peek height given here.
 */
export function sheetHeight(s: Sheet, screen: number, head: number, peek = 0): number | null {
  if (s.mode === "peek") return null;
  return Math.round(Math.min(Math.max(screen * SHARES[s.mode][s.tall ? 1 : 0], peek + MIN_BODY), screen - head));
}

/**
 * Where a drag of the handle comes to rest. The heights it can stop at are
 * peek and the two open heights of the sheet's kind. A short drag goes to
 * the nearest. A longer one moves at least one height the way you dragged,
 * then to the nearest of those.
 */
export function snapAt(drag: { from: number; to: number }, kind: "chat" | "panels", screen: number, head: number, peek: number): Sheet {
  const stops: { sheet: Sheet; h: number }[] = [
    { sheet: PEEK, h: peek },
    { sheet: { mode: kind, tall: false }, h: sheetHeight({ mode: kind, tall: false }, screen, head, peek)! },
    { sheet: { mode: kind, tall: true }, h: sheetHeight({ mode: kind, tall: true }, screen, head, peek)! },
  ];
  const moved = drag.to - drag.from;
  let options = stops;
  if (moved > STEP) options = stops.filter((s) => s.h > drag.from + 1);
  else if (moved < -STEP) options = stops.filter((s) => s.h < drag.from - 1);
  if (!options.length) options = [moved > 0 ? stops.reduce((a, b) => (b.h > a.h ? b : a)) : stops.reduce((a, b) => (b.h < a.h ? b : a))];
  return options.reduce((a, b) => (Math.abs(b.h - drag.to) < Math.abs(a.h - drag.to) ? b : a)).sheet;
}

/** A tap on the handle, or its arrow: a sheet that's down comes up to the chat, and an open one goes down. */
export const toggled = (s: Sheet): Sheet => (s.mode === "peek" ? { mode: "chat", tall: false } : PEEK);

/** The Chat and Panels switch on the sheet's bar. Tapping the one that's showing puts the sheet down. Make opens tall, since it's a list. */
export function switched(s: Sheet, to: "chat" | "panels", tab: Tab): Sheet {
  if (s.mode === to) return PEEK;
  return { mode: to, tall: to === "panels" && tab === "make" };
}

/** What the sheet watches: the open states a wider screen shows as the chat and the side panel, the tab, what's picked and the All designs and parts page. */
export interface Watched {
  chat: boolean;
  panels: boolean;
  tab: Tab;
  /** What's picked, as one key, so a tab that changes with a pick doesn't pull the sheet up. */
  picked: string;
  /** The All designs and parts page is open over the tabs. */
  page: boolean;
}

/**
 * The sheet after the app's state changed. Code that opens the side panel,
 * or switches its tab, opens the sheet at that tab. Code that opens the
 * chat, such as Check's Ask Claude to fix, opens the chat. A pick that
 * moves the tab to Edit leaves the sheet where it is, as a tap on the
 * model shouldn't pull it up. Make and the All designs and parts page open
 * tall, since they're lists.
 */
export function follow(sheet: Sheet, was: Watched, now: Watched): Sheet {
  const tall = now.tab === "make" || now.page || (sheet.mode === "panels" && sheet.tall);
  if (now.page && !was.page) return { mode: "panels", tall: true };
  if (now.panels && !was.panels) return { mode: "panels", tall };
  if (now.chat && !was.chat) return { mode: "chat", tall: sheet.mode === "chat" && sheet.tall };
  if (now.tab !== was.tab && now.picked === was.picked) return { mode: "panels", tall };
  if (!now.panels && was.panels && sheet.mode === "panels") return PEEK;
  if (!now.chat && was.chat && sheet.mode === "chat") return PEEK;
  return sheet;
}

/** The open states a sheet stands for, so the rest of the app reads a phone as it reads a wider screen. */
export const openFor = (s: Sheet): { chat: boolean; panels: boolean } => ({ chat: s.mode === "chat", panels: s.mode === "panels" });

/**
 * How far the model's strip stops short of the bottom of the screen. Down,
 * the sheet and the toolbar over it. Open, the sheet's half height, with
 * the toolbar over the tabs but not over the chat. Tall, the model hides
 * behind the sheet, so the strip stays as it was at half height and the
 * model doesn't redraw.
 */
export function stripBottom(s: Sheet, peek: number, screen: number, head: number): number {
  if (s.mode === "peek") return peek + TOOLBAR_ZONE;
  return sheetHeight({ mode: s.mode, tall: false }, screen, head, peek)! + (s.mode === "panels" ? TOOLBAR_ZONE : 0);
}

/** The toolbar rides on the sheet when it's down or showing the tabs at half height. Over the chat or a tall sheet it steps aside. */
export const toolbarShown = (s: Sheet): boolean => s.mode === "peek" || (s.mode === "panels" && !s.tall);

/** The words on the status pill. A phone has room for the worst count only, and Check says the rest. */
export function statusWords(report: { errors: number; warnings: number; ready_to_cut: boolean }, empty: boolean, short: boolean): string {
  if (report.ready_to_cut) return "Ready to cut";
  if (empty) return "Nothing to cut yet";
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (!short) return `${count(report.errors, "error")}, ${count(report.warnings, "warning")}`;
  return report.errors ? count(report.errors, "error") : count(report.warnings, "warning");
}

/** What the phone remembers of the history, to notice an undo. */
export interface UndoSeen {
  design: string;
  history: number;
  redo: number;
  /** The newest change set's label. */
  last: string | null;
}

/**
 * The note a phone shows after an undo, which holds Redo since the header
 * has no room for it. An undo, here or anywhere, says what it undid. A
 * redo, a new change or another design clears it.
 */
export function undoNote(was: UndoSeen | null, now: UndoSeen): { undone: string } | "clear" | null {
  if (!was) return null;
  if (was.design !== now.design) return "clear";
  if (now.redo > was.redo && now.history < was.history) return { undone: was.last ?? "the last change" };
  if (now.redo < was.redo || now.history > was.history) return "clear";
  return null;
}

/** The event "show in chat" sends, so a phone opens the chat sheet before the card scrolls into view. */
export const SHOW_IN_CHAT = "woodchuck:show-in-chat";
