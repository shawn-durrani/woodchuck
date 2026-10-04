// Keyboard shortcuts for the daily controls. A key does what its control
// does, and each control's tooltip names its key. None fire while you're
// typing in a field, so a size, a name or a message never loses a letter,
// and ⌘Z in a field undoes your typing there. Esc keeps its own jobs in
// the app.

import type { CameraView, PointMode } from "./components/Viewport";
import { CAMERAS, TOOLS } from "./toolbar";

export type Shortcut =
  | { do: "undo" }
  | { do: "redo" }
  | { do: "fit" }
  | { do: "see-through" }
  | { do: "chat" }
  | { do: "camera"; view: CameraView }
  | { do: "tool"; tool: PointMode };

/** The parts of a key press that matter here, as a KeyboardEvent has them. */
export interface KeyPress {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
}

/** Where the key press landed, as an element has it. */
export interface KeyTarget {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
}

/** Inputs that take no typing, so a shortcut over them still works. */
const NOT_TYPED = new Set(["button", "checkbox", "radio", "range", "color", "file", "image", "reset", "submit"]);

/** Whether a key press goes into a field: a text box, a number box, a list to pick from, or editable text. */
export function isTyping(t: KeyTarget | null | undefined): boolean {
  if (!t) return false;
  if (t.isContentEditable) return true;
  const tag = (t.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") return !NOT_TYPED.has((t.type ?? "text").toLowerCase());
  return false;
}

/** The shortcut a key press asks for, or null when it's someone else's key. */
export function shortcutFor(e: KeyPress, target: KeyTarget | null | undefined): Shortcut | null {
  if (e.isComposing || isTyping(target)) return null;
  const key = e.key.toLowerCase();
  const command = e.metaKey || e.ctrlKey;
  if (command) {
    if (e.altKey) return null;
    if (key === "z") return { do: e.shiftKey ? "redo" : "undo" };
    if (key === "k" && !e.shiftKey) return { do: "chat" };
    // Every other ⌘ key stays the browser's, such as ⌘F, ⌘P and ⌘1.
    return null;
  }
  if (e.altKey || e.shiftKey) return null;
  if (key === "f") return { do: "fit" };
  if (key === "x") return { do: "see-through" };
  const camera = CAMERAS.find((c) => c.key === key);
  if (camera) return { do: "camera", view: camera.id };
  const tool = TOOLS.find((t) => t.key.toLowerCase() === key);
  if (tool) return { do: "tool", tool: tool.id };
  return null;
}
