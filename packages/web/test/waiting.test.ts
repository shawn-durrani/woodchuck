// Claude's waiting moments sit in one bar above the chat box, with the
// live buttons for each kind, and the bar or the chat box answers them.
// A worked example opens in its own slot, so it never hides a waiting
// suggested change.

import { describe, expect, it } from "vitest";
import type { ChatItem, ServerState } from "../src/api.js";
import { boxPlaceholder, boxReply, buttonReply, keySizeLine, NO_SLOTS, openSlot, waitingMoments, type Moment } from "../src/waiting.js";

const at = "2026-10-04T09:00:00Z";
const plan: ChatItem = {
  id: "p1",
  kind: "plan",
  at,
  plan: { summary: "A 250 mm step stool in radiata pine.", parts: [], key_dims: [], joints: [], assumptions: [], status: "proposed" },
} as unknown as ChatItem;
const question: ChatItem = { id: "q1", kind: "question", at, question: "Do you want thicker seat slats?", options: ["Keep 19 mm", "25 mm"] };
const preview: ChatItem = {
  id: "v1",
  kind: "preview",
  at,
  title: "Raise the book shelf",
  explanation: "Lifts the book shelf to 140 mm.",
  ops: [],
  status: "proposed",
};
const part: ChatItem = {
  id: "r1",
  kind: "part",
  at,
  proposal: "pp_2",
  status: "proposed",
  part: { id: "acmeco-glide-450", name: "Acmeco Glide 450 slide" },
} as unknown as ChatItem;

const state = (chat: ChatItem[], waiting: ServerState["waiting"], busy = false) => ({ chat, waiting, busy });
const labels = (m: Moment) => m.actions.map((a) => a.label);

describe("which waiting kind shows which buttons", () => {
  it("a plan offers Looks right and Change", () => {
    const [m] = waitingMoments(state([plan], ["plan"]));
    expect(m!.kind).toBe("plan");
    expect(labels(m!)).toEqual(["Looks right", "Change"]);
    expect(m!.summary).toBe("Does the plan look right? A 250 mm step stool in radiata pine.");
  });

  it("a question offers its own options", () => {
    const [m] = waitingMoments(state([question], ["question"]));
    expect(labels(m!)).toEqual(["Keep 19 mm", "25 mm"]);
    expect(m!.summary).toBe("Do you want thicker seat slats?");
  });

  it("a suggested change offers Apply, Not now and See it", () => {
    const [m] = waitingMoments(state([preview], ["preview"]));
    expect(labels(m!)).toEqual(["Apply", "Not now", "See it"]);
  });

  it("a part offers Approve and share, which says it opens a pull request, and Change", () => {
    const [m] = waitingMoments(state([part], ["part"]));
    expect(labels(m!)).toEqual(["Approve and share (opens a pull request)", "Change"]);
    expect(m!.summary).toBe("Add Acmeco Glide 450 slide to the parts library?");
  });

  it("points at the card that's waiting, not an answered one", () => {
    const answered = { ...question, id: "q0", answered: "Keep 19 mm" } as ChatItem;
    const old = { ...preview, id: "v0", status: "not_applied" } as ChatItem;
    expect(waitingMoments(state([answered, question], ["question"])).map((m) => m.id)).toEqual(["q1"]);
    expect(waitingMoments(state([preview, old], ["preview"])).map((m) => m.id)).toEqual(["v1"]);
  });

  it("shows nothing when Claude isn't waiting, or while it's working", () => {
    expect(waitingMoments(state([plan, question], []))).toEqual([]);
    expect(waitingMoments(state([plan], ["plan"], true))).toEqual([]);
  });

  it("lists two waiting moments in the order their cards came", () => {
    expect(waitingMoments(state([question, plan], ["plan", "question"])).map((m) => m.kind)).toEqual(["question", "plan"]);
  });
});

