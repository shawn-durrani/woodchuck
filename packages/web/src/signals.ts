// Honest signals. The pink glow and the switch to the Finished look say
// "Claude just changed this", so they follow only a new change set by
// Claude on the design you have open. Opening another design, undo, redo,
// restoring a version and your own edits never set them off. The chat's
// change lines say when Undo took a change back.

import type { Author, ServerState } from "./api";

/** What the window last saw of the open design. */
export interface Seen {
  slug: string;
  /** The newest change set in force, if any. */
  lastId: number | undefined;
  /**
   * The highest change set id seen on this design. Ids only grow, so a
   * change set above it is new, and one that comes back with redo isn't.
   */
  topId: number;
  /** Each part's box, from before Claude's turn began, to tell what Claude moved. */
  boxes: Map<string, string>;
  /** The finishes from before Claude's turn began. */
  finishes: string;
}

type Shape = Pick<ServerState, "project" | "history" | "derived" | "design" | "busy">;

/** What a new change set by Claude did: the parts it moved or resized, and whether it changed colours. */
export interface ClaudeChange {
  parts: string[];
  finishes: boolean;
}

const boxesOf = (state: Shape) => new Map(state.derived.parts.map((p) => [p.id, [...p.nominal.min, ...p.nominal.max].join(",")]));
const finishesOf = (state: Shape) => JSON.stringify(state.design.finishes ?? {});

/**
 * Takes in a new state. Says what Claude changed when a new change set by
 * Claude has just arrived on the same design, and whether the history moved
 * any other way, such as by undo, which should clear an old glow.
 */
export function nextSeen(before: Seen | null, state: Shape): { seen: Seen; claude: ClaudeChange | null; moved: boolean } {
  const ids = state.history.map((h) => h.id);
  const last = state.history.at(-1);
  const boxes = boxesOf(state);
  const finishes = finishesOf(state);
  if (!before || before.slug !== state.project.slug) {
    // A design you've just opened shows as it is, with nothing to point at.
    return { seen: { slug: state.project.slug, lastId: last?.id, topId: Math.max(0, ...ids), boxes, finishes }, claude: null, moved: false };
  }
  const fresh = !!last && last.author === "claude" && last.id > before.topId;
  const claude = fresh
    ? { parts: [...boxes].filter(([id, sig]) => before.boxes.get(id) !== sig).map(([id]) => id), finishes: before.finishes !== finishes }
    : null;
  // During Claude's turn the design changes before its change set closes, so
  // the starting point stays put until the turn is over. An edit of yours
  // mid-turn moves it on, so your own change never glows as Claude's.
  const yours = !!last && last.author !== "claude" && last.id > before.topId;
  const settle = fresh || yours || !state.busy;
  return {
    seen: {
      slug: before.slug,
      lastId: last?.id,
      topId: Math.max(before.topId, ...ids),
      boxes: settle ? boxes : before.boxes,
      finishes: settle ? finishes : before.finishes,
    },
    claude,
    moved: !fresh && last?.id !== before.lastId,
  };
}

type ChangeItem = { change: number; undone?: true };

/**
 * Whether Undo has taken a change set back. The server marks it. Lines from
 * before the mark existed are worked out from the history: ids only grow,
 * so a change set missing from between the ones in force was undone.
 */
export function isUndone(item: ChangeItem, history: { id: number }[]): boolean {
  if (item.undone) return true;
  if (!history.length || history.some((h) => h.id === item.change)) return false;
  return item.change > history[0]!.id;
}

/** A change line, such as "You made 2 edits." with "Undone." or "1 undone." after it when Undo took some back. */
export function changeLine(author: Author, edits: number, undoneEdits: number): string {
  const who = author === "claude" ? "Claude" : author === "you" ? "You" : "Example";
  const made = `${who} made ${edits} edit${edits === 1 ? "" : "s"}.`;
  if (undoneEdits <= 0) return made;
  if (undoneEdits >= edits) return `${made} Undone.`;
  return `${made} ${undoneEdits} undone.`;
}

/** The toast for a file the browser saves to your downloads. */
export function savedNote(what: string, file: string): string {
  return `Saved ${what} to your downloads as "${file}".`;
}
