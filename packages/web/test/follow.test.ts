// Claude drives the screen you'd use, and you learn by watching.
// Each of Claude's tools has a place on screen or says why it hasn't. The
// screen follows Claude tab by tab, never edit by edit, and stops for good
// the moment you touch anything. Show me how plays a turn back in order,
// and each step in a turn's list links to the control Claude used. The
// clock is passed in, so these tests run on a fake one.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { applyOps, derive, type Op } from "@woodchuck/core";
import { SYSTEM_PROMPT } from "../../server/src/prompt.js";
import { TOOLS } from "../../server/src/tools.js";
import type { ChatItem } from "../src/api.js";
import { ChatPanel } from "../src/components/ChatPanel.js";
import { FollowCaption, FollowChip } from "../src/components/Follow.js";
import { AREAS, describe as describePlace, tabOf, finishChanges, lookupOf, markSelector, movedParts, PLACES, placeOf, type Place } from "../src/follow.js";
import {
  chipFor,
  DWELL_MS,
  endTurn,
  IDLE,
  LINGER_MS,
  MAX_BEHIND,
  midTask,
  movesFor,
  nextAt,
  push,
  REPLAY_DWELL_MS,
  seeFinish,
  seeMoved,
  showStep,
  startLive,
  startReplay,
  STEP_MS,
  stopView,
  tick,
  touch,
  type Follow,
} from "../src/following.js";
import { TABS } from "../src/tabs.js";
import { bench, stateOf } from "./bench.js";

// The bench's seat height, named the way the Sizes list shows it.
const SEAT: Op = { op: "set_param", name: "seat_height", expr: "440", unit: "mm", note: "Seat height" };
const design = bench([SEAT]);
const state = stateOf(design);
const look = lookupOf(state);

const line = (name: string, summary: string, is_error = false) => ({ name, summary, is_error });
const place = (name: string, summary: string): Place => placeOf(line(name, summary))!;
const setSeat = place("set_param", "set param seat_height");
const setGap = place("set_param", "set param slat_gap");
const finish = place("set_finish", "set finish");
const addSeat = place("add_panel", "add panel seat");
const check = place("check_design", "check design");
const render = place("render_views", "render front, top, left, iso");

/** Plays a follow forward on a fake clock, one tick at each time it asks for, and says which stop showed when. */
function play(f: Follow, until: number, from = 0): { f: Follow; seen: { key: string; at: number }[] } {
  const seen: { key: string; at: number }[] = [];
  let now = from;
  let last: number | null = f.shown?.n ?? null;
  if (f.shown) seen.push({ key: f.shown.key, at: f.shown.at });
  for (let i = 0; i < 100; i++) {
    const at = nextAt(f);
    if (at === null || at > until) break;
    now = Math.max(now, at);
    f = tick(f, now);
    if (f.shown && f.shown.n !== last) seen.push({ key: f.shown.key, at: now });
    last = f.shown?.n ?? null;
  }
  return { f, seen };
}

