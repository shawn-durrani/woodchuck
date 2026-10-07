// The app: chat on the left, the model in the middle, and the side panel
// on the right with five tabs for the open design: Edit, Finish, Make,
// Check and History. A change Claude suggests is drawn on the model itself.
// While Claude works, the screen follows it through the same tabs and
// controls, until you touch anything. Explode pulls the piece apart, or
// one of its joints, with a slider over the model.
// On a phone the same pieces rearrange: the model fills the screen, and the
// chat and the tabs share one bottom sheet (PhoneShell and BottomSheet).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { post, useServer, viewRequests, type ServerState } from "./api";
import { Passkeys, PasskeysButton } from "./components/Passkeys";
import { ChatPanel } from "./components/ChatPanel";
import { drawingsNote, drawingsUrl, ViewsPanel } from "./components/Panels";
import { FinishPanel } from "./components/FinishPanel";
import { AllPage, CheckTab, EditTab, HistoryTab, MakeTab, TabBar } from "./components/SidePanel";
import { GhostSwitch } from "./components/GhostSwitch";
import { ChangeLists } from "./components/ChangeLists";
import { DesignMenu } from "./components/DesignMenu";
import { Toolbar, type ToolbarMenu } from "./components/Toolbar";
import type { Lighting } from "./lighting";
import { Viewport, type CameraView, type ExplodeView, type Look, type Pin, type PointMode, type ViewportApi } from "./components/Viewport";
import { ExplodeBar } from "./components/ExplodeBar";
import { describeView, explodeJoint, explodeOffsets, explodePiece, FACES, JOINT_LIBRARY, type Box, type Face, type ViewCommand } from "@woodchuck/core";
import { allControls, applyView, TIPS, toolbarState, WAIT_FOR_CLAUDE, type Mode, type Paper, type PlanView, type ViewState } from "./toolbar";
import { shortcutFor, type Shortcut } from "./shortcuts";
import { isFace } from "./select";
import { PreviewDrawer, type Drawer } from "./components/PreviewDrawer";
import { ThemeSwitch } from "./components/ThemeSwitch";
import { NO_SLOTS, openSlot, type Slots } from "./waiting";
import { warmWhenSeen } from "./warm";
import { draftView, ghostShown, hideGhost, livePreview, modelView, previewChange, seeIt, showGhost, type GhostPref, type PreviewResult, type Side } from "./ghost";
import { ALL_SECTIONS, PILL_TAB, readMake, readTab, routeView, tabAfterPick, waitingIn, type MakeView, type Section, type Tab } from "./tabs";
import { boxOf } from "./checkFixes";
import { partNamer } from "./names";
import { compose, DEFAULT_PHOTO, PhotoStage, readPhoto, type BlendPictures, type PhotoSettings } from "./components/PhotoStage";
import { BLEND_NEEDS_KEY, blendInputs, pasteBack, withLabel } from "./blend";
import { nextSeen, savedNote, type ClaudeChange, type Seen } from "./signals";
import { useFollow } from "./useFollow";
import { FollowCaption, FollowChip, FollowSwitch } from "./components/Follow";
import { layoutFor, statusWords } from "./phone";
import { useLayout, usePhoneShell, useUndoneNote } from "./components/PhoneShell";
import { SheetBar, UndoneNote } from "./components/BottomSheet";

/** Where an error shows: beside the control that caused it. */
type Where = "design" | "history" | "view" | "photo";

/**
 * Parts Claude just moved or resized, so they can glow for a few seconds.
 * Only a new change set by Claude on the open design sets it off, and
 * onColours hears when that change set changed colours.
 */
function useClaudeGlow(state: ServerState | null, onColours: (c: ClaudeChange) => void): string[] {
  const seen = useRef<Seen | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [changed, setChanged] = useState<string[]>([]);
  const colours = useRef(onColours);
  colours.current = onColours;
  useEffect(() => {
    if (!state) return;
    const switched = seen.current !== null && seen.current.slug !== state.project.slug;
    const { seen: next, claude, moved } = nextSeen(seen.current, state);
    seen.current = next;
    // Another design, or an undo, takes away a glow that no longer applies.
    if (switched || moved) {
      clearTimeout(timer.current);
      setChanged([]);
    }
    if (!claude) return;
    if (claude.parts.length) {
      clearTimeout(timer.current);
      setChanged(claude.parts);
      timer.current = setTimeout(() => setChanged([]), 6000);
    }
    if (claude.finishes) colours.current(claude);
  }, [state]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return changed;
}

const MIN_PANEL = 260;

function readWidth(key: string, fallback: number): number {
  try {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) && v >= MIN_PANEL ? v : fallback;
  } catch {
    return fallback;
  }
}

/** A side panel's width, dragged by its handle and remembered in this browser. */
function usePanelWidth(key: string, fallback: number) {
  const [width, setWidth] = useState(() => readWidth(key, fallback));
  const set = useCallback(
    (w: number) => {
      const clamped = Math.round(Math.min(Math.max(w, MIN_PANEL), window.innerWidth * 0.5));
      setWidth(clamped);
      try {
        localStorage.setItem(key, String(clamped));
      } catch {
        // Private windows can refuse storage; the width just won't be remembered.
      }
    },
    [key],
  );
  return [width, set] as const;
}

function Splitter({
  onDrag,
  label,
  side,
  onCollapse,
}: {
  onDrag: (clientX: number) => void;
  label: string;
  /** Which sidebar this splitter belongs to, so its button points the right way. */
  side: "left" | "right";
  onCollapse: () => void;
}) {
  return (
    <div
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        document.body.classList.add("dragging");
      }}
      onPointerMove={(e) => {
        if ((e.target as HTMLElement).hasPointerCapture(e.pointerId)) onDrag(e.clientX);
      }}
      onPointerUp={(e) => {
        if ((e.target as HTMLElement).hasPointerCapture(e.pointerId)) (e.target as HTMLElement).releasePointerCapture(e.pointerId);
        document.body.classList.remove("dragging");
      }}
    >
      <button className="collapse" title={side === "left" ? "Hide the chat" : "Hide the side panels"} aria-label={side === "left" ? "Hide the chat" : "Hide the side panels"} onClick={onCollapse}>
        {side === "left" ? "‹" : "›"}
      </button>
    </div>
  );
}

/** The slim edge a collapsed sidebar leaves, which brings it back. */
function Rail({ label, onOpen }: { label: string; onOpen: () => void }) {
  return (
    <button className="rail" title={`Show the ${label.toLowerCase()}`} aria-label={`Show the ${label.toLowerCase()}`} onClick={onOpen}>
      <span>{label}</span>
    </button>
  );
}

/**
 * Whether a sidebar is open, remembered in this browser. startClosed folds
 * it at the start without remembering that, as a portrait tablet does with
 * the chat. A phone's sheet sets it without remembering it either.
 */
