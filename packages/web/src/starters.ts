// What an empty chat offers. A new design gets true wording and three
// starter prompts that fill the chat box. The record console example
// opens with a card that says what it is and why its LP check fails.

import type { ServerState } from "./api";

export const EMPTY_CHAT =
  "Describe what you want to build, with the sizes you know. Claude builds a first draft straight away, then pins its plan beside the model for you to check.";

export interface Starter {
  label: string;
  /** What the button puts in the chat box, ready to change before you send it. */
  text: string;
  /** Opens the file picker too, for a photo or sketch. */
  attach?: true;
}

export const STARTERS: Starter[] = [
  { label: "A bedside table with a drawer", text: "A bedside table with a drawer, about 450 mm wide, 350 mm deep and 550 mm high." },
  { label: "Shelves for 200 LPs", text: "Shelves for 200 LPs. The sleeves are about 315 mm square." },
  { label: "Start from a photo or sketch", text: "Build this from the photo or sketch I've attached. ", attach: true },
];

/** What a starter does to the chat box: its words go in, ready to change, and the photo one opens the file picker. */
export function starterFill(starter: Starter): { text: string; attach: boolean } {
  return { text: starter.text, attach: starter.attach === true };
}

/** The words "Ask Claude to fix the LP check" puts in the chat box. */
export const FIX_LP_CHECK = "The LP check fails. Change the drawers so 12-inch LPs fit, and tell me what you changed.";

/**
 * What an empty chat shows. The example's intro card shows on the record
 * console example until you first write to Claude. A chat with nothing in
 * it gets the starters. Anything else shows the chat.
 */
export function emptyChat(state: Pick<ServerState, "project" | "chat">): "example" | "starters" | null {
  const talked = state.chat.some((c) => c.kind === "user");
  if (state.project.example === "record_console" && !talked) return "example";
  return state.chat.some((c) => c.kind !== "usage") ? null : "starters";
}
