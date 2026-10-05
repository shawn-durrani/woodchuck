// Closing the loop: requests sent to Claude Code turn into built tools when
// their issues close, and the designs that asked are told.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Turn } from "../src/agent.js";
import { scriptedClient } from "../src/scripted.js";
import { Store } from "../src/store.js";
import { syncToolRequests, type IssueState } from "../src/toolstatus.js";

let dir: string;
let store: Store;
const spec = { name: "scarf_joint", purpose: "Join two short boards end to end.", example: "rail_a meets rail_b", inputs: "host, guest, slope", effect: "Cuts a slope on both ends", check: "Both slopes show" };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "woodchuck-loop-"));
  store = new Store(dir);
  const r = store.addToolRequest(spec);
  store.setToolRequestIssue(r.id, "https://github.com/example/woodchuck/issues/23");
  store.project.addChat({ id: "m1", kind: "tool_request", request: r.id, at: "2026-10-03T00:00:00Z" });
  store.project.save();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const lookup = (state: IssueState | null) => async () => state;

describe("closing the loop on missing tools", () => {
  it("marks the tool built, notes the PR and tells the design that asked", async () => {
    const changed = await syncToolRequests(store, lookup({ closed: true, completed: true, pr: { number: 21, url: "https://github.com/example/woodchuck/pull/21" } }));
    expect(changed.map((r) => r.status)).toEqual(["built"]);
    expect(store.toolRequests()[0]).toMatchObject({ status: "built", pr_url: "https://github.com/example/woodchuck/pull/21" });
    expect(store.project.chat.at(-1)).toMatchObject({ kind: "tool_built", request: "tr_1", pr_url: "https://github.com/example/woodchuck/pull/21" });

    const client = scriptedClient([[{ type: "text", text: "Joining the rails." }]]);
    await new Turn(store, client, { chat() {}, delta() {}, changed() {} }, () => Buffer.from("png")).run({ text: "Carry on", selection: [] });
    const text = (client.sent[0]!.messages.at(-1)!.content as unknown as { text: string }[]).at(-1)!.text;
    expect(text).toBe(
      "Carry on\n\n(News since your last turn: the scarf_joint tool you asked for (tr_1) has been built and merged (PR #21). Once Woodchuck is updated it's among your tools, though it may go by another name, so find it there and use it to finish what you couldn't before.)",
    );
  });

  it("marks it declined when the issue was closed as not planned", async () => {
    await syncToolRequests(store, lookup({ closed: true, completed: false }));
    expect(store.toolRequests()[0]!.status).toBe("declined");
    expect(store.project.chat.some((c) => c.kind === "tool_built")).toBe(false);
  });

  it("leaves open issues, and GitHub being unreachable, alone", async () => {
    expect(await syncToolRequests(store, lookup({ closed: false, completed: false }))).toEqual([]);
    expect(await syncToolRequests(store, lookup(null))).toEqual([]);
    expect(store.toolRequests()[0]!.status).toBe("approved");
  });
});