describe("where each tool shows", () => {
  it("names a place for every tool in the TOOLS list, so nothing is silently unmapped", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names.length).toBeGreaterThan(30);
    expect(names.filter((n) => !(n in PLACES))).toEqual([]);
    // And nothing in the table that Claude doesn't have.
    expect(Object.keys(PLACES).filter((n) => !names.includes(n))).toEqual([]);
  });

  it("puts each kind of tool where the brief says", () => {
    expect(PLACES.set_param).toBe("sizes");
    for (const t of ["add_panel", "update_panel", "delete_part", "add_joint", "set_array", "set_hardware", "add_unverified_box"]) expect(PLACES[t]).toBe("part");
    expect(PLACES.set_finish).toBe("finish");
    expect(PLACES.define_material).toBe("layout");
    expect(PLACES.check_design).toBe("check");
    expect(PLACES.render_views).toBe("camera");
    expect(PLACES.preview_change).toBe("ghost");
    for (const t of ["get_design", "recall_chat", "list_joints", "explain", "measure", "list_library_parts"]) expect(PLACES[t]).toBe("none");
    expect(AREAS.sizes).toEqual({ tab: "edit", label: "Sizes" });
    expect(AREAS.layout).toEqual({ tab: "make", make: "layout", label: "Cut layout" });
    // Every tab an area opens is one of the five.
    for (const a of Object.values(AREAS)) if (a.tab) expect(TABS.map((t) => t.id)).toContain(a.tab);
  });

  it("reads the id from the chat's tool line, and skips a failed step or a read", () => {
    expect(placeOf(line("set_param", "set param seat_height"))).toEqual({ tool: "set_param", area: "sizes", id: "seat_height" });
    expect(placeOf(line("render_views", "render front, iso"))).toEqual({ tool: "render_views", area: "camera", id: "", views: ["front", "iso"] });
    expect(placeOf(line("set_param", "set param seat_height: Unknown size", true))).toBeNull();
    expect(placeOf(line("get_design", "get design"))).toBeNull();
    expect(placeOf(line("preview_change", "preview change"))).toBeNull();
    expect(placeOf(line("web_search", 'search the web for "AcmeCo slides"'))).toBeNull();
  });

  it("says what Claude did in the plain names on screen", () => {
    const seat = describePlace(setSeat, look);
    expect(seat.caption).toBe("Claude set Seat height in Sizes");
    expect(seat.words).toBe("Set Seat height");
    expect(seat.marks).toEqual(["tab:edit", "param:seat_height"]);
    const added = describePlace(addSeat, look);
    expect(added.caption).toBe("Claude added Seat in Edit");
    expect(added.pick).toEqual(["seat"]);
    expect(added.frame).toEqual(["seat"]);
    expect(describePlace(check, look).caption).toBe("Claude ran the checks in Check");
    expect(describePlace(render, look)).toMatchObject({ caption: "Claude looked at the model from the front, top, left and iso", marks: ["control:camera"] });
    expect(describePlace(place("define_material", "define material gum18"), look)).toMatchObject({
      caption: "Claude set up Spotted gum 18 mm in Cut layout",
      marks: ["tab:make", "layout:gum18"],
    });
    const joined = describePlace(place("set_array", "set array shelf_slats"), look);
    expect(joined.caption).toBe("Claude repeated Shelf slat in Edit");
    expect(joined.frame.length).toBe(4);
  });

  // Issue #43: a joint can name one copy, and the screen picks that copy. shelf_slat#1 is the original alone.
  it("picks the copy a joint names, and reads the original alone by its number", () => {
    const pinned = bench([{ op: "add_joint", id: "slat_pair", type: "butt", host: "shelf_slat#2", guest: "shelf_slat#1" }]);
    const seen = describePlace(place("add_joint", "add joint slat_pair"), lookupOf(stateOf(pinned)));
    expect(seen.caption).toBe("Claude joined Shelf slat 2 of 4 and Shelf slat 1 of 4 in Edit");
    expect(seen.pick).toEqual(["shelf_slat#2"]);
    expect(seen.frame).toEqual(["shelf_slat#2", "shelf_slat"]);
  });

  // Issue #12: one call can carry a whole stage of edits. It opens Edit, and the parts it moved frame themselves.
  it("places a list of edits in Edit by its count", () => {
    expect(PLACES.apply_edits).toBe("part");
    const stage = place("apply_edits", "apply 14 edits");
    expect(stage).toEqual({ tool: "apply_edits", area: "part", id: "14" });
    expect(describePlace(stage, look)).toMatchObject({ caption: "Claude made 14 edits in Edit", words: "Made 14 edits", marks: ["tab:edit"], pick: [] });
    expect(describePlace(place("apply_edits", "apply 1 edit"), look).words).toBe("Made 1 edit");
    expect(placeOf(line("apply_edits", "apply 14 edits: edit 5 of 14 (add_joint shelf_l) failed: Joint \"shelf_l\" already exists. 4 made, 9 not run", true))).toBeNull();
  });

  it("names a part Claude removed by the design from before its turn", () => {
    const after = applyOps(design, [{ op: "delete_part", id: "shelf_slat" } as Op, { op: "delete_array", id: "shelf_slats" } as Op].reverse());
    const now = lookupOf({ design: after, derived: derive(after) }, design);
    expect(describePlace(place("delete_part", "delete part shelf_slat"), now).caption).toBe("Claude removed Shelf slat in Edit");
  });

  it("lights a finish's swatch and what it went on, once the design shows it", () => {
    const changes = finishChanges({}, { "material:gum18": "satin_wood_oil/tel_aviv", seat: "raw" });
    expect(changes).toEqual([
      { finish: "satin_wood_oil/tel_aviv", targets: ["material:gum18"] },
      { finish: "raw", targets: ["seat"] },
    ]);
    expect(finishChanges({ seat: "raw" }, {})).toEqual([{ finish: null, targets: ["seat"] }]);
    const seen = describePlace({ ...finish, finish: changes[0]! }, look);
    expect(seen.caption).toBe("Claude put 25 Tel Aviv on Spotted gum 18 mm in Finish");
    expect(seen.marks).toEqual(["tab:finish", "swatch:satin_wood_oil/tel_aviv", "target:material:gum18"]);
    expect(seen.frame).toContain("seat");
    // Before the design shows it, the caption still says where Claude is.
    expect(describePlace(finish, look).caption).toBe("Claude chose a finish in Finish");
  });

  it("finds each mark's control on the page", () => {
    expect(markSelector("tab:finish")).toBe('[role="tablist"] [data-tab="finish"]');
    expect(markSelector("control:camera")).toBe('[data-control="camera"]');
    expect(markSelector("param:seat_height")).toBe('[data-place="param:seat_height"]');
    expect(markSelector("check")).toBe(".check-tab .ready");
  });

  it("tells which parts a change moved", () => {
    const taller = derive(applyOps(design, [{ ...SEAT, expr: "480" } as Op]));
    const moved = movedParts(state.derived.parts, taller.parts);
    expect(moved).toContain("seat");
    expect(moved).not.toContain("shelf_slat");
  });

  // Issue #3: Claude cuts a part's shape, and the screen follows the part it cut.
  const corner: Op = { op: "set_edge_cut", id: "seat", cut: "corner", edge: "front", start: { face: "seat.front", offset: "-30" }, end: { face: "seat.front" }, end_along: { at: "30" } };
  const notch: Op = { op: "set_cutout", id: "shelf_slat", cut: "finger", shape: "circle", centre: { x: { face: "shelf_slat.left", offset: "30" }, z: { face: "shelf_slat.front" } }, diameter: "25" };

  it("opens Edit on the part a cut shapes, and frames its copies too", () => {
    for (const t of ["set_edge_cut", "set_cutout", "delete_cut"]) expect(PLACES[t]).toBe("part");
    expect(placeOf(line("set_edge_cut", "set edge cut seat"))).toEqual({ tool: "set_edge_cut", area: "part", id: "seat" });
    expect(describePlace(place("set_edge_cut", "set edge cut seat"), look)).toEqual({
      caption: "Claude cut an edge of Seat in Edit",
      words: "Cut an edge of Seat",
      marks: ["tab:edit", "part"],
      pick: ["seat"],
      frame: ["seat"],
    });
    const cutout = describePlace(place("set_cutout", "set cutout shelf_slat"), look);
    expect(cutout).toMatchObject({ caption: "Claude made a cutout in Shelf slat in Edit", pick: ["shelf_slat"] });
    expect(cutout.frame).toEqual(["shelf_slat", "shelf_slat#2", "shelf_slat#3", "shelf_slat#4"]);
    expect(describePlace(place("delete_cut", "delete cut seat"), look).caption).toBe("Claude removed a cut from Seat in Edit");
    expect(placeOf(line("set_cutout", "set cutout seat: seat cut grip goes right through seat", true))).toBeNull();
  });

  it("tells a part whose shape alone changed, so the camera frames it", () => {
    const cornered = derive(applyOps(design, [corner]));
    expect(cornered.byId.get("seat")!.nominal).toEqual(state.derived.parts.find((p) => p.id === "seat")!.nominal);
    expect(movedParts(state.derived.parts, cornered.parts)).toEqual(["seat"]);
    // A cut on an array's original shapes every copy.
    expect(movedParts(state.derived.parts, derive(applyOps(design, [notch])).parts)).toEqual(["shelf_slat", "shelf_slat#2", "shelf_slat#3", "shelf_slat#4"]);
    // Taking the cut off is a change too, and the same shape again isn't.
    expect(movedParts(cornered.parts, state.derived.parts)).toEqual(["seat"]);
    expect(movedParts(cornered.parts, derive(applyOps(design, [corner])).parts)).toEqual([]);
  });
});

