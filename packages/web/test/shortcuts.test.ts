// Keyboard shortcuts for the daily controls, which never fire while you
// type in a field.

import { describe, expect, it } from "vitest";
import { isTyping, shortcutFor, type KeyPress, type KeyTarget } from "../src/shortcuts.js";

const press = (key: string, mods: Partial<KeyPress> = {}): KeyPress => ({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });
const page: KeyTarget = { tagName: "BODY" };

describe("keyboard shortcuts", () => {
  it("maps each key to its control", () => {
    expect(shortcutFor(press("z", { metaKey: true }), page)).toEqual({ do: "undo" });
    expect(shortcutFor(press("z", { metaKey: true, shiftKey: true }), page)).toEqual({ do: "redo" });
    // With shift held, some browsers report a capital.
    expect(shortcutFor(press("Z", { metaKey: true, shiftKey: true }), page)).toEqual({ do: "redo" });
    expect(shortcutFor(press("z", { ctrlKey: true }), page)).toEqual({ do: "undo" });
    expect(shortcutFor(press("k", { metaKey: true }), page)).toEqual({ do: "chat" });
    expect(shortcutFor(press("f"), page)).toEqual({ do: "fit" });
    expect(shortcutFor(press("x"), page)).toEqual({ do: "see-through" });
    expect(shortcutFor(press("e"), page)).toEqual({ do: "explode" });
    expect(["1", "2", "3", "4", "5", "6"].map((k) => shortcutFor(press(k), page))).toEqual(
      ["iso", "front", "top", "left", "right", "back"].map((view) => ({ do: "camera", view })),
    );
    expect(["v", "b", "p", "h"].map((k) => shortcutFor(press(k), page))).toEqual(["pick", "box", "pin", "pan"].map((tool) => ({ do: "tool", tool })));
    // Caps lock doesn't change what a key does.
    expect(shortcutFor(press("V"), page)).toEqual({ do: "tool", tool: "pick" });
  });

  it("never fires while you type in a field", () => {
    const fields: KeyTarget[] = [
      { tagName: "INPUT", type: "text" },
      { tagName: "INPUT", type: "number" },
      { tagName: "INPUT", type: "search" },
      { tagName: "INPUT" },
      { tagName: "TEXTAREA" },
      { tagName: "SELECT" },
      { tagName: "DIV", isContentEditable: true },
    ];
    const keys = [
      press("z", { metaKey: true }),
      press("z", { metaKey: true, shiftKey: true }),
      press("k", { metaKey: true }),
      ...["f", "x", "e", "1", "2", "3", "4", "5", "6", "v", "b", "p", "h"].map((k) => press(k)),
    ];
    for (const field of fields) {
      expect(isTyping(field), JSON.stringify(field)).toBe(true);
      for (const k of keys) expect(shortcutFor(k, field), `${k.key} in ${JSON.stringify(field)}`).toBeNull();
    }
    // Typing a word with an accent, part way through, isn't a shortcut either.
    expect(shortcutFor(press("f", { isComposing: true }), page)).toBeNull();
  });

  it("still works on controls that take no typing", () => {
    for (const t of [{ tagName: "BUTTON" }, { tagName: "INPUT", type: "range" }, { tagName: "INPUT", type: "checkbox" }, { tagName: "CANVAS" }, null]) {
      expect(isTyping(t)).toBe(false);
      expect(shortcutFor(press("f"), t)).toEqual({ do: "fit" });
    }
  });

  it("leaves the browser's own keys alone", () => {
    for (const k of ["f", "p", "v", "b", "h", "1", "6", "x", "c", "r"]) {
      expect(shortcutFor(press(k, { metaKey: true }), page), `⌘${k}`).toBeNull();
      expect(shortcutFor(press(k, { ctrlKey: true }), page), `ctrl ${k}`).toBeNull();
    }
    expect(shortcutFor(press("z", { metaKey: true, altKey: true }), page)).toBeNull();
    expect(shortcutFor(press("f", { altKey: true }), page)).toBeNull();
    expect(shortcutFor(press("F", { shiftKey: true }), page)).toBeNull();
    expect(shortcutFor(press("Escape"), page)).toBeNull();
    expect(shortcutFor(press("7"), page)).toBeNull();
  });
});