function useOpen(key: string, startClosed = false) {
  const [open, setOpen] = useState(() => {
    if (startClosed) return false;
    try {
      return localStorage.getItem(key) !== "closed";
    } catch {
      return true;
    }
  });
  const set = useCallback(
    (v: boolean, remember = true) => {
      setOpen(v);
      if (!remember) return;
      try {
        localStorage.setItem(key, v ? "open" : "closed");
      } catch {
        // Storage can be refused; it just won't be remembered.
      }
    },
    [key],
  );
  return [open, set] as const;
}

/** The layout the window starts in, which sets a portrait tablet's narrower panels and folded chat. */
const startLayout = () => layoutFor(typeof innerWidth === "number" ? innerWidth : 1280);
/** The computer asks for less motion, so nothing turns by itself. */
const lessMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** State that survives a reload of this tab, such as after an update. read makes sense of what was kept, such as a tab from before the five. */
function useKept<T extends string>(key: string, fallback: T, read?: (stored: string | null) => T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = sessionStorage.getItem(key);
      return read ? read(stored) : ((stored as T | null) ?? fallback);
    } catch {
      return fallback;
    }
  });
  const set = useCallback(
    (v: T | ((old: T) => T)) => {
      setValue((old) => {
        const next = typeof v === "function" ? v(old) : v;
        try {
          sessionStorage.setItem(key, next);
        } catch {
          // Storage can be refused; the setting just won't survive a reload.
        }
        return next;
      });
    },
    [key],
  );
  return [value, set] as const;
}