describe("following tab by tab", () => {
  it("batches a run of edits in one tab into one stop", () => {
    let f = startLive(IDLE);
    for (let i = 0; i < 60; i++) f = push(f, i % 2 ? setSeat : setGap, i * 10);
    expect(f.shown?.key).toBe("edit");
    expect(f.shown?.places.length).toBe(60);
    expect(f.queue).toEqual([]);
    const view = stopView(f.shown!, look);
    expect(view.caption).toBe("Claude set Seat height in Sizes");
    expect(view.more).toBe(59);
    expect(view.marks).toEqual(["tab:edit", "param:slat_gap", "param:seat_height"]);
  });

  it("gives each tab at least its dwell before moving on, however fast Claude goes", () => {
    let f = startLive(IDLE);
    f = push(f, setSeat, 0);
    f = push(f, finish, 5);
    f = push(f, check, 10);
    f = push(f, setGap, 15);
    expect(f.queue.map((s) => s.key)).toEqual(["finish", "check", "edit"]);
    const { seen } = play(f, 10_000);
    expect(seen.map((s) => s.key)).toEqual(["edit", "finish", "check", "edit"]);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!.at - seen[i - 1]!.at).toBeGreaterThanOrEqual(DWELL_MS);
  });

  it("joins a step to the last waiting stop in the same tab, and keeps only Claude's latest few when it falls behind", () => {
    let f = push(startLive(IDLE), setSeat, 0);
    f = push(f, finish, 1);
    f = push(f, finish, 2);
    expect(f.queue.length).toBe(1);
    const tabs = [check, render, setSeat, finish, check];
    for (const p of tabs) f = push(f, p, 3);
    expect(f.queue.length).toBe(MAX_BEHIND);
    expect(f.queue.map((s) => s.key)).toEqual(["edit", "finish", "check"]);
  });

  it("puts what the design showed on Claude's latest finish step, and frames moved parts with the step that moved them", () => {
    let f = push(push(startLive(IDLE), setSeat, 0), finish, 1);
    f = push(f, addSeat, 2);
    f = push(f, check, 3);
    f = seeFinish(f, [{ finish: "satin_wood_oil/tel_aviv", targets: ["material:gum18"] }]);
    // The design comes back once for all four steps, as with a quick turn.
    f = seeMoved(f, ["seat", "leg_fl"]);
    expect(f.queue[0]!.places[0]!.finish).toEqual({ finish: "satin_wood_oil/tel_aviv", targets: ["material:gum18"] });
    // The sizes moved the parts, so the part Claude changed after frames on its own.
    expect(f.shown!.moved).toEqual(["seat", "leg_fl"]);
    expect(f.queue[1]!.moved).toEqual([]);
    expect(stopView(f.queue[1]!, look).frame).toEqual(["seat"]);
    expect(f.queue[2]!.moved).toEqual([]);
    // A move the design shows later, with no new step that moves parts, frames nothing.
    f = seeMoved(f, ["shelf_slat"]);
    expect([f.shown!, ...f.queue].map((st) => st.moved)).toEqual([["seat", "leg_fl"], [], [], []]);
    // Once the design has come back, a later move goes with the next step.
    f = push(f, setGap, 4);
    f = seeMoved(f, ["shelf_slat"]);
    expect(f.queue.at(-1)!.moved).toEqual(["shelf_slat"]);
    expect(f.shown!.moved).toEqual(["seat", "leg_fl"]);
  });

  it("lingers on the last stop after Claude's turn, then lets go", () => {
    let f = push(startLive(IDLE), setSeat, 0);
    expect(chipFor(f)).toBe("live");
    // While Claude works, it waits on Claude.
    expect(nextAt(f)).toBeNull();
    f = endTurn(f, 5000);
    expect(nextAt(f)).toBe(5000 + LINGER_MS);
    f = tick(f, 5000 + LINGER_MS - 1);
    expect(f.shown).not.toBeNull();
    f = tick(f, 5000 + LINGER_MS);
    expect(f.on).toBe(false);
    expect(chipFor(f)).toBeNull();
  });
});

