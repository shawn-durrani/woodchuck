// Claude's waiting moments in one place. When Claude stops for a plan, a
// question, a suggested change or a library part, one bar above the chat
// box holds the live buttons, and the chat box says what it answers. The
// card in the chat stays as the record.

import { fmt, type JointType, type PlanDim } from "@woodchuck/core";
import type { ChatItem, ServerState } from "./api";

export type WaitKind = ServerState["waiting"][number];

/** The words a reply sends, with what they answer. */
export interface Reply {
  text: string;
  plan?: "approve" | "changes";
  part?: "approve" | "changes";
  preview?: "apply" | "not_now";
}

/** What a button in the bar does. */
export type Answer =
  /** Sends a fixed reply. */
  | { send: Reply }
  /** Sends the chat box's words as the change, or points you at the box when it's empty. */
  | { change: "plan" | "part" }
  /** Flips the model between the design now and with a suggested change. */
  | { see: string };

export interface Action {
  label: string;
  answer: Answer;
  primary?: true;
  title?: string;
}

export interface Moment {
  kind: WaitKind;
  /** The card in the chat that keeps the full record. */
  id: string;
  /** What's waiting, in a few words. */
  label: string;
  /** What Claude asks, on one line. */
  summary: string;
  actions: Action[];
}

const PART_TIP = "Keeps the part for your designs, and opens a pull request on GitHub that adds it to the shared library";

/** The card each waiting kind belongs to: the newest one still open. */
function cardFor(kind: WaitKind, chat: ChatItem[]): { item: ChatItem; at: number } | null {
  for (let i = chat.length - 1; i >= 0; i--) {
    const c = chat[i]!;
    const open =
      (kind === "plan" && c.kind === "plan") ||
      (kind === "question" && c.kind === "question" && c.answered === undefined) ||
      (kind === "preview" && c.kind === "preview" && c.status === "proposed") ||
      (kind === "part" && c.kind === "part" && c.status === "proposed");
    if (open) return { item: c, at: i };
  }
  return null;
}

function moment(item: ChatItem): Moment | null {
  switch (item.kind) {
    case "plan":
      return {
        kind: "plan",
        id: item.id,
        label: "Plan",
        summary: `Does the plan look right? ${item.plan.summary}`,
        actions: [
          { label: "Looks right", primary: true, answer: { send: { text: "Looks right.", plan: "approve" } } },
          { label: "Change", title: "Say what to change in the chat box, then click Change or press Enter", answer: { change: "plan" } },
        ],
      };
    case "question":
      return {
        kind: "question",
        id: item.id,
        label: "Question",
        summary: item.question,
        actions: item.options.map((o) => ({ label: o, answer: { send: { text: o } } })),
      };
    case "preview":
      return {
        kind: "preview",
        id: item.id,
        label: "Suggested change",
        summary: `${item.title}. ${item.explanation}`,
        actions: [
          { label: "Apply", primary: true, title: "Make the change, as one change you can undo", answer: { send: { text: "Apply it.", preview: "apply" } } },
          { label: "Not now", title: "Leave the design as it is", answer: { send: { text: "Not now.", preview: "not_now" } } },
          { label: "See it", title: "Flip the model between now and with the change. Nothing is applied", answer: { see: item.id } },
        ],
      };
    case "part":
      return {
        kind: "part",
        id: item.id,
        label: "Library part",
        summary: `Add ${item.part.name} to the parts library?`,
        actions: [
          { label: "Approve and share (opens a pull request)", primary: true, title: PART_TIP, answer: { send: { text: "Approved. Add it to the library.", part: "approve" } } },
          { label: "Change", title: "Say what's wrong in the chat box, then click Change or press Enter", answer: { change: "part" } },
        ],
      };
  }
  return null;
}

/**
 * A key size on a plan's card. It gives the model's own number, which the app
 * worked out when the plan was pinned, so the size you approve is the one
 * you'll cut. A plan saved without it gives the size Claude expected.
 */
export function keySizeLine(d: PlanDim): string {
  return `${d.label}: ${fmt(d.model_mm ?? d.expected_mm)} mm`;
}

/** What Claude is waiting on now, oldest card first. Nothing while Claude is working. */
export function waitingMoments(state: Pick<ServerState, "chat" | "waiting" | "busy">): Moment[] {
  if (state.busy) return [];
  const found = [...new Set(state.waiting)]
    .map((k) => cardFor(k, state.chat))
    .filter((c): c is { item: ChatItem; at: number } => c !== null)
    .sort((a, b) => a.at - b.at);
  return found.map((c) => moment(c.item)).filter((m): m is Moment => m !== null);
}

/** The chat box's placeholder, saying what it answers. The newest moment wins. A phone's one-line box takes the short words. */
export function boxPlaceholder(moments: Moment[], short = false): string | null {
  switch (moments.at(-1)?.kind) {
    case "question":
      return "Answer Claude's question";
    case "plan":
      return short ? "Say what to change" : "Say what to change in the plan";
    case "preview":
      return short ? "Or say what to change" : "Reply about the suggested change. Sending leaves it unapplied";
    case "part":
      return short ? "Say what's wrong" : "Say what's wrong with the part";
  }
  return null;
}

/**
 * The chat box's words as a reply. They answer whatever Claude is waiting
 * on: a plan or a part takes them as the change you want, a question as
 * its answer, and a suggested change stays unapplied.
 */
export function boxReply(text: string, moments: Moment[]): Reply {
  const kinds = new Set(moments.map((m) => m.kind));
  return { text, ...(kinds.has("plan") ? { plan: "changes" as const } : {}), ...(kinds.has("part") ? { part: "changes" as const } : {}) };
}

/**
 * What a button in the bar sends, given the chat box's words. Null means
 * it sends nothing: See it flips the model, and Change with an empty box
 * points you at the box.
 */
export function buttonReply(answer: Answer, box: string): Reply | null {
  if ("send" in answer) return answer.send;
  if ("change" in answer) {
    const text = box.trim();
    return text ? { text, [answer.change]: "changes" } : null;
  }
  return null;
}

/**
 * The drawer beside the model has two slots, an older suggested change and
 * a joint, so one never hides the other. The joint is a worked example or
 * one of the design's own, in section with its sizes.
 */
export interface Slots {
  preview: string | null;
  example: { joint: JointType; note?: string; stopped?: true } | null;
  /** One of the design's own joints, by id. */
  section: string | null;
}

/**
 * A worked example can show a joint's housing stopped short of an edge of
 * its host. With of, it's one of the design's own joints, which pulls apart
 * on the model instead of opening the drawer.
 */
export type Drawer =
  | { kind: "preview"; id: string }
  | { kind: "example"; joint: JointType; note?: string; stopped?: true; of?: string }
  /** One of the design's own joints in section, with its sizes. */
  | { kind: "joint"; id: string };

export const NO_SLOTS: Slots = { preview: null, example: null, section: null };

/** Opens a preview in its slot, or a joint in the other, leaving the preview's slot as it was. */
export function openSlot(slots: Slots, d: Drawer): Slots {
  if (d.kind === "preview") return { ...slots, preview: d.id };
  if (d.kind === "joint") return { ...slots, example: null, section: d.id };
  return { ...slots, section: null, example: { joint: d.joint, ...(d.note ? { note: d.note } : {}), ...(d.stopped ? { stopped: true as const } : {}) } };
}
