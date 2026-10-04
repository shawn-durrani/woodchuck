// Talking and editing while Claude builds. Your edits land as steps
// of their own between Claude's, and what you say or change mid-build goes
// in after Claude's next step, beside its tool results. A scripted Claude
// plays the turn, so nothing here needs a key.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { followUp, Turn, userLine, type MessagesClient, type TurnInput } from "../src/agent.js";
import { scriptedClient } from "../src/scripted.js";
import { Store } from "../src/store.js";

type Block = Record<string, unknown>;

const call = (id: string, name: string, input: Block): Block => ({ type: "tool_use", id, name, input });
const param = (name: string, expr: string) => ({ op: "set_param" as const, name, expr, unit: "mm" as const });

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "woodchuck-steer-"));
  store = new Store(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function turn(client: MessagesClient) {
  return new Turn(store, client, { chat() {}, delta() {}, changed() {} }, () => Buffer.from("png"));
}

/** Runs the hook as Claude's nth request goes out, the way a message or an edit arrives while Claude is thinking. */
function during(client: MessagesClient, hooks: Record<number, () => void>): MessagesClient {
  let n = 0;
  return {
    stream(body) {
      const s = client.stream(body);
      hooks[n++]?.();
      return s;
    },
  };
}

/** Sends a message mid-build, the way the chat route does. */
function say(input: Partial<TurnInput> & { text: string }) {
  const full: TurnInput = { selection: [], ...input };
  const line = userLine(full, true);
  store.project.addChat(line);
  store.project.queued.push({ item: line.id, input: full });
  return line.id;
}

const lastSent = (client: { sent: Anthropic.Beta.MessageCreateParamsStreaming[] }, n: number) => client.sent[n]!.messages.at(-1)!.content as unknown as Block[];

describe("your edit while Claude works", () => {
  it("is a step of its own between Claude's, and each undoes alone", () => {
    const p = store.project;
    p.beginChange("claude", "Build a shelf");
    p.apply([param("a", "1")]);
    p.change("you", "Set b", [param("b", "2")]);
    p.apply([param("c", "3")]);
    p.endChange();
    expect(p.history.map((e) => [e.author, e.label])).toEqual([
      ["claude", "Build a shelf"],
      ["you", "Set b"],
      ["claude", "Build a shelf"],
    ]);
    expect(p.chat.filter((c) => c.kind === "change").map((c) => (c.kind === "change" ? [c.author, c.edits] : null))).toEqual([
      ["claude", 1],
      ["you", 1],
      ["claude", 1],
    ]);
    expect(store.versions.log(p.slug).map((v) => v.message).slice(0, 3)).toEqual(["Build a shelf", "Set b", "Build a shelf"]);
    const names = () => p.design.params.map((x) => x.name);
    p.undo();
    expect(names()).toEqual(["a", "b"]);
    p.undo();
    expect(names()).toEqual(["a"]);
    p.undo();
    expect(names()).toEqual([]);
  });

  it("leaves Claude's change set open when it's refused", () => {
    const p = store.project;
    p.beginChange("claude", "Build a shelf");
    p.apply([param("a", "1")]);
    expect(() => p.change("you", "Delete nope", [{ op: "delete_part", id: "nope" }])).toThrow();
    p.apply([param("c", "3")]);
    p.endChange();
    expect(p.history.map((e) => [e.author, e.label])).toEqual([["claude", "Build a shelf"]]);
    expect(p.design.params.map((x) => x.name)).toEqual(["a", "c"]);
  });

  it("opens Claude's change set again even when saving your edit fails", () => {
    const p = store.project;
    p.beginChange("claude", "Build a shelf");
    p.apply([param("a", "1")]);
    const save = p.save.bind(p);
    p.save = () => {
      throw new Error("disk full");
    };
    expect(() => p.change("you", "Set b", [param("b", "2")])).toThrow("disk full");
    p.save = save;
    p.apply([param("c", "3")]);
    expect(p.endChange()).toMatchObject({ author: "claude", label: "Build a shelf" });
  });

  it("doesn't split Claude's work before it has changed anything", () => {
    const p = store.project;
    p.beginChange("claude", "Build a shelf");
    p.change("you", "Set b", [param("b", "2")]);
    p.apply([param("c", "3")]);
    p.endChange();
    expect(p.history.map((e) => e.author)).toEqual(["you", "claude"]);
  });
});

describe("a message sent while Claude works", () => {
  it("goes in after the next step, beside its tool results, and shows as taken in", async () => {
    const client = scripted([[call("t1", "set_param", { name: "a", expr: "1" })], [call("t2", "set_param", { name: "b", expr: "2" })], [{ type: "text", text: "Done." }]]);
    let id = "";
    await turn(during(client, { 0: () => (id = say({ text: "Make it 900 tall", selection: ["shelf"] })) })).run({ text: "Build a shelf", selection: [] });
    expect(lastSent(client, 1)).toEqual([
      expect.objectContaining({ type: "tool_result", tool_use_id: "t1" }),
      {
        type: "text",
        text: '(While you were working, the woodworker said: "Make it 900 tall" Take it in from here. If it changes your plan, say so in a line.)\n\n(Selected in the app: shelf)',
      },
    ]);
    // Only once: the next step's results go alone.
    expect(lastSent(client, 2).map((b) => b.type)).toEqual(["tool_result"]);
    const p = store.project;
    expect(p.queued).toEqual([]);
    // The line moves down to where Claude read it, after the step that was running.
    const at = p.chat.findIndex((c) => c.id === id);
    expect(p.chat[at]).toMatchObject({ kind: "user", during: true, taken: "step" });
    expect(p.chat[at - 1]).toMatchObject({ kind: "tool", name: "set_param", summary: "set param a" });
    expect(p.job).toMatchObject({ id: p.chat.find((c) => c.kind === "user")!.id, ended_at: expect.any(String) });
  });

  it("puts its pictures before its words", async () => {
    const client = scripted([[call("t1", "set_param", { name: "a", expr: "1" })], [{ type: "text", text: "Done." }]]);
    const view = { media_type: "image/jpeg" as const, data: "aGk=", name: "1-view.jpg" };
    const images = [{ media_type: "image/png" as const, data: "aGk=", name: "1-abc.png" }];
    await turn(during(client, { 0: () => say({ text: "Like this", images, view }) })).run({ text: "Build", selection: [] });
    expect(lastSent(client, 1).map((b) => b.type)).toEqual(["tool_result", "image", "image", "text"]);
  });

  it("keeps Claude's history append-only", async () => {
    const client = scripted([[call("t1", "set_param", { name: "a", expr: "1" })], [call("t2", "set_param", { name: "b", expr: "2" })], [{ type: "text", text: "Done." }]]);
    await turn(during(client, { 1: () => say({ text: "Carry on" }) })).run({ text: "Build", selection: [] });
    const before = client.sent[1]!.messages;
    expect(client.sent[2]!.messages.slice(0, before.length)).toEqual(before);
  });

  it("waits for the next turn when the step ends waiting on a question", async () => {
    const client = scripted([[call("q1", "ask_user", { question: "Ply or solid?", options: ["Ply", "Solid"] })], [{ type: "text", text: "Ply it is." }]]);
    let id = "";
    await turn(during(client, { 0: () => (id = say({ text: "Ply, please" })) })).run({ text: "Build a shelf", selection: [] });
    const p = store.project;
    expect(p.pending?.waiting).toEqual([{ tool_use_id: "q1", kind: "question" }]);
    expect(p.queued).toHaveLength(1);
    expect(p.chat.find((c) => c.id === id)).not.toHaveProperty("taken");

    const next = followUp(p)!;
    expect(next).toMatchObject({ text: "Ply, please", queued: [id] });
    await turn(client).run(next);
    const reply = lastSent(client, 1);
    expect(reply[0]).toMatchObject({ type: "tool_result", tool_use_id: "q1", content: "Ply, please" });
    expect(reply.at(-1)).toMatchObject({ text: "Ply, please\n\n(The woodworker sent this while you were still working.)" });
    // The message starts the new request, and isn't shown twice.
    expect(p.chat.filter((c) => c.kind === "user")).toHaveLength(2);
    expect(p.chat.find((c) => c.id === id)).toMatchObject({ taken: "turn" });
    expect(p.job?.id).toBe(id);
  });

  it("isn't taken in on a round the API paused", async () => {
    const replies: Partial<Anthropic.Beta.BetaMessage>[] = [
      { content: [{ type: "text", text: "Searching." }] as never, stop_reason: "pause_turn" },
      { content: [{ type: "text", text: "Done." }] as never, stop_reason: "end_turn" },
    ];
    const sent: Anthropic.Beta.MessageCreateParamsStreaming[] = [];
    const client: MessagesClient = {
      stream(body) {
        sent.push(structuredClone(body));
        const r = replies.shift()!;
        return { on: () => undefined, abort: () => undefined, finalMessage: async () => ({ ...r, usage: { input_tokens: 0, output_tokens: 0 } }) as Anthropic.Beta.BetaMessage };
      },
    };
    await turn(during(client, { 0: () => say({ text: "Make it taller" }) })).run({ text: "Find a hinge", selection: [] });
    expect(JSON.stringify(sent[1]!.messages)).not.toContain("Make it taller");
    expect(store.project.queued).toHaveLength(1);
  });

  it("joins several late messages into one turn, and leaves a waiting preview unapplied", () => {
    const p = store.project;
    p.addChat({ id: "v1", kind: "preview", title: "Deeper top", explanation: "50 mm deeper.", ops: [], status: "proposed", at: "" });
    p.pending = { held: [], waiting: [{ tool_use_id: "v", kind: "preview" }] };
    const a = say({ text: "Taller", selection: ["side_l"] });
    const b = say({ text: "And darker", selection: ["side_l", "top"] });
    expect(followUp(p)).toEqual({
      text: "Taller\n\nAnd darker\n\n(The preview wasn't applied.)",
      selection: ["side_l", "top"],
      images: [],
      pins: [],
      queued: [a, b],
    });
    expect(p.chat.find((c) => c.id === "v1")).toMatchObject({ status: "not_applied" });
    expect(followUp(p)).toBeNull();
  });
});

describe("an edit made while Claude works", () => {
  it("is told to Claude after its next step", async () => {
    const client = scripted([[call("t1", "set_param", { name: "a", expr: "1" })], [call("t2", "set_param", { name: "c", expr: "3" })], [{ type: "text", text: "Done." }]]);
    const hooks = { 1: () => store.project.change("you", "Finish the top in Wien", [param("b", "2")]) };
    await turn(during(client, hooks)).run({ text: "Build", selection: [] });
    expect(lastSent(client, 1).map((b) => b.type)).toEqual(["tool_result"]);
    expect(lastSent(client, 2)).toEqual([
      expect.objectContaining({ type: "tool_result", tool_use_id: "t2" }),
      { type: "text", text: "(While you were working, the woodworker changed: Finish the top in Wien. Read the design again before editing those parts.)" },
    ]);
    const p = store.project;
    expect(p.notes).toEqual([]);
    expect(p.history.map((e) => [e.author, e.label])).toEqual([
      ["claude", "Build"],
      ["you", "Finish the top in Wien"],
      ["claude", "Build"],
    ]);
  });
});

function scripted(replies: Block[][]) {
  return scriptedClient(replies);
}