describe("hands on", () => {
  it("stops following at any touch, and nothing moves after that", () => {
    let f = push(startLive(IDLE), setSeat, 0);
    f = push(f, finish, 10);
    expect(movesFor(f, null)).toEqual({ tab: "edit" });
    f = touch(f);
    expect(f.on).toBe(false);
    expect(f.shown).toBeNull();
    expect(chipFor(f)).toBeNull();
    // Claude carries on, and the clock runs, but nothing comes on screen.
    for (const [i, p] of [finish, check, addSeat, render].entries()) f = push(f, p, 100 + i);
    f = seeFinish(f, [{ finish: "raw", targets: ["seat"] }]);
    f = seeMoved(f, ["seat"]);
    f = tick(f, 60_000);
    f = endTurn(f, 61_000);
    f = tick(f, 120_000);
    expect(f.shown).toBeNull();
    expect(f.queue).toEqual([]);
    expect(nextAt(f)).toBeNull();
    expect(movesFor(f, null)).toBeNull();
  });

  it("keeps a tab you chose mid-turn", () => {
    // Claude works in Sizes, so Edit opens.
    let f = push(startLive(IDLE), setSeat, 0);
    const opened = movesFor(f, null);
    expect(opened?.tab).toBe("edit");
    // You click Finish to try colours: a touch.
    f = touch(f);
    // Claude goes on in Sizes, Check and Make. Your Finish tab stays.
    let applied: number | null = 1;
    for (const [i, p] of [setGap, check, place("get_cut_list", "get cut list")].entries()) {
      f = tick(push(f, p, 2000 + i * 2000), 3000 + i * 2000);
      expect(movesFor(f, applied)).toBeNull();
      applied = f.shown?.n ?? applied;
    }
  });

  it("doesn't start while you're in the middle of something", () => {
    expect(midTask({ held: false, dragging: false, typing: "chat" })).toBe(false);
    expect(midTask({ held: false, dragging: false, typing: null })).toBe(false);
    expect(midTask({ held: true, dragging: false, typing: null })).toBe(true);
    expect(midTask({ held: false, dragging: true, typing: null })).toBe(true);
    expect(midTask({ held: false, dragging: false, typing: "field" })).toBe(true);
  });
});

