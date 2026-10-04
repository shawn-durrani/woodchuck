// The phone layout: the same screen rearranged below 640 px, with one
// bottom sheet for the chat or the five tabs. These hold the sheet's
// heights and where a drag comes to rest, the breakpoints, that code
// opening a tab opens the sheet at that tab, the four-button toolbar, box
// select by touch, and the rules a phone needs: 44 px controls, 16 px
// fields and pinch zoom never blocked.

import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  follow,
  layoutFor,
  MIN_BODY,
  openFor,
  PEEK,
  PHONE_MAX,
  PHONE_QUERY,
  SHARES,
  sheetHeight,
  snapAt,
  statusWords,
  stripBottom,
  switched,
  TABLET_MAX,
  TABLET_QUERY,
  toggled,
  TOOLBAR_ZONE,
  toolbarShown,
  undoNote,
  type Sheet,
  type Watched,
} from "../src/phone.js";
import { NO_TOUCH_BOX, touchBox, type FingerEvent, type TouchBox } from "../src/select.js";
import { compactToolbar, type ToolbarState } from "../src/toolbar.js";
import { Toolbar, type ToolbarActions } from "../src/components/Toolbar.js";
import { SheetBar, UndoneNote } from "../src/components/BottomSheet.js";
import type { PhoneShell } from "../src/components/PhoneShell.js";
import { boxPlaceholder, type Moment } from "../src/waiting.js";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

// The mock-up's phone: 844 px tall, with the header's 52 px at the top.
const SCREEN = 844;
const HEAD = 52;
const DOWN = 116;

describe("the sheet's heights", () => {
  it("opens the chat at 71% or 88% of the screen, and the tabs at 59% or 83%", () => {
    expect(SHARES).toEqual({ chat: [0.71, 0.88], panels: [0.59, 0.83] });
    expect(sheetHeight({ mode: "chat", tall: false }, SCREEN, HEAD)).toBe(599);
    expect(sheetHeight({ mode: "chat", tall: true }, SCREEN, HEAD)).toBe(743);
    expect(sheetHeight({ mode: "panels", tall: false }, SCREEN, HEAD)).toBe(498);
    expect(sheetHeight({ mode: "panels", tall: true }, SCREEN, HEAD)).toBe(701);
  });

  it("leaves peek to its bar, waiting bar and chat box", () => {
    expect(sheetHeight(PEEK, SCREEN, HEAD)).toBeNull();
  });

  it("never covers the header, and keeps room over a tall waiting bar", () => {
    expect(sheetHeight({ mode: "chat", tall: true }, 400, HEAD)).toBe(400 - HEAD);
    const tallBar = 420;
    expect(sheetHeight({ mode: "panels", tall: false }, SCREEN, HEAD, tallBar)).toBe(tallBar + MIN_BODY);
    expect(sheetHeight({ mode: "panels", tall: false }, SCREEN, HEAD, 700)).toBe(SCREEN - HEAD);
  });

  it("gives the model the strip left over, with room for the toolbar where it shows", () => {
    expect(stripBottom(PEEK, DOWN, SCREEN, HEAD)).toBe(DOWN + TOOLBAR_ZONE);
    expect(stripBottom({ mode: "panels", tall: false }, DOWN, SCREEN, HEAD)).toBe(498 + TOOLBAR_ZONE);
    expect(stripBottom({ mode: "chat", tall: false }, DOWN, SCREEN, HEAD)).toBe(599);
    // Tall, the model hides behind the sheet, so its strip stays as it was and it doesn't redraw.
    expect(stripBottom({ mode: "chat", tall: true }, DOWN, SCREEN, HEAD)).toBe(stripBottom({ mode: "chat", tall: false }, DOWN, SCREEN, HEAD));
    expect(stripBottom({ mode: "panels", tall: true }, DOWN, SCREEN, HEAD)).toBe(stripBottom({ mode: "panels", tall: false }, DOWN, SCREEN, HEAD));
  });

  it("rides the toolbar on the sheet when it's down or showing the tabs at half height", () => {
    expect(toolbarShown(PEEK)).toBe(true);
    expect(toolbarShown({ mode: "panels", tall: false })).toBe(true);
    expect(toolbarShown({ mode: "panels", tall: true })).toBe(false);
    expect(toolbarShown({ mode: "chat", tall: false })).toBe(false);
  });
});

