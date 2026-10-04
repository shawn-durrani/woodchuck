// Honest signals from the server: the chat says when a change was undone,
// and the page knows whether the AI blend can run before it asks you to
// pay for one.

import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordConsoleOps } from "@woodchuck/core";
import { createApp } from "../src/index.js";
import { Store, type ChatItem } from "../src/store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "woodchuck-signals-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ops = recordConsoleOps().filter((o) => o.op !== "rename_design");
const changeLines = (chat: ChatItem[]) => chat.flatMap((c) => (c.kind === "change" ? [{ label: c.label, undone: c.undone === true }] : []));

describe("undone change sets", () => {
  it("marks a change set's line undone, and clears the mark on redo", () => {
    const p = new Store(dir).create("Console", ops);
    p.change("you", "Four drawers", [{ op: "set_param", name: "drawers", expr: "4", unit: "count" }]);
    p.change("you", "Wider gap", [{ op: "set_param", name: "front_gap", expr: "3", unit: "mm" }]);
    p.undo();
    p.undo();
    expect(changeLines(p.chat)).toEqual([
      { label: "Four drawers", undone: true },
      { label: "Wider gap", undone: true },
    ]);
    p.redoOne();
    expect(changeLines(p.chat)).toEqual([
      { label: "Four drawers", undone: false },
      { label: "Wider gap", undone: true },
    ]);
  });

  it("keeps the mark when the design is opened again", () => {
    const store = new Store(dir);
    const p = store.create("Console", ops);
    p.change("you", "Four drawers", [{ op: "set_param", name: "drawers", expr: "4", unit: "count" }]);
    p.undo();
    expect(changeLines(new Store(dir).open(p.slug).chat)).toEqual([{ label: "Four drawers", undone: true }]);
  });
});

describe("whether the AI blend can run", () => {
  const stateOf = async (app: ReturnType<typeof createApp>) => {
    await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
    try {
      const res = await fetch(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/state`);
      return { text: await res.clone().text(), state: (await res.json()) as { has_openai_key: boolean } };
    } finally {
      await app.close();
    }
  };

  it("says there's no OpenAI key when none is set", async () => {
    const before = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      expect((await stateOf(createApp({ dataDir: dir, watchTools: false }))).state.has_openai_key).toBe(false);
    } finally {
      if (before !== undefined) process.env.OPENAI_API_KEY = before;
    }
  });

  it("says there is one when it's set, and never sends the key itself", async () => {
    const before = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "stand-in-value-for-issue-80";
    try {
      const { text, state } = await stateOf(createApp({ dataDir: dir, watchTools: false }));
      expect(state.has_openai_key).toBe(true);
      expect(text).not.toContain("stand-in-value-for-issue-80");
    } finally {
      if (before === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = before;
    }
  });
});
