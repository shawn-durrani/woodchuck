// An empty chat says how Claude works, offers three starters that fill the
// chat box, and the record console example opens with its own intro.

import { describe, expect, it } from "vitest";
import type { ChatItem } from "../src/api.js";
import { EMPTY_CHAT, emptyChat, FIX_LP_CHECK, STARTERS, starterFill } from "../src/starters.js";

const at = "2026-10-04T09:00:00Z";
const project = (example?: "record_console") => ({ slug: "d", name: "D", ...(example ? { example } : {}) });

describe("the empty chat", () => {
  it("says Claude drafts first and pins the plan after", () => {
    expect(EMPTY_CHAT).toContain("builds a first draft straight away");
    expect(EMPTY_CHAT).toContain("pins its plan");
    expect(EMPTY_CHAT).not.toContain("before it builds");
  });

  it("offers the three starters", () => {
    expect(STARTERS.map((s) => s.label)).toEqual(["A bedside table with a drawer", "Shelves for 200 LPs", "Start from a photo or sketch"]);
  });

  it("fills the chat box with a starter's words, and only the photo one opens the file picker", () => {
    expect(STARTERS.map(starterFill)).toEqual([
      { text: "A bedside table with a drawer, about 450 mm wide, 350 mm deep and 550 mm high.", attach: false },
      { text: "Shelves for 200 LPs. The sleeves are about 315 mm square.", attach: false },
      { text: "Build this from the photo or sketch I've attached. ", attach: true },
    ]);
  });

  it("shows the starters only while the chat is empty", () => {
    expect(emptyChat({ project: project(), chat: [] })).toBe("starters");
    expect(emptyChat({ project: project(), chat: [{ id: "u", kind: "user", text: "Hi", selection: [], at }] })).toBeNull();
  });
});

describe("the record console example's intro", () => {
  it("shows on the example until you first write to Claude", () => {
    expect(emptyChat({ project: project("record_console"), chat: [] })).toBe("example");
    const yours: ChatItem = { id: "c", kind: "change", change: 1, author: "you", label: "Wider", edits: 1, at };
    expect(emptyChat({ project: project("record_console"), chat: [yours] })).toBe("example");
    expect(emptyChat({ project: project("record_console"), chat: [{ id: "u", kind: "user", text: FIX_LP_CHECK, selection: [], at }] })).toBeNull();
  });

  it("never shows on any other design", () => {
    expect(emptyChat({ project: project(), chat: [] })).not.toBe("example");
  });

  it("asks Claude to fix the LP check in words you can change", () => {
    expect(FIX_LP_CHECK).toMatch(/^The LP check fails\./);
  });
});