describe("the bar answers what Claude waits on", () => {
  const act = (kind: ServerState["waiting"][number], chat: ChatItem[], label: string) =>
    waitingMoments(state(chat, [kind]))[0]!.actions.find((a) => a.label === label)!.answer;

  it("Looks right approves the plan", () => {
    expect(buttonReply(act("plan", [plan], "Looks right"), "")).toEqual({ text: "Looks right.", plan: "approve" });
  });

  it("Change sends the chat box's words as the change, or points at the box when it's empty", () => {
    expect(buttonReply(act("plan", [plan], "Change"), "  Make it 300 high ")).toEqual({ text: "Make it 300 high", plan: "changes" });
    expect(buttonReply(act("plan", [plan], "Change"), "  ")).toBeNull();
    expect(buttonReply(act("part", [part], "Change"), "The load rating is 45 kg")).toEqual({ text: "The load rating is 45 kg", part: "changes" });
  });

  it("an option answers the question with its words", () => {
    expect(buttonReply(act("question", [question], "25 mm"), "")).toEqual({ text: "25 mm" });
  });

  it("Apply and Not now answer the suggested change, and See it sends nothing", () => {
    expect(buttonReply(act("preview", [preview], "Apply"), "")).toEqual({ text: "Apply it.", preview: "apply" });
    expect(buttonReply(act("preview", [preview], "Not now"), "")).toEqual({ text: "Not now.", preview: "not_now" });
    const see = act("preview", [preview], "See it");
    expect(see).toEqual({ see: "v1" });
    expect(buttonReply(see, "anything")).toBeNull();
  });

  it("Approve and share approves the part", () => {
    expect(buttonReply(act("part", [part], "Approve and share (opens a pull request)"), "")).toEqual({
      text: "Approved. Add it to the library.",
      part: "approve",
    });
  });

  it("typing in the chat box answers too, as the change for a plan or a part", () => {
    expect(boxReply("Make it taller", waitingMoments(state([plan], ["plan"])))).toEqual({ text: "Make it taller", plan: "changes" });
    expect(boxReply("Check the load", waitingMoments(state([part], ["part"])))).toEqual({ text: "Check the load", part: "changes" });
    expect(boxReply("Keep 19 mm", waitingMoments(state([question], ["question"])))).toEqual({ text: "Keep 19 mm" });
    expect(boxReply("Make it oak", waitingMoments(state([preview], ["preview"])))).toEqual({ text: "Make it oak" });
    expect(boxReply("A stool", [])).toEqual({ text: "A stool" });
  });

  it("the chat box says what it's answering", () => {
    expect(boxPlaceholder(waitingMoments(state([question], ["question"])))).toBe("Answer Claude's question");
    expect(boxPlaceholder(waitingMoments(state([plan], ["plan"])))).toBe("Say what to change in the plan");
    expect(boxPlaceholder(waitingMoments(state([part], ["part"])))).toBe("Say what's wrong with the part");
    expect(boxPlaceholder(waitingMoments(state([preview], ["preview"])))).toBe("Reply about the suggested change. Sending leaves it unapplied");
    expect(boxPlaceholder([])).toBeNull();
  });
});

describe("a worked example never hides a waiting preview", () => {
  it("opens in its own slot, beside the preview", () => {
    const withPreview = openSlot(NO_SLOTS, { kind: "preview", id: "v1" });
    const both = openSlot(withPreview, { kind: "example", joint: "mortise_tenon", note: "The low rails use it." });
    expect(both).toEqual({ preview: "v1", example: { joint: "mortise_tenon", note: "The low rails use it." } });
  });

  it("picking another joint keeps the preview too", () => {
    const both = openSlot({ preview: "v1", example: { joint: "mortise_tenon" } }, { kind: "example", joint: "half_lap" });
    expect(both).toEqual({ preview: "v1", example: { joint: "half_lap" } });
  });
});

describe("a plan's card", () => {
  it("gives the model's number for each key size", () => {
    const gap = { label: "Clear gap between shelves", expr: "shelf#2.bottom - shelf.top", expected_mm: 302.3 };
    expect(keySizeLine({ ...gap, model_mm: 302 })).toBe("Clear gap between shelves: 302 mm");
    // A plan saved before the app kept the model's number gives the size Claude expected.
    expect(keySizeLine(gap)).toBe("Clear gap between shelves: 302.3 mm");
  });
});