describe("dragging and tapping the handle", () => {
  const snap = (from: number, to: number, kind: "chat" | "panels" = "chat") => snapAt({ from, to }, kind, SCREEN, HEAD, DOWN);

  it("comes back to where it was after a short drag", () => {
    expect(snap(DOWN, DOWN + 30)).toEqual(PEEK);
    expect(snap(599, 570)).toEqual({ mode: "chat", tall: false });
  });

  it("moves at least one height the way a longer drag goes", () => {
    expect(snap(DOWN, DOWN + 80)).toEqual({ mode: "chat", tall: false });
    expect(snap(599, 520)).toEqual(PEEK);
    expect(snap(599, 660)).toEqual({ mode: "chat", tall: true });
    expect(snap(743, 680)).toEqual({ mode: "chat", tall: false });
  });

  it("goes to the nearest height in that direction after a long drag", () => {
    expect(snap(DOWN, 760)).toEqual({ mode: "chat", tall: true });
    expect(snap(743, 150)).toEqual(PEEK);
    expect(snap(498, 690, "panels")).toEqual({ mode: "panels", tall: true });
    expect(snap(701, 130, "panels")).toEqual(PEEK);
  });

  it("stops at the top or the bottom when dragged past them", () => {
    expect(snap(743, 900)).toEqual({ mode: "chat", tall: true });
    expect(snap(DOWN, 10)).toEqual(PEEK);
  });

  it("pulls a sheet that's down up to the chat, and puts an open one down, on a tap", () => {
    expect(toggled(PEEK)).toEqual({ mode: "chat", tall: false });
    expect(toggled({ mode: "panels", tall: true })).toEqual(PEEK);
    expect(toggled({ mode: "chat", tall: false })).toEqual(PEEK);
  });

  it("switches between Chat and Panels, opens Make tall, and puts the sheet down from the one showing", () => {
    expect(switched(PEEK, "chat", "edit")).toEqual({ mode: "chat", tall: false });
    expect(switched(PEEK, "panels", "edit")).toEqual({ mode: "panels", tall: false });
    expect(switched({ mode: "chat", tall: false }, "panels", "make")).toEqual({ mode: "panels", tall: true });
    expect(switched({ mode: "panels", tall: false }, "panels", "edit")).toEqual(PEEK);
  });
});