describe("Show me how", () => {
  it("replays a turn's steps in order, tab by tab, slower than following", () => {
    const steps = [setSeat, setGap, addSeat, finish, finish, check, setSeat, render];
    let f = startReplay(IDLE, steps, 0);
    expect(chipFor(f)).toBe("replay");
    // Sizes and the part are both in Edit, so they run together.
    expect([f.shown!.key, ...f.queue.map((s) => s.key)]).toEqual(["edit", "finish", "check", "edit", "camera"]);
    const { f: done, seen } = play(f, 60_000);
    expect(seen.map((s) => s.key)).toEqual(["edit", "finish", "check", "edit", "camera"]);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!.at - seen[i - 1]!.at).toBe(REPLAY_DWELL_MS);
    expect(done.on).toBe(false);
  });

  it("keeps every stop, however long the turn, and takes no new steps from Claude", () => {
    const many = Array.from({ length: 12 }, (_, i) => (i % 2 ? setSeat : finish));
    let f = startReplay(IDLE, many, 0);
    expect(f.queue.length).toBe(11);
    f = push(f, check, 1);
    expect(f.queue.length).toBe(11);
  });

  it("stops at a touch", () => {
    let f = startReplay(IDLE, [setSeat, finish, check], 0);
    f = tick(f, REPLAY_DWELL_MS);
    expect(f.shown?.key).toBe("finish");
    f = touch(f);
    expect(play(f, 60_000).seen).toEqual([]);
  });

  it("numbers stops on from what came before, so the same tab opens again", () => {
    const a = startReplay(IDLE, [setSeat], 0);
    const b = showStep(a, setSeat, 10);
    expect(b.shown!.n).toBeGreaterThan(a.shown!.n);
    expect(movesFor(b, a.shown!.n)).toEqual({ tab: "edit" });
  });
});