export function App() {
  const { state, connected } = useServer();
  const [selection, setSelection] = useState<string[]>([]);
  const [tab, setTab] = useKept<Tab>("woodchuck.tab", "edit", readTab);
  /** Make's switch: the cut list or the cut layout. */
  const [makeView, setMakeView] = useKept<MakeView>("woodchuck.make", "list", readMake);
  /** The All designs and parts page over the side panel, open at a section or its top. */
  const [allPage, setAllPage] = useState<{ section: Section | null } | null>(null);
  /** How you've left the ghost of the change Claude is waiting on. */
  const [ghostPref, setGhostPref] = useState<GhostPref | null>(null);
  /** A change you're typing in the Edit tab, such as a cut's new end, drawn as a ghost until you make it or put it back. */
  const [draft, setDraft] = useState<PreviewResult | null>(null);
  /** A few parts Show me framed, once per key. */
  const [frame, setFrame] = useState<{ box: Box; key: number } | null>(null);
  /** Words for the chat box, such as Check's request to fix a problem, once per n. */
  const [fillReq, setFillReq] = useState<{ text: string; n: number } | null>(null);
  const [view, setView] = useState<CameraView>("iso");
  const [mode, setMode] = useState<Mode>("3d");
  /** The drawing the 2D view shows. */
  const [planView, setPlanView] = useKept<PlanView>("woodchuck.planView", "front");
  /** The paper for the workshop drawings, wherever you download them. */
  const [paper, setPaper] = useKept<Paper>("woodchuck.paper", "A4");
  /** The toolbar menu or the design menu that's open, if any. Only one opens at a time. */
  const [menu, setMenu] = useState<ToolbarMenu | "design">(null);
  /** The Passkeys section, for a browser signed in over the tailnet. */
  const [passkeys, setPasskeys] = useState(false);
  const closePasskeys = useCallback(() => setPasskeys(false), []);
  const [xray, setXray] = useState(false);
  /** Explode is on: the piece, or one joint, pulled apart, with its slider over the model. */
  const [explodeOn, setExplodeOn] = useState(false);
  /** How far apart, from 0 to 1, and whether the last change eases there, as a button does, or jumps, as the slider does. */
  const [explode, setExplode] = useState({ amount: 0, glide: true });
  /** One of the design's joints pulled apart on its own, by id. */
  const [focusJoint, setFocusJoint] = useState<string | null>(null);
  /** Some part is still away from its place, as while the piece glides back together. */
  const [apart, setApart] = useState(false);
  /** Frame the piece apart once its plan is worked out, after Explode or Whole piece. */
  const frameApart = useRef(false);
  const [pointMode, setPointMode] = useState<PointMode>("pick");
  const [pins, setPins] = useState<Pin[]>([]);
  const [look, setLook] = useKept<Look>("woodchuck.look", "plain");
  const [lighting, setLighting] = useKept<Lighting>("woodchuck.lighting", "daylight");
  const [updated, setUpdated] = useState(false);
  const firstBuild = useRef<string | null>(null);
  const [faceMode, setFaceMode] = useState(false);
  /** The face under your last click, so the Finish tab can offer just that face. */
  const [lastFace, setLastFace] = useState<string | null>(null);
  /** Which faces of the selected pieces a colour goes on, in the Finish tab. */
  const [faceFilter, setFaceFilter] = useState<Face[]>([...FACES]);
  /** Placing the design in the room photo kept with it. */
  const [photoOn, setPhotoOn] = useKept<"on" | "off">("woodchuck.photoOn", "off");
  const photoFile = useRef<HTMLInputElement>(null);
  const [photoSettings, setPhotoSettingsState] = useState<PhotoSettings>(DEFAULT_PHOTO);
  const [blending, setBlending] = useState(false);
  const [blendResult, setBlendResult] = useState<BlendPictures | null>(null);
  const [faces, setFaces] = useState<string[]>([]);
  /** The drawer beside the model: an older suggested change and a worked example each have a slot, so one never hides the other. */
  const [slots, setSlots] = useState<Slots>(NO_SLOTS);
  // The change Claude is waiting on is drawn on the model. An older one, or a joint, opens in the drawer.
  const live = state ? livePreview(state) : null;
  const liveId = live?.id ?? null;
  const liveRef = useRef(liveId);
  liveRef.current = liveId;
  /** Pulls one of the design's joints apart on the model, set once the design is in. */
  const explodeAtRef = useRef<(id: string) => void>(() => {});
  const openDrawer = useCallback((d: Drawer) => {
    if (d.kind === "example" && d.of) {
      explodeAtRef.current(d.of);
      return;
    }
    if (d.kind === "preview" && d.id === liveRef.current) {
      setGhostPref((p) => showGhost(d.id, p));
      setMode("3d");
      return;
    }
    setSlots((s) => openSlot(s, d));
  }, []);
  const closeSlot = useCallback((kind: Drawer["kind"]) => setSlots((s) => ({ ...s, [kind]: null })), []);
  /** The 3D view fills the screen, with the chat and panels put away. */
  const [full, setFull] = useState(false);
  /** The newest preview and example the window has seen, so only new examples open by themselves, and a new preview puts the drawer away. */
  const seen = useRef<{ slug: string; preview: string | null; example: string | null } | undefined>(undefined);
  const [fitCount, setFitCount] = useState(0);
  /** Another app asked the 3D view to keep turning, at this many degrees a second. Null holds it still. */
  const [orbit, setOrbit] = useState<number | null>(null);
  const viewportApi = useRef<ViewportApi | null>(null);
  const layout = useLayout();
  const phone = layout === "phone";
  const [tablet] = useState(() => startLayout() === "tablet");
  const [leftW, setLeftW] = usePanelWidth("woodchuck.left", tablet ? MIN_PANEL : 360);
  const [rightW, setRightW] = usePanelWidth("woodchuck.right", tablet ? 300 : 380);
  const [leftOpen, setLeftOpen] = useOpen("woodchuck.leftOpen", tablet);
  const [rightOpen, setRightOpen] = useOpen("woodchuck.rightOpen");
  /** The last thing that failed, shown beside the control that did it until that control next works. */
  const [error, setError] = useState<{ where: Where; text: string } | null>(null);
  const fail = useCallback((where: Where, text: string) => setError({ where, text }), []);
  const clear = useCallback((where: Where) => setError((e) => (e?.where === where ? null : e)), []);
  /** On a phone, the bottom sheet that holds the chat or the tabs. It follows the same open states and tab as the columns. */
  const shell = usePhoneShell({
    phone,
    ready: state !== null,
    chat: leftOpen,
    panels: rightOpen,
    setChat: setLeftOpen,
    setPanels: setRightOpen,
    tab,
    picked: [...selection, ...faces].join(","),
    page: allPage !== null,
  });
  const undoneNote = useUndoneNote(phone, state);
  /** Undo or redo while it runs, with the history it started from, so the button shows it's busy until the change lands. */
  const [undoing, setUndoing] = useState<{ which: "undo" | "redo"; from: string } | null>(null);
  /** A short note over the 3D view, such as when something outside it changes the view or a file is saved. */
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const note = useCallback((text: string) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);
  // When Claude changes colours, a window in the Plain look switches to
  // Finished so you can see them. Only Claude's own new change does this.
  const lookNow = useRef(look);
  lookNow.current = look;
  const changed = useClaudeGlow(state, () => {
    if (lookNow.current !== "plain") return;
    setLook("finished");
    note("Switched to the Finished look to show Claude's colours.");
  });
  // Undo and Redo stay busy until their change reaches this window.
  const historyKey = state ? `${state.project.slug}:${state.history.length}:${state.history.at(-1)?.id ?? 0}:${state.redo}` : "";
  useEffect(() => setUndoing((u) => (u && u.from !== historyKey ? null : u)), [historyKey]);
  const stateRef = useRef(state);
  stateRef.current = state;
  const ghostRef = useRef(ghostPref);
  ghostRef.current = ghostPref;
  const tabRef = useRef(tab);
  tabRef.current = tab;
  /** The view settings now, for commands from outside the window. */
  const explodeNow = explodeOn ? explode.amount : 0;
  const viewNow = useRef<ViewState>({ mode, look, lighting, view, planView, xray, photo: photoOn === "on", full, explode: explodeNow, focusJoint });
  viewNow.current = { mode, look, lighting, view, planView, xray, photo: photoOn === "on", full, explode: explodeNow, focusJoint };
  /** The keyboard shortcuts, set each render so they act on what's showing now. */
  const onShortcut = useRef<(e: KeyboardEvent) => void>(() => {});
  /** The latest Render, so a request from outside renders what the window shows then. */
  const renderRef = useRef<(() => Promise<void>) | null>(null);
  // Claude drives the screen you'd use: the same tabs, picks and camera you
  // would, until you touch anything.
  const follow = useFollow(state, { selection, faces }, {
    openTab: (t, make) => {
      setTab(t);
      setAllPage(null);
      if (make) setMakeView(make);
      if (!full) setRightOpen(true);
    },
    pick: (ids) => {
      setFaces([]);
      setSelection(ids);
    },
    restore: (p) => {
      setSelection(p.selection);
      setFaces(p.faces);
    },
    // The camera stays lined up with a room photo.
    frame: (box) => !(photoOn === "on" && state?.backdrop) && setFrame((f) => ({ box, key: (f?.key ?? 0) + 1 })),
    note,
  });

  // Another chat, such as Crossband, can change what this window shows.
  useEffect(() => {
    const onView = (e: Event) => {
      const v = (e as CustomEvent<ViewCommand>).detail;
      // The same settings the toolbar's controls change, so each command shows on its control.
      const { state: next, effects } = applyView(viewNow.current, v, !!stateRef.current?.backdrop);
      setMode(next.mode);
      setXray(next.xray);
      if (v.photo !== undefined || next.photo !== viewNow.current.photo) setPhotoOn(next.photo ? "on" : "off");
      setLook(next.look);
      setLighting(next.lighting);
      setView(next.view);
      setPlanView(next.planView);
      // A joint opens as its card's button opens it. Back together, the joint it showed lets go once every part is home.
      if (effects.focus) explodeAtRef.current(effects.focus);
      if (v.explode !== undefined || v.focusJoint !== undefined || (v.photo && stateRef.current?.backdrop)) {
        const on = next.explode > 0;
        setExplodeOn(on);
        setExplode({ amount: next.explode, glide: true });
        if (on && !effects.focus) {
          setFocusJoint(next.focusJoint);
          if (!next.focusJoint) frameApart.current = true;
          // A suggested change shows the piece together, so it's put away, as Hide does.
          const waiting = liveRef.current;
          if (waiting) setGhostPref((p) => hideGhost(waiting, p));
        }
      }
      if (effects.refit) setFitCount((n) => n + 1);
      setFull(next.full);
      // An orbit keeps going until it's stopped. A room photo holds the
      // camera to its line-up, and a computer set to reduce motion keeps
      // the model still.
      let still: string | null = null;
      if (effects.orbit === "stop") setOrbit(null);
      else if (effects.orbit !== null) {
        if (next.photo && stateRef.current?.backdrop) still = "the model stays still in the room photo, so it keeps its line-up.";
        else if (lessMotion()) still = "this computer is set to reduce motion, so the model stays still.";
        else setOrbit(effects.orbit);
      }
      // The waiting change shows on the model, a joint in the drawer, picked parts open Edit, and a tab opens with its panel.
      const routed = routeView(effects, { liveId: liveRef.current, pref: ghostRef.current, tab: tabRef.current });
      if (routed.select) {
        setFaceMode(false);
        setFaces([]);
        setSelection(routed.select);
      }
      if (routed.tab) {
        setTab(routed.tab);
        setAllPage(null);
      }
      if (routed.panel) setRightOpen(true);
      if (routed.ghost) setGhostPref(routed.ghost);
      if (routed.drawer === "close") setSlots(NO_SLOTS);
      else if (routed.drawer) {
        const { joint } = routed.drawer;
        setSlots((s) => openSlot(s, { kind: "example", joint }));
      }
      // Turning, zooming and rendering wait for the view above to be in place.
      const nudge = effects.nudge;
      if (nudge) setTimeout(() => viewportApi.current?.nudge(nudge.turn, nudge.zoom), 150);
      if (effects.render) setTimeout(() => void renderRef.current?.(), 900);
      // The caller's name starts the line, so it takes a capital, as "another app" does here.
      const who = v.from ? v.from.charAt(0).toUpperCase() + v.from.slice(1) : "Another chat";
      if (still && !routed.note) note(`${who} asked for the model to keep turning, but ${still}`);
      else note(routed.note ? `${who}: ${routed.note}` : v.note ? `${who}: ${v.note}` : `${who} changed the view: ${describeView(v)}.`);
    };
    viewRequests.addEventListener("view", onView);
    return () => viewRequests.removeEventListener("view", onView);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The plan views and the room photo hold the camera still, so an orbit stops for them.
  const photoUp = photoOn === "on" && !!state?.backdrop;
  useEffect(() => {
    if (mode === "2d" || photoUp) setOrbit(null);
  }, [mode, photoUp]);

  // A preview in the drawer that's applied, such as from Crossband, closes
  // in this window too. Reopening an old one with "See it again" still
  // works: only a change of answer closes it. It comes after the colours
  // note, so its own note wins when both happen.
  const shownPreview = useRef<{ id: string; status: string } | null>(null);
  const previewId = slots.preview;
  useEffect(() => {
    if (!state || !previewId) {
      shownPreview.current = null;
      return;
    }
    const item = state.chat.find((c) => c.kind === "preview" && c.id === previewId);
    const status = item?.kind === "preview" ? item.status : "gone";
    const before = shownPreview.current;
    shownPreview.current = { id: previewId, status };
    if (!before || before.id !== previewId || before.status === status) return;
    closeSlot("preview");
    note(status === "applied" ? "The preview was applied." : status === "failed" ? "The preview couldn't be applied." : "The preview was turned down.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, previewId]);

  // The ghost of the waiting change goes when it's answered, here or
  // anywhere else, and the window says how it was answered.
  const answering = useRef<string | null>(null);
  useEffect(() => {
    if (!state) return;
    if (liveId) {
      answering.current = liveId;
      return;
    }
    const id = answering.current;
    if (!id) return;
    const item = state.chat.find((c) => c.kind === "preview" && c.id === id);
    // While Claude works on the answer, the change is still proposed.
    if (item?.kind === "preview" && item.status === "proposed") return;
    answering.current = null;
    if (item?.kind !== "preview") return;
    note(
      item.status === "applied"
        ? "The suggested change was applied."
        : item.status === "failed"
          ? "The suggested change couldn't be applied."
          : "The suggested change was turned down, so nothing changed.",
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, liveId]);

  // The waiting change, worked out against the design as it is now, and what the model draws for it.
  const opsKey = live ? JSON.stringify(live.ops) : "";
  const preview = useMemo(
    () => (live && state ? previewChange(state, live.ops) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [liveId, opsKey, state?.design, state?.derived, state?.report],
  );
  const shown = ghostShown(liveId, ghostPref);
  const fits = preview && !("error" in preview) ? preview : null;
  const names = useMemo(() => partNamer(state?.derived.parts ?? []), [state?.derived.parts]);
  // A change you're typing takes the model's ghost while you type it.
  const drawn = useMemo(
    () => (state ? (draft ? draftView(state, draft, names) : modelView(state, fits, shown?.side ?? null, names)) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state?.design, state?.derived, fits, shown?.side, names, draft],
  );
  // The way the piece, or one joint, comes apart, worked out while it's apart or going back together.
  const exploding = explodeOn || apart;
  const piecePlan = useMemo(
    () => (drawn && exploding && !focusJoint ? explodePiece(drawn.parts, drawn.joints, drawn.hardware) : null),
    [drawn, exploding, focusJoint],
  );
  const jointPlan = useMemo(() => (drawn && focusJoint ? explodeJoint(drawn.parts, drawn.joints, focusJoint) : null), [drawn, focusJoint]);
  // Once it's back together with Explode off, the joint it showed lets go. A joint that's gone does too.
  useEffect(() => {
    if (focusJoint && ((!explodeOn && !apart) || (drawn && !jointPlan))) setFocusJoint(null);
  }, [focusJoint, explodeOn, apart, drawn, jointPlan]);
  // Its section goes with it.
  useEffect(() => {
    if (!focusJoint) setSlots((s) => (s.section ? { ...s, section: null } : s));
  }, [focusJoint]);
  // Explode and Whole piece frame the piece apart, from where you're looking.
  useEffect(() => {
    if (!frameApart.current || !piecePlan || !drawn) return;
    frameApart.current = false;
    const off = explodeOffsets(piecePlan, 1);
    const boxes = drawn.parts.filter((p) => !p.broken).flatMap((p) => {
      const o = off.get(p.id) ?? [0, 0, 0];
      return [p.nominal, { min: p.nominal.min.map((v, k) => v + o[k]!) as Box["min"], max: p.nominal.max.map((v, k) => v + o[k]!) as Box["max"] }];
    });
    if (!boxes.length) return;
    const box: Box = {
      min: [0, 1, 2].map((k) => Math.min(...boxes.map((b) => b.min[k]!))) as Box["min"],
      max: [0, 1, 2].map((k) => Math.max(...boxes.map((b) => b.max[k]!))) as Box["max"],
    };
    setFrame((f) => ({ box, key: (f?.key ?? 0) + 1 }));
  }, [piecePlan, drawn]);

  useEffect(() => {
    if (!state) return;
    const ids = new Set(state.derived.parts.map((p) => p.id));
    setSelection((s) => s.filter((id) => ids.has(id)));
    setFaces((f) => f.filter((key) => ids.has(key.slice(0, key.lastIndexOf(".")))));
  }, [state]);

  const slug = state?.project.slug;
  useEffect(() => {
    if (!slug) return;
    try {
      setPhotoSettingsState({ ...DEFAULT_PHOTO, ...(JSON.parse(localStorage.getItem(`woodchuck.photo.${slug}`) ?? "{}") as Partial<PhotoSettings>) });
    } catch {
      setPhotoSettingsState(DEFAULT_PHOTO);
    }
  }, [slug]);
  const setPhotoSettings = (p: PhotoSettings) => {
    setPhotoSettingsState(p);
    try {
      localStorage.setItem(`woodchuck.photo.${slug}`, JSON.stringify(p));
    } catch {
      // Storage refused: the lens and shadow just won't be remembered.
    }
  };
  useEffect(() => {
    setPins([]);
    setSlots(NO_SLOTS);
    setGhostPref(null);
    setFrame(null);
    setExplodeOn(false);
    setExplode({ amount: 0, glide: false });
    setFocusJoint(null);
    answering.current = null;
  }, [slug]);

  // Open the drawer when Claude shows a new joint example, but not for ones
  // already in the chat when the app loads. A new preview is drawn on the
  // model, and it puts the drawer away so the ghost shows clear of it.
  useEffect(() => {
    if (!state) return;
    const preview = [...state.chat].reverse().find((c) => c.kind === "preview");
    const example = [...state.chat].reverse().find((c) => c.kind === "example");
    const now = { slug: state.project.slug, preview: preview?.id ?? null, example: example?.id ?? null };
    const before = seen.current;
    seen.current = now;
    // A design you've just opened shows as it is, with no drawer opening by itself.
    if (before === undefined || before.slug !== now.slug) return;
    if (example?.kind === "example" && now.example !== before.example) {
      if (example.of) explodeAtRef.current(example.of);
      else setSlots((s) => openSlot(s, { kind: "example", joint: example.joint, ...(example.note ? { note: example.note } : {}), ...(example.stopped ? { stopped: true as const } : {}) }));
    }
    if (preview?.kind === "preview" && now.preview !== before.preview && preview.status === "proposed") {
      setSlots(NO_SLOTS);
      setGhostPref(null);
    }
  }, [state]);

  // A window that opens or comes back into view warms Claude's prompt cache, if it's gone cold.
  useEffect(() => warmWhenSeen(document, () => void post("/api/warm", { from: "window" }).catch(() => undefined)), []);

  // After an update the server serves a new build. Reload onto it when
  // nothing would be lost: no unsent message, and Claude isn't replying.
  // Otherwise say so, and reload as soon as it's safe.
  useEffect(() => {
    if (!state) return;
    if (firstBuild.current === null) {
      firstBuild.current = state.build;
      return;
    }
    if (state.build === firstBuild.current) return;
    const draft = document.querySelector<HTMLTextAreaElement>(".chat textarea")?.value.trim();
    if (!draft && !state.busy) location.reload();
    else setUpdated(true);
  }, [state]);

  // Leaving the browser's full screen, with Esc or otherwise, puts the panels back.
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) setFull(false);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // Esc puts the tool back to Select and leaves full screen. The other keys are the toolbar's shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPointMode("pick");
        setFull(false);
        setAllPage(null);
        return;
      }
      onShortcut.current(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!state) {
    return <div className="loading">{connected ? "Loading…" : "Connecting to the Woodchuck server on this computer…"}</div>;
  }

  // You select either parts or faces, never both, so it's clear what a finish goes on.
  // Picking parts opens Edit, from the model, the cut list or anywhere else,
  // except that picking them while you try colours keeps you in Finish.
  const select = (ids: string[], opts: { stay?: boolean } = {}) => {
    setSelection(ids);
    if (ids.length) {
      setFaces([]);
      if (!opts.stay) {
        setTab((t) => tabAfterPick(t));
        setAllPage(null);
      }
    } else {
      setFaceFilter([...FACES]);
    }
  };
  const selectFaces = (keys: string[]) => {
    setFaces(keys);
    if (keys.length) {
      setSelection([]);
      setTab("finish");
    }
  };
  // Switching between whole pieces and single faces keeps what you'd picked:
  // pieces become their faces, so a shift-click can take one away, and
  // faces become their pieces.
  const switchFaceMode = (on: boolean) => {
    if (on === faceMode) return;
    setFaceMode(on);
    if (on) {
      setFaces(selection.flatMap((id) => faceFilter.map((f) => `${id}.${f}`)));
      setSelection([]);
    } else {
      setSelection([...new Set(faces.map((f) => f.slice(0, f.lastIndexOf("."))))]);
      setFaces([]);
    }
    setFaceFilter([...FACES]);
  };
  // In the Finish tab, the faces a colour will land on show in blue.
  const marks =
    tab === "finish" && selection.length && faceFilter.length < FACES.length ? selection.flatMap((id) => faceFilter.map((f) => `${id}.${f}`)) : [];
  // Full screen uses the browser's own where it's allowed, and fills the
  // window either way.
  const toggleFull = () => {
    if (full) {
      setFull(false);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    } else {
      setFull(true);
      void document.documentElement.requestFullscreen?.().catch(() => {});
    }
  };
  const backdropUrl = state.backdrop ? `/api/references/${state.backdrop}` : null;
  // The photo stays behind the 3D view under the 2D view, so coming back is instant.
  const photoShown = photoOn === "on" && !!backdropUrl;
  const inPhoto = photoShown && mode === "3d";
  const saveRender = async () => {
    // In the plan views, the picture is the drawings.
    if (mode === "2d") {
      const file = `${state.design.name} (plan views).png`;
      const a = document.createElement("a");
      a.href = `/api/plans.png${xray ? "?xray=1" : ""}`;
      a.download = file;
      a.click();
      clear("view");
      note(savedNote("the plan views", file));
      return;
    }
    const url = viewportApi.current?.snapshot();
    if (!url) return fail("view", "Couldn't make the picture. Try Render again once the model has drawn.");
    const a = document.createElement("a");
    // In a photo, the model goes over the photo at the photo's own size.
    a.href = inPhoto ? await compose(backdropUrl!, url) : url;
    a.download = `${state.design.name} (${inPhoto ? "in your photo" : look === "finished" ? lighting : "plain"}).png`;
    a.click();
    clear("view");
    note(savedNote("a picture of this view", a.download));
  };
  // The AI blend: OpenAI relights the placed piece so it matches the room.
  // Without a key it can't run, so it says so before asking you to pay.
  const runBlend = async () => {
    if (!backdropUrl) return;
    if (!state.has_openai_key) return fail("photo", BLEND_NEEDS_KEY);
    if (!confirm("Send this picture to OpenAI to blend the light? Your room photo goes to OpenAI, and each blend costs money.")) return;
    const model = viewportApi.current?.snapshot();
    if (!model) return fail("photo", "Couldn't make the picture to blend. Try again once the model has drawn.");
    setBlending(true);
    setBlendResult(null);
    try {
      const before = await compose(backdropUrl, model);
      const { fit, image, mask } = await blendInputs(backdropUrl, model);
      const r = await fetch("/api/blend", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ image, mask, size: fit.size }) });
      const j = (await r.json()) as { url?: string; error?: string };
      if (!r.ok || !j.url) return fail("photo", j.error ?? "The AI blend didn't work");
      const after = await pasteBack(backdropUrl, model, j.url, fit);
      // The copy to save carries the label, and the one on screen has a live label over it.
      setBlendResult({ before, after, labelled: await withLabel(after, "blend") });
      clear("photo");
    } catch (e) {
      fail("photo", `The AI blend didn't work: ${(e as Error).message}`);
    } finally {
      setBlending(false);
    }
  };
  renderRef.current = saveRender;
  // A photo comes from the view bar's Photo button or the photo bar's Change photo, and an error shows beside whichever you used.
  const loadPhoto = async (f: File, where: Where) => {
    try {
      const r = await post("/api/backdrop", await readPhoto(f));
      if (!r.ok) return fail(where, r.error ?? "Couldn't keep that photo");
      clear(where);
      setPhotoOn("on");
      setMode("3d");
    } catch {
      fail(where, "That photo couldn't be read. Try a JPEG, PNG or WebP.");
    }
  };
  const { errors, warnings, ready_to_cut } = state.report;
  /** Says how a request went, beside the control that sent it. */
  const say = (where: Where, r: { ok: boolean; error?: string }) => (r.ok ? clear(where) : fail(where, r.error ?? "That didn't work"));
  const errorAt = (where: Where) =>
    error?.where === where ? (
      <div className={`error-note at-${where}`} role="alert">
        <span>{error.text}</span>
        <button className="link" title="Dismiss" aria-label="Dismiss" onClick={() => setError(null)}>
          ×
        </button>
      </div>
    ) : null;
  const undoRedo = async (which: "undo" | "redo") => {
    setUndoing({ which, from: historyKey });
    // If nothing comes back, such as when another window undid it first, the button frees itself.
    setTimeout(() => setUndoing(null), 10_000);
    const r = await post(`/api/${which}`);
    if (!r.ok) setUndoing(null);
    say("history", r);
  };

  // While the server is away, nothing here can save, so every control
  // pauses under a bar that says so, and comes back with the connection.
  const offline = !connected;
  // On an empty design the view controls that act on a part wait for one.
  const empty = state.derived.parts.length === 0;

  const ghostOn = !!drawn?.ghost;
  const tools = toolbarState(viewNow.current, { pointMode, hasPhoto: !!backdropUrl, empty, paper, ghost: ghostOn, exploded: explodeOn });
  const controls = allControls(tools);
  /** Runs a control's action only when the control could: a shortcut never does what a disabled button can't. */
  const can = (id: string) => controls.get(id)?.disabled === false;
  const chooseCamera = (v: CameraView) => {
    setView(v);
    setOrbit(null);
    // Choosing the view you're on brings it back square, after a turn.
    setFitCount((n) => n + 1);
  };
  const toggleSeeThrough = () => setXray(!xray);
  // The plan views, the room photo and a suggested change show the piece together.
  const canExplode = mode === "3d" && !inPhoto && !ghostOn && !empty;
  /** The whole of the piece, together, for framing it again. */
  const wholeBox = (): Box | null => boxOf(state.derived.parts, state.derived.parts.filter((p) => !p.broken).map((p) => p.id));
  const toggleExplode = () => {
    if (explodeOn) {
      setExplodeOn(false);
      setExplode({ amount: 0, glide: true });
      const box = wholeBox();
      if (box) setFrame((f) => ({ box, key: (f?.key ?? 0) + 1 }));
      return;
    }
    setFocusJoint(null);
    setExplodeOn(true);
    setExplode({ amount: 1, glide: true });
    frameApart.current = true;
  };
  /** Pulls one joint apart on its own and frames it, as the Edit tab's joint cards ask. */
  const explodeAt = (id: string) => {
    const plan = explodeJoint(state.derived.parts, state.derived.joints, id);
    if (!plan) return;
    setMode("3d");
    if (photoOn === "on") setPhotoOn("off");
    if (live && shown) setGhostPref((p) => hideGhost(live.id, p));
    setFocusJoint(id);
    setExplodeOn(true);
    setExplode({ amount: 1, glide: true });
    setFrame((f) => ({ box: plan.focus, key: (f?.key ?? 0) + 1 }));
    // Its section and sizes slide out beside it.
    setSlots((s) => openSlot(s, { kind: "joint", id }));
  };
  explodeAtRef.current = explodeAt;
  const wholePiece = () => {
    setFocusJoint(null);
    setExplode({ amount: 1, glide: true });
    frameApart.current = true;
  };
  /** A part's name, with its id when other parts share the name, such as the four legs of a table. */
  const named = (id: string) => {
    const n = names(id);
    return state.derived.parts.filter((p) => names(p.id) === n).length > 1 ? `${n} (${id})` : n;
  };
  const plan = jointPlan ?? piecePlan;
  const explodeView: ExplodeView | null = plan
    ? {
        plan,
        amount: explodeOn && canExplode ? explode.amount : 0,
        glide: explode.glide || !canExplode || !explodeOn,
        joint: jointPlan ? { id: jointPlan.joint, host: jointPlan.host, guest: jointPlan.guest } : null,
      }
    : null;
  const choosePhoto = () => (backdropUrl ? setPhotoOn(inPhoto ? "off" : "on") : photoFile.current?.click());
  // In the photo, the 3D view shows it; from the 2D view, Photo brings the 3D view back.
  const onPhoto = () => {
    if (mode === "2d" && backdropUrl) {
      setMode("3d");
      setPhotoOn("on");
    } else choosePhoto();
  };
  const saveDrawings = () => {
    const a = document.createElement("a");
    a.href = drawingsUrl(paper);
    a.click();
    note(drawingsNote(state.project.slug, paper));
  };
  const focusChat = () => {
    if (full) toggleFull();
    setLeftOpen(true);
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".chat textarea")?.focus());
  };
  // Check's fixes: the request goes in the chat box, and Show me picks and frames the parts in the 3D view.
  const askClaude = (text: string) => {
    if (full) toggleFull();
    setLeftOpen(true);
    setFillReq((f) => ({ text, n: (f?.n ?? 0) + 1 }));
  };
  const showMe = (ids: string[]) => {
    select(ids, { stay: true });
    setMode("3d");
    const box = boxOf(state.derived.parts, ids);
    if (box) setFrame((f) => ({ box, key: (f?.key ?? 0) + 1 }));
  };
  // The ghost of the waiting change: See it flips the model, and the switch over the model picks a side.
  const see = (id: string) => {
    if (id !== liveId) return openDrawer({ kind: "preview", id });
    setGhostPref((p) => seeIt(id, p));
    setMode("3d");
  };
  const ghostSide = (side: Side) => liveId && setGhostPref((p) => showGhost(liveId, p, side));
  const openPage = (section?: Section) => {
    setRightOpen(true);
    if (full) toggleFull();
    const waiting = waitingIn(state);
    setAllPage({ section: section ?? ALL_SECTIONS.find((sec) => waiting[sec.id] > 0)?.id ?? null });
  };
  const runShortcut = (sc: Shortcut) => {
    switch (sc.do) {
      case "undo":
      case "redo":
        if (sc.do === "undo" ? state.history.length && !state.busy && !undoing : state.redo && !state.busy && !undoing) void undoRedo(sc.do);
        return;
      case "fit":
        if (can("fit")) setFitCount((n) => n + 1);
        return;
      case "see-through":
        if (can("see-through")) toggleSeeThrough();
        return;
      case "explode":
        if (can("explode")) toggleExplode();
        return;
      case "camera":
        if (can(`camera.${sc.view}`)) chooseCamera(sc.view);
        return;
      case "tool":
        if (can(`tool.${sc.tool}`)) setPointMode(sc.tool);
        return;
      case "chat":
        focusChat();
        return;
    }
  };
  onShortcut.current = (e) => {
    if (offline) return;
    const sc = shortcutFor(e, e.target as HTMLElement | null);
    if (!sc) return;
    e.preventDefault();
    setMenu(null);
    runShortcut(sc);
  };

  return (
    <div
      className={`app${full ? " full" : ""}${offline ? " offline" : ""}${phone ? ` ${shell.className}` : ""}`}
      style={{
        gridTemplateColumns: full
          ? "minmax(0, 1fr)"
          : `${leftOpen ? `${leftW}px 6px` : "22px"} minmax(0, 1fr) ${rightOpen ? `6px ${rightW}px` : "22px"}`,
      }}
    >
      {offline && (
        <div className="offline-bar" role="status">
          <strong>Reconnecting to Woodchuck on this computer…</strong> Edits are paused until it's back. Everything up to now is saved.
        </div>
      )}
      <header className="topbar" inert={offline}>
        <span className="brand">Woodchuck</span>
        {!phone && <PasskeysButton open={passkeys} onOpen={setPasskeys} />}
        <span className="topbar-group design-group">
          <DesignMenu
            state={state}
            open={menu === "design"}
            onOpen={(o) => setMenu(o ? "design" : null)}
            onResult={(r) => say("design", r)}
            onSwitched={() => setSelection([])}
            onShowAll={openPage}
            onSaved={note}
            extra={
              phone ? (
                <>
                  <PasskeysButton
                    open={passkeys}
                    onOpen={(o) => {
                      setMenu(null);
                      setPasskeys(o);
                    }}
                  />
                  <FollowSwitch on={follow.enabled} onChange={follow.setEnabled} />
                  <ThemeSwitch />
                </>
              ) : null
            }
          />
          {errorAt("design")}
        </span>
        <span className="spacer" />
        {updated && (
          <span className="notice small">
            Woodchuck has been updated.{" "}
            <button className="link" onClick={() => location.reload()}>
              Reload
            </button>{" "}
            to use it.
          </span>
        )}
        <span className="topbar-group">
          <button
            className={undoing?.which === "undo" ? "working-button" : ""}
            disabled={!state.history.length || state.busy || !!undoing}
            aria-busy={undoing?.which === "undo"}
            aria-keyshortcuts="Meta+Z"
            onClick={() => void undoRedo("undo")}
            title={state.busy ? WAIT_FOR_CLAUDE : TIPS.undo}
          >
            {undoing?.which === "undo" ? "Undoing…" : "Undo"}
          </button>
          <button
            className={`redo-button${undoing?.which === "redo" ? " working-button" : ""}`}
            disabled={!state.redo || state.busy || !!undoing}
            aria-busy={undoing?.which === "redo"}
            aria-keyshortcuts="Shift+Meta+Z"
            onClick={() => void undoRedo("redo")}
            title={state.busy ? WAIT_FOR_CLAUDE : TIPS.redo}
          >
            {undoing?.which === "redo" ? "Redoing…" : "Redo"}
          </button>
          {errorAt("history")}
        </span>
        <button
          className={`status ${ready_to_cut ? "ok" : errors ? "bad" : "warn"}`}
          title="Open the Check tab"
          onClick={() => {
            setTab(PILL_TAB);
            setAllPage(null);
            setRightOpen(true);
            if (full) toggleFull();
          }}
        >
          {statusWords({ errors, warnings, ready_to_cut }, state.derived.parts.length === 0, phone)}
        </button>
        {!phone && <FollowSwitch on={follow.enabled} onChange={follow.setEnabled} />}
        {!phone && <ThemeSwitch />}
      </header>
      <Passkeys open={passkeys} onClose={closePasskeys} />
      {!leftOpen && <Rail label="Chat" onOpen={() => setLeftOpen(true)} />}
      <aside className="left" hidden={!leftOpen && !phone} inert={offline}>
        {phone && <SheetBar shell={shell} />}
        {phone && undoneNote.undone && (
          <UndoneNote undone={undoneNote.undone} canRedo={!!state.redo && !state.busy && !undoing} onRedo={() => void undoRedo("redo")} onDismiss={undoneNote.dismiss} />
        )}
        <ChatPanel
          state={state}
          selection={[...selection, ...faces]}
          onSelect={(ids) => {
            select(ids.filter((s) => !isFace(s)));
            setFaces(ids.filter(isFace));
          }}
          pins={pins}
          onPins={setPins}
          captureView={() => (mode === "3d" ? (viewportApi.current?.capture() ?? null) : null)}
          onOpen={openDrawer}
          onSee={see}
          seeing={shown?.side === "after" ? shown.id : null}
          previewDetail={
            preview && "error" in preview ? (
              <p className="form-error small">This no longer fits the design as it is now: {preview.error}</p>
            ) : fits ? (
              <ChangeLists result={fits} removed={fits.removed.map(names)} compact />
            ) : null
          }
          fill={fillReq}
          onShowHow={follow.replay}
          onStep={follow.showStep}
          placeOf={follow.placeOf}
          compact={phone}
        />
      </aside>
      {leftOpen && <Splitter label="Resize the chat panel" side="left" onDrag={(x) => setLeftW(x)} onCollapse={() => setLeftOpen(false)} />}
      <main className="centre" inert={offline}>
        {toast && (
          <div className="toast" role="status">
            {toast}
          </div>
        )}
        <Toolbar
          compact={layout !== "desktop"}
          state={tools}
          menu={menu === "design" ? null : menu}
          onMenu={setMenu}
          onTool={setPointMode}
          onCamera={chooseCamera}
          onFit={() => setFitCount((n) => n + 1)}
          onSeeThrough={toggleSeeThrough}
          onExplode={toggleExplode}
          onLook={setLook}
          onLighting={setLighting}
          onMode={setMode}
          onRender={() => void saveRender()}
          onPhoto={onPhoto}
          onFull={toggleFull}
          onDrawings={saveDrawings}
        />
        <input
          ref={photoFile}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void loadPhoto(f, "view");
            e.target.value = "";
          }}
        />
        {errorAt("view")}
        <div className={`stage${slots.section ? " beside-joint" : ""}`}>
          <FollowChip mode={follow.chip} onStop={follow.stop} />
          {/* The 3D view stays put under the 2D view, so coming back to it is instant. */}
          <div className="canvas-wrap" inert={mode === "2d"} aria-hidden={mode === "2d" || undefined}>
            {(() => {
              const viewport = (
                <Viewport
                  parts={drawn!.parts}
                  joints={drawn!.joints}
                  hardware={drawn!.hardware}
                  ghost={drawn!.ghost}
                  outline={drawn!.outline}
                  frame={frame}
                  selection={selection}
                  highlight={changed}
                  view={view}
                  xray={xray}
                  fitKey={String(fitCount)}
                  autoFit
                  designKey={state.project.slug}
                  paused={mode === "2d"}
                  orbit={orbit}
                  onOrbitEnd={() => setOrbit(null)}
                  explode={explodeView}
                  onApart={setApart}
                  mode={pointMode}
                  pins={pins}
                  apiRef={viewportApi}
                  onSelect={select}
                  design={drawn!.design}
                  look={look}
                  lighting={lighting}
                  faceMode={faceMode && (pointMode === "pick" || pointMode === "box")}
                  faces={faces}
                  onFaces={selectFaces}
                  onClickFace={setLastFace}
                  marks={marks}
                  onPin={(p) => setPins((all) => [...all, { ...p, n: Math.max(0, ...all.map((x) => x.n)) + 1 }])}
                  photo={photoShown ? { ...photoSettings, memoryKey: `woodchuck.photoCamera.${state.project.slug}.${state.backdrop}` } : null}
                />
              );
              return photoShown ? (
                <PhotoStage
                  url={backdropUrl!}
                  settings={photoSettings}
                  onSettings={setPhotoSettings}
                  onChange={(f) => void loadPhoto(f, "photo")}
                  onRemove={async () => {
                    const r = await post("/api/backdrop/clear");
                    say("photo", r);
                    if (r.ok) setPhotoOn("off");
                  }}
                  onDone={() => setPhotoOn("off")}
                  busy={state.busy}
                  onBlend={() => void runBlend()}
                  canBlend={state.has_openai_key}
                  error={errorAt("photo")}
                  onSaved={note}
                  blending={blending}
                  blendResult={blendResult}
                  onCloseBlend={() => setBlendResult(null)}
                  name={state.design.name}
                >
                  {viewport}
                </PhotoStage>
              ) : (
                viewport
              );
            })()}
          </div>
          {explodeOn && canExplode && (
            <ExplodeBar
              amount={explode.amount}
              stages={piecePlan?.stages ?? 1}
              joint={
                jointPlan
                  ? {
                      title: `${JOINT_LIBRARY[state.derived.joints.find((j) => j.id === jointPlan.joint)?.type ?? "butt"].name}: ${named(jointPlan.guest)} into ${named(jointPlan.host)}`,
                      passes: jointPlan.passes.map(named),
                      mover: named(jointPlan.moves[0]?.parts[0] ?? jointPlan.guest),
                    }
                  : null
              }
              locked={(piecePlan?.locked ?? []).map((set) => set.map(named))}
              onAmount={(amount) => setExplode({ amount, glide: false })}
              {...(focusJoint && slots.section !== focusJoint ? { onSection: () => setSlots((s) => openSlot(s, { kind: "joint", id: focusJoint })) } : {})}
              onWholePiece={wholePiece}
              onClose={toggleExplode}
            />
          )}
          {live && mode === "3d" && !draft && (
            <GhostSwitch
              title={live.title}
              side={shown?.side ?? "now"}
              hidden={!shown}
              error={preview && "error" in preview ? preview.error : null}
              words={drawn?.ghost?.marks.map((m) => m.words).slice(0, 2) ?? []}
              finishNote={!!fits?.aboutFinish && look === "plain" && !inPhoto}
              onSide={ghostSide}
              onHide={() => setGhostPref((p) => hideGhost(live.id, p))}
              onShow={() => setGhostPref((p) => showGhost(live.id, p))}
              onFinished={() => setLook("finished")}
            />
          )}
          {mode === "2d" && (
            <ViewsPanel
              version={state.history.length * 1000 + state.redo}
              xray={xray}
              view={planView}
              onView={setPlanView}
              slug={state.project.slug}
              paper={paper}
              onPaper={setPaper}
              onSaved={note}
              empty={empty}
            />
          )}
          {/* The drawer sits under the toolbar, so the toolbar stays whole while it's open. */}
          {slots.example && (
            <PreviewDrawer
              state={state}
              drawer={{ kind: "example", ...slots.example }}
              onClose={() => closeSlot("example")}
              onOpen={openDrawer}
              look={look}
              lighting={lighting}
              paired={!!slots.preview}
            />
          )}
          {slots.section && (
            <PreviewDrawer
              state={state}
              drawer={{ kind: "joint", id: slots.section }}
              onClose={() => setSlots((s) => ({ ...s, section: null }))}
              onOpen={openDrawer}
              look={look}
              lighting={lighting}
              paired={!!slots.preview}
            />
          )}
          {slots.preview && (
            <PreviewDrawer
              state={state}
              drawer={{ kind: "preview", id: slots.preview }}
              onClose={() => closeSlot("preview")}
              onOpen={openDrawer}
              look={look}
              lighting={lighting}
              paired={!!slots.example || !!slots.section}
            />
          )}
        </div>
      </main>
      {rightOpen && <Splitter label="Resize the side panel" side="right" onDrag={(x) => setRightW(window.innerWidth - x)} onCollapse={() => setRightOpen(false)} />}
      <aside className="right" hidden={!rightOpen} inert={offline}>
        <TabBar
          tab={tab}
          onTab={(t) => {
            setTab(t);
            setAllPage(null);
          }}
          report={state.report}
        />
        <FollowCaption view={follow.view} />
        {tab === "edit" && (
          <EditTab
            state={state}
            selection={selection}
            onSelect={select}
            onShowJoint={(type) => openDrawer({ kind: "example", joint: type })}
            onExplodeJoint={explodeAt}
            onDraft={setDraft}
          />
        )}
        {tab === "finish" && (
          <FinishPanel
            state={state}
            selection={selection}
            faces={faces}
            faceMode={faceMode}
            onFaceMode={(on) => {
              switchFaceMode(on);
              if (on && pointMode !== "pick" && pointMode !== "box") setPointMode("pick");
            }}
            faceFilter={faceFilter}
            onFaceFilter={setFaceFilter}
            lastFace={lastFace}
            look={look}
            onShowFinished={() => setLook("finished")}
          />
        )}
        {tab === "make" && <MakeTab state={state} view={makeView} onView={setMakeView} paper={paper} onPaper={setPaper} onSaved={note} onSelect={select} />}
        {tab === "check" && <CheckTab state={state} onShowMe={showMe} onAsk={askClaude} />}
        {tab === "history" && <HistoryTab state={state} />}
        {allPage && <AllPage state={state} section={allPage.section} onClose={() => setAllPage(null)} />}
      </aside>
      {!rightOpen && <Rail label="Panels" onOpen={() => setRightOpen(true)} />}
    </div>
  );
}