describe("one breakpoint at 640 px", () => {
  it("is a phone below 640 px, a portrait tablet to 1000 px, and a desktop from there", () => {
    expect([320, 390, 639, 639.5].map(layoutFor)).toEqual(["phone", "phone", "phone", "phone"]);
    expect([640, 820, 999].map(layoutFor)).toEqual(["tablet", "tablet", "tablet"]);
    expect([1000, 1280, 1440].map(layoutFor)).toEqual(["desktop", "desktop", "desktop"]);
    expect([PHONE_MAX, TABLET_MAX]).toEqual([640, 1000]);
  });

  it("asks the browser the same widths the code uses, and so does the stylesheet", () => {
    expect(PHONE_QUERY).toBe("(max-width: 639.98px)");
    expect(TABLET_QUERY).toBe("(min-width: 640px) and (max-width: 999.98px)");
    const css = read("../src/styles.css");
    const block = css.slice(css.indexOf("/* Phone layout"));
    expect(block).toContain(`@media ${PHONE_QUERY} {`);
    // One breakpoint: no other width query in the phone layout's block.
    const widths = [...block.matchAll(/@media[^{]*\((?:max|min)-width:\s*([\d.]+)px\)/g)].map((m) => m[1]);
    expect(new Set(widths)).toEqual(new Set(["639.98"]));
  });
});

describe("the sheet follows the same state as the side panel", () => {
  const base: Watched = { chat: false, panels: false, tab: "edit", picked: "", page: false };
  /** The app's state settles as PhoneShell keeps it: the sheet follows, then the open states follow the sheet. */
  const settle = (sheet: Sheet, was: Watched, now: Watched) => {
    const next = follow(sheet, was, now);
    const open = openFor(next);
    const after = { ...now, ...open };
    // Feeding the sheet's own open states back leaves it where it is.
    expect(follow(next, now, after)).toEqual(next);
    return { sheet: next, state: after };
  };

  it("opens the sheet at a tab that code opens with the side panel, as Claude's work does", () => {
    const r = settle(PEEK, base, { ...base, tab: "finish", panels: true });
    expect(r.sheet).toEqual({ mode: "panels", tall: false });
    expect(r.state).toMatchObject({ tab: "finish", panels: true, chat: false });
  });

  it("opens the sheet at a tab that code switches to, even when the panel was already open", () => {
    expect(settle(PEEK, base, { ...base, tab: "check" }).sheet).toEqual({ mode: "panels", tall: false });
    const showing = { ...base, panels: true };
    expect(settle({ mode: "panels", tall: false }, showing, { ...showing, tab: "history" }).sheet).toEqual({ mode: "panels", tall: false });
  });

  it("takes the chat away to show the tab Claude opens", () => {
    const chatting = { ...base, chat: true };
    const r = settle({ mode: "chat", tall: false }, chatting, { ...chatting, tab: "edit", panels: true });
    expect(r.sheet).toEqual({ mode: "panels", tall: false });
    expect(r.state.chat).toBe(false);
  });

  it("opens Make and the All designs and parts page tall, since they're lists", () => {
    expect(settle(PEEK, base, { ...base, tab: "make", panels: true }).sheet).toEqual({ mode: "panels", tall: true });
    expect(settle(PEEK, base, { ...base, page: true, panels: true }).sheet).toEqual({ mode: "panels", tall: true });
  });

  it("keeps a tall sheet tall when the tab changes under it", () => {
    const showing = { ...base, panels: true, tab: "make" as const };
    expect(settle({ mode: "panels", tall: true }, showing, { ...showing, tab: "edit" }).sheet).toEqual({ mode: "panels", tall: true });
  });

  it("opens the chat for code that opens the chat, such as Ask Claude to fix", () => {
    const showing = { ...base, panels: true, tab: "check" as const };
    const r = settle({ mode: "panels", tall: false }, showing, { ...showing, chat: true });
    expect(r.sheet).toEqual({ mode: "chat", tall: false });
    expect(r.state.panels).toBe(false);
  });

  it("leaves the sheet down when a tap on the model moves the tab to Edit", () => {
    const onMake = { ...base, tab: "make" as const };
    expect(follow(PEEK, onMake, { ...onMake, tab: "edit", picked: "leg_front_left" })).toEqual(PEEK);
  });

  it("puts the sheet down when code closes what it shows", () => {
    expect(follow({ mode: "panels", tall: false }, { ...base, panels: true }, base)).toEqual(PEEK);
    expect(follow({ mode: "chat", tall: true }, { ...base, chat: true }, base)).toEqual(PEEK);
  });

  it("stands for the chat or the side panel, never both", () => {
    expect(openFor(PEEK)).toEqual({ chat: false, panels: false });
    expect(openFor({ mode: "chat", tall: true })).toEqual({ chat: true, panels: false });
    expect(openFor({ mode: "panels", tall: false })).toEqual({ chat: false, panels: true });
  });

  it("sends the sheet's changes through the same setters as the columns, and draws it from them in App", () => {
    const app = read("../src/App.tsx");
    expect(app).toMatch(/usePhoneShell\(\{[\s\S]*?chat: leftOpen,[\s\S]*?panels: rightOpen,[\s\S]*?setChat: setLeftOpen,[\s\S]*?setPanels: setRightOpen,[\s\S]*?tab,/);
    // The tabs are the side panel itself, so a phone shows them only while the panel is open.
    expect(app).toContain('<aside className="right" hidden={!rightOpen}');
  });
});

describe("the phone's header and notes", () => {
  const report = (errors: number, warnings: number) => ({ errors, warnings, ready_to_cut: errors === 0 && warnings === 0 });

  it("says the worst count on a phone's status pill, and both on a wider screen", () => {
    expect(statusWords(report(1, 0), false, true)).toBe("1 error");
    expect(statusWords(report(1, 0), false, false)).toBe("1 error, 0 warnings");
    expect(statusWords(report(2, 3), false, true)).toBe("2 errors");
    expect(statusWords(report(0, 3), false, true)).toBe("3 warnings");
    expect(statusWords({ errors: 0, warnings: 1, ready_to_cut: false }, false, true)).toBe("1 warning");
    expect(statusWords(report(0, 0), false, true)).toBe("Ready to cut");
    expect(statusWords({ errors: 0, warnings: 0, ready_to_cut: false }, true, true)).toBe("Nothing to cut yet");
  });

  it("notes an undo with Redo, and clears the note on a redo, a new change or another design", () => {
    const seen = { design: "reading-bench", history: 5, redo: 0, last: "Raise the book shelf" };
    expect(undoNote(null, seen)).toBeNull();
    const undone = { ...seen, history: 4, redo: 1, last: "Built the bench" };
    expect(undoNote(seen, undone)).toEqual({ undone: "Raise the book shelf" });
    expect(undoNote(undone, seen)).toBe("clear");
    expect(undoNote(undone, { ...undone, history: 5, redo: 0 })).toBe("clear");
    expect(undoNote(undone, { ...undone, design: "bedside-table" })).toBe("clear");
    expect(undoNote(seen, seen)).toBeNull();
  });

  it("gives a phone's one-line chat box the short words", () => {
    const m = (kind: Moment["kind"]): Moment[] => [{ kind, id: "x", label: "", summary: "", actions: [] }];
    expect(boxPlaceholder(m("preview"), true)).toBe("Or say what to change");
    expect(boxPlaceholder(m("plan"), true)).toBe("Say what to change");
    expect(boxPlaceholder(m("question"), true)).toBe("Answer Claude's question");
    expect(boxPlaceholder(m("preview"))).toBe("Reply about the suggested change. Sending leaves it unapplied");
  });
});

const tools: ToolbarState = {
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
const compact = (state: ToolbarState, menu: "tools" | "look" | "share" | null = null) =>
  renderToStaticMarkup(createElement(Toolbar, { state, menu, onMenu: noop, compact: true, ...actions }));
const drawn = (markup: string) => [...markup.matchAll(/data-control="([^"]+)"/g)].map((m) => m[1]!);

describe("the four-button toolbar", () => {
  it("is Select, Fit, Look and Share, in that order", () => {
    expect(compactToolbar(tools).map((c) => [c.id, c.label])).toEqual([
      ["tools", "Select"],
      ["fit", "Fit"],
      ["look", "Look"],
      ["share", "Share"],
    ]);
    expect(drawn(compact(tools))).toEqual(["tools", "fit", "look", "share"]);
  });

  it("shows the tool that's on, with the four tools in its menu", () => {
    expect(compactToolbar({ ...tools, pointMode: "box" })[0]!.label).toBe("Box");
    expect(drawn(compact(tools, "tools"))).toEqual(["tools", "tool.pick", "tool.box", "tool.pin", "tool.pan", "fit", "look", "share"]);
  });

  it("puts the camera views and See-through in the Look menu, under the same names", () => {
    const look = drawn(compact(tools, "look"));
    for (const id of ["look.plain", "look.finished", "lighting.daylight", "camera.iso", "camera.front", "camera.back", "see-through", "views.3d", "views.2d"]) expect(look).toContain(id);
    expect(drawn(compact(tools, "share"))).toEqual(["tools", "fit", "look", "share", "share.render", "share.photo", "share.full", "share.drawings"]);
  });

  it("greys out what can't act in the 2D views, and never hides it", () => {
    const flat = compact({ ...tools, mode: "2d" });
    expect(drawn(flat)).toEqual(["tools", "fit", "look", "share"]);
    expect(flat).toMatch(/aria-disabled="true"[^>]*data-control="tools"/);
  });
});

describe("box select by touch", () => {
  const run = (events: FingerEvent[]) => {
    let s: TouchBox = NO_TOUCH_BOX;
    const done = [];
    for (const e of events) {
      const r = touchBox(s, e);
      s = r.state;
      if (r.done) done.push(r.done);
    }
    return { state: s, done };
  };
  const ev = (kind: FingerEvent["kind"], id: number, x: number, y: number): FingerEvent => ({ kind, id, x, y });

  it("spans the box between two fingers, and selects when one lifts", () => {
    const r = run([ev("down", 1, 10, 20), ev("down", 2, 200, 300), ev("move", 2, 220, 320), ev("up", 1, 10, 20), ev("move", 2, 230, 330), ev("up", 2, 230, 330)]);
    expect(r.done).toEqual([{ x0: 10, y0: 20, x1: 220, y1: 320 }]);
    expect(r.state).toEqual(NO_TOUCH_BOX);
  });

  it("starts a box at a tap, and closes it at the next tap", () => {
    const first = run([ev("down", 1, 40, 50), ev("up", 1, 42, 51)]);
    expect(first.done).toEqual([]);
    expect(first.state.anchor).toEqual({ x: 42, y: 51 });
    const both = run([ev("down", 1, 40, 50), ev("up", 1, 42, 51), ev("down", 2, 300, 400), ev("up", 2, 300, 400)]);
    expect(both.done).toEqual([{ x0: 42, y0: 51, x1: 300, y1: 400 }]);
    expect(both.state.anchor).toBeNull();
  });

  it("draws a box from a tap's corner to where a drag ends", () => {
    const r = run([ev("down", 1, 40, 50), ev("up", 1, 40, 50), ev("down", 2, 100, 100), ev("move", 2, 250, 300), ev("up", 2, 260, 310)]);
    expect(r.done).toEqual([{ x0: 40, y0: 50, x1: 260, y1: 310 }]);
  });

  it("draws a box with one finger dragged, as the mouse does", () => {
    const r = run([ev("down", 1, 40, 50), ev("move", 1, 120, 160), ev("up", 1, 150, 200)]);
    expect(r.done).toEqual([{ x0: 40, y0: 50, x1: 150, y1: 200 }]);
  });

  it("drops a half-drawn box when the browser takes the touch away", () => {
    const r = run([ev("down", 1, 40, 50), ev("move", 1, 120, 160), ev("cancel", 1, 0, 0)]);
    expect(r.done).toEqual([]);
    expect(r.state).toEqual(NO_TOUCH_BOX);
  });
});

describe("a phone's controls are a finger's size", () => {
  const css = read("../src/styles.css");
  const block = css.slice(css.indexOf("/* Phone layout")).replace(/\/\*[\s\S]*?\*\//g, "");

  /** Each rule in the phone layout's block, with its selector and declarations. */
  const rules = [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! }));
  const control = /\b(button|select|input|textarea|summary)\b|\.button\b|menu-item|menu-button|sheet-toggle|five-tabs|stop-claude/;
  /** Drawn smaller on purpose: a tick box is hit through its 44 px label, and the grab bar and a box's corner are marks, not targets. */
  const marks = /checkbox|radio|sheet-grab|box-corner/;

  it("is the last block of the stylesheet, so a wider screen's rules stay as they were", () => {
    expect(css.indexOf("/* Phone layout")).toBeGreaterThan(css.indexOf("/* UX phase 4"));
    expect(block).toContain("@media (max-width: 639.98px)");
  });

  it("sets every control to at least 44 px and every field to 16 px", () => {
    const generic = rules.find((r) => r.selector.startsWith(".app.phone button,"));
    expect(generic?.body).toMatch(/min-height:\s*44px/);
    expect(generic?.body).toMatch(/min-width:\s*44px/);
    const fields = rules.find((r) => r.selector.includes(".app.phone textarea") && /font-size/.test(r.body));
    expect(fields?.body).toMatch(/font-size:\s*16px/);
    expect(fields?.body).toMatch(/min-height:\s*44px/);
  });

  it("never sizes a control under 44 px, where it sets a size at all", () => {
    const under: string[] = [];
    for (const r of rules) {
      if (!control.test(r.selector) || marks.test(r.selector)) continue;
      for (const [, prop, px] of r.body.matchAll(/(?:^|;|\s)((?:min-)?(?:height|width)):\s*(\d+(?:\.\d+)?)px/g)) {
        if (Number(px) < 44) under.push(`${r.selector} { ${prop}: ${px}px }`);
      }
    }
    expect(under).toEqual([]);
  });

  it("never sets a field's words under 16 px", () => {
    const under = rules
      .filter((r) => /\b(input|select|textarea)\b/.test(r.selector) && !marks.test(r.selector))
      .flatMap((r) => [...r.body.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].filter((m) => Number(m[1]) < 16).map(() => r.selector));
    expect(under).toEqual([]);
  });

  it("keeps fields at 16 px on any touch screen, so iOS doesn't zoom", () => {
    expect(block).toMatch(/@media \(pointer: coarse\) \{[^}]*select,\s*textarea \{\s*font-size: 16px;/);
  });

  it("sets no size in the phone's own components' markup", () => {
    for (const file of ["../src/components/BottomSheet.tsx", "../src/components/PhoneShell.tsx"]) {
      expect(read(file).match(/style=\{\{[^}]*\b(?:height|width|fontSize)\b/g) ?? [], file).toEqual([]);
    }
  });

  it("draws the sheet's bar and the undo note with buttons the stylesheet sizes", () => {
    const shell: PhoneShell = { sheet: PEEK, className: "phone sheet-peek", toggle: noop, switchTo: noop, drag: { start: noop, move: noop, end: noop, cancel: noop } };
    const bar = renderToStaticMarkup(createElement(SheetBar, { shell }));
    expect([...bar.matchAll(/<button[^>]*>/g)].length).toBe(3);
    expect(bar).toContain(">Chat</button>");
    expect(bar).toContain(">Panels</button>");
    expect(bar).toContain('aria-label="Pull the sheet up"');
    expect(bar).not.toMatch(/style=/);
    const note = renderToStaticMarkup(createElement(UndoneNote, { undone: "Raise the book shelf", canRedo: true, onRedo: noop, onDismiss: noop }));
    expect(note).toContain("Undone: Raise the book shelf");
    expect(note).toContain(">Redo</button>");
  });

  it("keeps the page from scrolling sideways", () => {
    expect(block).toMatch(/html,\s*body \{\s*overflow-x: hidden;/);
  });
});

describe("pinch zoom is never blocked", () => {
  const html = read("../index.html");
  const meta = html.match(/<meta\s+name="viewport"\s+content="([^"]+)"/);

  it("keeps the viewport meta to the device's width at its own scale", () => {
    expect(meta).not.toBeNull();
    const parts = Object.fromEntries(meta![1]!.split(",").map((p) => p.trim().split("=").map((s) => s.trim()) as [string, string]));
    expect(parts.width).toBe("device-width");
    expect(Number(parts["initial-scale"])).toBe(1);
    expect(Object.keys(parts).sort()).toEqual(["initial-scale", "width"]);
  });

  it("never says user-scalable or a largest scale anywhere in the page", () => {
    expect(html).not.toMatch(/user-scalable|maximum-scale|minimum-scale/i);
    const css = read("../src/styles.css");
    // Only the model and the sheet's handle take pinches and drags for themselves, never the page.
    expect(css).not.toMatch(/(?:^|\n)\s*(?:html|body)[^{]*\{[^}]*touch-action:\s*none/);
  });
});