describe("steps link to their controls", () => {
  const at = "2026-10-04T09:00:00Z";
  const chat: ChatItem[] = [
    { id: "u1", kind: "user", text: "Raise the seat and oil it", selection: [], at },
    { id: "x1", kind: "tool", name: "get_design", summary: "get design", is_error: false, at },
    { id: "x2", kind: "tool", name: "set_param", summary: "set param seat_height", is_error: false, at },
    { id: "x3", kind: "tool", name: "set_finish", summary: "set finish", is_error: false, at },
    { id: "c1", kind: "change", change: 1, author: "claude", label: "Raise the seat", edits: 2, at },
  ];
  const render = (busy = false) =>
    renderToStaticMarkup(
      createElement(ChatPanel, {
        state: { ...state, chat, busy, history: [{ id: 1, author: "claude", label: "Raise the seat", at }] },
        selection: [],
        onSelect: () => {},
        pins: [],
        onPins: () => {},
        captureView: () => null,
        onOpen: () => {},
        onSee: () => {},
        onShowHow: () => {},
        onStep: () => {},
      }),
    );

  it("makes each step with a place a link in its plain words, and leaves a read as it was", () => {
    const html = render();
    expect(html).toContain('class="link step-link"');
    expect(html).toMatch(/<button[^>]*step-link[^>]*>Set Seat height<\/button>/);
    expect(html).toMatch(/<button[^>]*step-link[^>]*>Chose a finish<\/button>/);
    expect(html).toContain("· get design");
  });

  it("offers Show me how on a finished turn's line, not on the turn Claude is still working on", () => {
    expect(render()).toMatch(/Claude made 2 edits · <span class="fold-verb">show steps<\/span> · <button[^>]*fold-how[^>]*>show me how<\/button>/);
    expect(render(true)).not.toContain("fold-how");
  });

  it("opens a step's tab and lights its control for a few seconds", () => {
    const f = showStep(IDLE, setSeat, 0);
    expect(chipFor(f)).toBeNull();
    expect(movesFor(f, null)).toEqual({ tab: "edit" });
    expect(stopView(f.shown!, look).marks).toContain("param:seat_height");
    expect(tick(f, STEP_MS - 1).shown).not.toBeNull();
    expect(tick(f, STEP_MS).on).toBe(false);
  });

  it("draws the chip and the caption in the mock-up's words", () => {
    expect(renderToStaticMarkup(createElement(FollowChip, { mode: "live", onStop: () => {} }))).toMatch(/Following Claude · <button[^>]*>stop<\/button>/);
    expect(renderToStaticMarkup(createElement(FollowChip, { mode: null, onStop: () => {} }))).toBe("");
    expect(renderToStaticMarkup(createElement(FollowCaption, { view: { caption: "Claude set Seat height in Sizes", more: 0 } }))).toContain("Claude set Seat height in Sizes");
  });
});

// Seen in a demo: Claude said it couldn't see the app, so it couldn't say where the cut list was.
describe("Claude's instructions about the screen", () => {
  it("name the five tabs and what each holds", () => {
    expect(SYSTEM_PROMPT).toContain(
      "Edit holds the picked part and the design's sizes, Finish the timber and colours, Make the workshop drawings, the cut list and the cutting layout, Check the problems with a fix for each, and History every change and version.",
    );
    for (const t of TABS) expect(SYSTEM_PROMPT).toContain(`${t.label} `);
    expect(SYSTEM_PROMPT).toContain("No headings and no bold, though a short table is fine for a cut list.");
  });

  it("say which tools open a tab, and following opens that tab", () => {
    const claims = [...SYSTEM_PROMPT.matchAll(/(\w+) opens (Edit|Finish|Make|Check|History)\b/g)].map((m) => [m[1]!, m[2]!]);
    expect(claims).toEqual([
      ["get_cut_list", "Make"],
      ["check_design", "Check"],
    ]);
    for (const [tool, label] of claims) {
      const p = placeOf(line(tool, tool.replace(/_/g, " ")))!;
      const opened = movesFor(push(startLive(IDLE), p, 0), null);
      expect(TABS.find((t) => t.id === opened?.tab)?.label, tool).toBe(label);
      expect(tabOf(p).tab).toBe(opened?.tab);
    }
  });
});
