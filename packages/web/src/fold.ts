// A quieter chat. Each of Claude's turns folds its tool lines and Thinking
// into its change line, "Claude made 59 edits · show steps", which opens to
// show them. Errors and the pictures Claude looked at stay where they are.
// A turn with no change line folds its steps under a "show steps" line.
// A message you send while Claude works waits at the foot of the chat until
// Claude takes it in, then sits where Claude read it.

import type { ChatItem } from "./api";
import { changeLine, isUndone } from "./signals";

/** A run of your own edits, such as trying colours, shown as one line. */
export interface YourEdits {
  id: string;
  kind: "your_edits";
  edits: number;
  undoneEdits: number;
  labels: { text: string; undone: boolean }[];
}

export type Row = ChatItem | YourEdits;
type Change = Extract<ChatItem, { kind: "change" }>;

export type Folded =
  | { kind: "row"; row: Row }
  | {
      kind: "steps";
      id: string;
      /** Claude's change line the steps fold into, if the turn has one. */
      change: Change | null;
      steps: Row[];
      /** The turn Claude is working on now. */
      live: boolean;
    };

type Said = Extract<ChatItem, { kind: "user" }>;

/** Messages sent while Claude works that it hasn't taken in yet. They wait at the foot of the chat. */
export function notYetRead(chat: ChatItem[]): Said[] {
  return chat.filter((c): c is Said => c.kind === "user" && !!c.during && !c.taken);
}

/** The words under a message sent while Claude worked, or null for any other. */
export function duringNote(c: Said): string | null {
  if (!c.during) return null;
  return c.taken ? "Sent while Claude worked · taken in" : "Sent while Claude worked · Claude reads it after its current step";
}

/** Whether a message starts a turn, rather than arriving in the middle of one. */
const startsTurn = (c: Said) => !c.during || c.taken === "turn";

/** The chat as it reads: usage lines and messages Claude hasn't read yet dropped, and runs of your own edits joined into one line that says when Undo took them back. */
export function joinYourEdits(chat: ChatItem[], history: { id: number }[]): Row[] {
  const rows: Row[] = [];
  for (const c of chat) {
    if (c.kind === "usage") continue;
    if (c.kind === "user" && c.during && !c.taken) continue;
    const last = rows.at(-1);
    if (c.kind === "change" && c.author === "you") {
      const undone = isUndone(c, history);
      if (last?.kind === "your_edits") {
        last.edits += c.edits;
        last.undoneEdits += undone ? c.edits : 0;
        last.labels.push({ text: c.label, undone });
      } else {
        rows.push({ id: c.id, kind: "your_edits", edits: c.edits, undoneEdits: undone ? c.edits : 0, labels: [{ text: c.label, undone }] });
      }
      continue;
    }
    rows.push(c);
  }
  return rows;
}

/** One of Claude's steps, folded away. An error or a picture isn't, and Thinking shows when you've asked for it. */
export function isStep(row: Row, showThinking: boolean): boolean {
  if (row.kind === "thinking") return !showThinking;
  return row.kind === "tool" && !row.is_error && !row.image;
}

/**
 * Folds each turn's steps. A turn starts at your message. Its steps fold
 * into Claude's last change line in the turn, or, with none, sit under one
 * line where the first step was. A message Claude took in mid-turn stays
 * inside the turn.
 */
export function foldTurns(rows: Row[], opts: { busy: boolean; showThinking: boolean }): Folded[] {
  const turns: Row[][] = [];
  for (const r of rows) {
    if ((r.kind === "user" && startsTurn(r)) || turns.length === 0) turns.push([]);
    turns.at(-1)!.push(r);
  }
  const out: Folded[] = [];
  turns.forEach((turn, t) => {
    const steps = turn.filter((r) => isStep(r, opts.showThinking));
    if (!steps.length) {
      for (const row of turn) out.push({ kind: "row", row });
      return;
    }
    const live = opts.busy && t === turns.length - 1;
    // A turn still going has no change line of its own yet. One your edit split off stays a line of its own.
    const change = live ? null : ([...turn].reverse().find((r): r is Change => r.kind === "change" && r.author === "claude") ?? null);
    const anchor = change ?? steps[0]!;
    for (const row of turn) {
      if (row === anchor) out.push({ kind: "steps", id: anchor.id, change, steps, live });
      else if (!steps.includes(row)) out.push({ kind: "row", row });
    }
  });
  return out;
}

/** The fold's line: "Claude made 59 edits · show steps", or "3 steps · show steps" in a turn with no change line. */
export function foldLine(fold: { change: Change | null; steps: Row[]; live: boolean }, history: { id: number }[], open: boolean): string {
  const verb = open ? "hide steps" : "show steps";
  if (fold.change) {
    const c = fold.change;
    return `${changeLine(c.author, c.edits, isUndone(c, history) ? c.edits : 0).replace(/\.$/, "")} · ${verb}`;
  }
  const n = fold.steps.length;
  return `${n} step${n === 1 ? "" : "s"}${fold.live ? " so far" : ""} · ${verb}`;
}

/** What Claude is doing right now, for the working line, when its newest line is a step. Its words show for themselves. */
export function latestStep(rows: Row[]): string | null {
  const r = rows.at(-1);
  if (r?.kind === "tool") return r.summary;
  if (r?.kind === "thinking") return "thinking";
  return null;
}
