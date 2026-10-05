// Issue #11: each turn picks how hard Claude thinks, without restarting the
// cache. The request's own level never changes. An effort message goes in
// just before a user message, and only when the level changes. A scripted
// Claude plays every turn, so nothing here needs a key.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { EFFORT_MESSAGE_BETA, effortInForce, effortMessage, Turn, userLine, type MessagesClient, type TurnInput } from "../src/agent.js";
import { scriptedClient } from "../src/scripted.js";
import { Store } from "../src/store.js";

type Block = Record<string, unknown>;
type Sent = Anthropic.Beta.MessageCreateParamsStreaming;
type Body = Sent & { betas?: string[] };

const call = (id: string, name: string, input: Block): Block => ({ type: "tool_use", id, name, input });
const text = (t: string): Block[] => [{ type: "text", text: t }];
const finish = (id: string) => call(id, "set_finish", { targets: ["top"], finish: "amsterdam" });

let dir: string;
let store: Store;
let routing: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "woodchuck-effort-"));
  store = new Store(dir);
  routing = process.env.WOODCHUCK_EFFORT_ROUTING;
  delete process.env.WOODCHUCK_EFFORT_ROUTING;
  // An invented top for a console Alex is making: one 30 mm oak board, 1200 by 400 mm.
  store.project.apply([
    { op: "define_material", id: "oak30", name: "30 mm oak", kind: "solid", thickness_mm: 30, grained: true },
    {
      op: "add_panel",
      id: "top",
      name: "Top",
      material: "oak30",
      thickness_axis: "y",
      grain_axis: "x",
      x: { start: { at: "0" }, size: "1200" },
      y: { start: { at: "700" } },
      z: { start: { at: "0" }, size: "400" },
    },
  ]);
});
afterEach(() => {
  if (routing === undefined) delete process.env.WOODCHUCK_EFFORT_ROUTING;
  else process.env.WOODCHUCK_EFFORT_ROUTING = routing;
  rmSync(dir, { recursive: true, force: true });
});

function turn(client: MessagesClient) {
  return new Turn(store, client, { chat() {}, delta() {}, changed() {} }, () => Buffer.from("png"));
}

const ask = (t: string): TurnInput => ({ text: t, selection: [] });
const isEffort = (m: Anthropic.Beta.BetaMessageParam) => m.role === "system";
const efforts = (messages: Anthropic.Beta.BetaMessageParam[]) => messages.filter(isEffort).map((m) => m.output_config?.effort);
const lastUsage = () => store.project.chat.findLast((c) => c.kind === "usage");

/**
 * Every request starts with the one before it, plus that request's reply.
 * Nothing earlier is ever edited, effort messages included.
 */
function expectAppendOnly(sent: Sent[]) {
  for (let i = 1; i < sent.length; i++) {
    const before = sent[i - 1]!.messages;
    expect(sent[i]!.messages.slice(0, before.length)).toEqual(before);
  }
}

/** The request's own settings, which must be the same on every request. */
function expectSteadyRequest(sent: Sent[]) {
  const steady = (b: Sent) => {
    const body = b as unknown as Record<string, unknown>;
    return { system: body.system, tools: body.tools, output_config: body.output_config, thinking: body.thinking, model: body.model, cache_control: body.cache_control };
  };
  for (const b of sent) expect(steady(b)).toEqual(steady(sent[0]!));
  expect((sent[0] as unknown as Record<string, unknown>).output_config).toEqual({ effort: "high" });
}

describe("the level of each turn", () => {
  it("lowers a colour try with an effort message just before the woodworker's words", async () => {
    const client = scriptedClient([[finish("t1")], text("Amsterdam on the top.")]);
    const t = turn(client);
    await t.run(ask("Try Amsterdam on the top"));

    const first = client.sent[0]!.messages;
    expect(first.at(-2)).toEqual({ role: "system", content: [], output_config: { effort: "low" } });
    expect(first.at(-1)!.role).toBe("user");
    expect((client.sent[0] as Body).betas).toContain(EFFORT_MESSAGE_BETA);
    // The second round is still low, so no second message goes in.
    expect(efforts(client.sent[1]!.messages)).toEqual(["low"]);
    expect(t.roundEfforts()).toEqual(["low", "low"]);
    expect(lastUsage()).toMatchObject({ efforts: ["low", "low"], route: "finish" });
    expectSteadyRequest(client.sent);
    expectAppendOnly(client.sent);
  });

  it("adds nothing for a turn at the configured level, and no beta", async () => {
    const client = scriptedClient([text("Done.")]);
    await turn(client).run(ask("Carry on"));
    expect(efforts(client.sent[0]!.messages)).toEqual([]);
    expect((client.sent[0] as Body).betas).not.toContain(EFFORT_MESSAGE_BETA);
    expect(lastUsage()).toMatchObject({ efforts: ["high"], route: "unrecognised" });
  });

  it("adds a message only when the level changes from one turn to the next", async () => {
    const client = scriptedClient([text("Amsterdam."), text("400 mm."), text("Deeper."), text("Dovetails.")]);
    await turn(client).run(ask("Try Amsterdam on the top"));
    await turn(client).run(ask("How deep is the top?"));
    await turn(client).run(ask("Make the top 20 mm deeper"));
    await turn(client).run(ask("Use dovetails at the corners"));

    // Low, low again with no new message, then medium, then back to high.
    expect(client.sent.map((b) => efforts(b.messages))).toEqual([["low"], ["low"], ["low", "medium"], ["low", "medium", "high"]]);
    expect(client.sent.map((b) => effortInForce(b.messages))).toEqual(["low", "low", "medium", "high"]);
    // Each effort message sits just before the user message it governs.
    for (const b of client.sent) {
      const i = b.messages.findLastIndex(isEffort);
      expect(b.messages[i + 1]!.role).toBe("user");
    }
    expectSteadyRequest(client.sent);
    expectAppendOnly(client.sent);
  });

  it("goes back up once Claude reaches for a tool that needs judgement", async () => {
    const client = scriptedClient([[finish("t1"), call("t2", "list_joints", {})], [finish("t3")], text("Done.")]);
    const t = turn(client);
    await t.run(ask("Try Amsterdam on the top"));

    // After list_joints, the next request carries a message raising it back, just before the tool results.
    const second = client.sent[1]!.messages;
    expect(second.at(-2)).toEqual(effortMessage("high"));
    expect((second.at(-1)!.content as unknown as Block[]).map((b) => b.type)).toEqual(["tool_result", "tool_result"]);
    // It stays up for the rest of the turn, with no further message.
    expect(efforts(client.sent[2]!.messages)).toEqual(["low", "high"]);
    expect(t.roundEfforts()).toEqual(["low", "high", "high"]);
    expectSteadyRequest(client.sent);
    expectAppendOnly(client.sent);
  });

  it("raises the level for a web search on Anthropic's side", async () => {
    const client = scriptedClient([
      [{ type: "server_tool_use", id: "s1", name: "web_search", input: { query: "Initech oak oil" } }, finish("t1")],
      text("Done."),
    ]);
    const t = turn(client);
    await t.run(ask("Try Amsterdam on the top"));
    expect(t.roundEfforts()).toEqual(["low", "high"]);
  });

  it("stays low when Claude only uses everyday tools", async () => {
    const client = scriptedClient([[finish("t1"), call("t2", "check_design", {})], text("Done.")]);
    const t = turn(client);
    await t.run(ask("Try Amsterdam on the top"));
    expect(efforts(client.sent[1]!.messages)).toEqual(["low"]);
    expect(t.roundEfforts()).toEqual(["low", "low"]);
  });

  it("raises the level for a message sent mid-turn that needs more thought", async () => {
    const base = scriptedClient([[finish("t1")], text("Done.")]);
    let n = 0;
    const client: MessagesClient = {
      stream(body) {
        const s = base.stream(body);
        if (n++ === 0) {
          const input = ask("Actually, use dovetails on the drawers too");
          const line = userLine(input, true);
          store.project.addChat(line);
          store.project.queued.push({ item: line.id, input });
        }
        return s;
      },
    };
    const t = turn(client);
    await t.run(ask("Try Amsterdam on the top"));
    expect(base.sent[1]!.messages.at(-2)).toEqual(effortMessage("high"));
    expect(t.roundEfforts()).toEqual(["low", "high"]);
  });

  it("sets the level again after a summary, which drops the effort messages before it", async () => {
    const client = scriptedClient([
      [{ type: "compaction", content: "Alex wants an oak console.", encrypted_content: null }, finish("t1")],
      text("Done."),
    ]);
    const t = turn(client);
    await t.run(ask("Try Amsterdam on the top"));

    // Only the summary onwards is sent, so the low level has to be said again after it.
    const second = client.sent[1]!.messages;
    expect((second[0]!.content as unknown as Block[])[0]).toMatchObject({ type: "compaction" });
    expect(second.slice(1, 2)).toEqual([effortMessage("low")]);
    expect(t.roundEfforts()).toEqual(["low", "low"]);
    // The whole chat keeps both messages.
    expect(efforts(store.project.messages)).toEqual(["low", "low"]);
  });
});

describe("routing turned off", () => {
  it("runs every turn at the configured level with no effort messages", async () => {
    process.env.WOODCHUCK_EFFORT_ROUTING = "off";
    const client = scriptedClient([[finish("t1"), call("t2", "list_joints", {})], text("Done."), text("400 mm.")]);
    const t = turn(client);
    await t.run(ask("Try Amsterdam on the top"));
    await turn(client).run(ask("How deep is the top?"));
    for (const b of client.sent) {
      expect(efforts(b.messages)).toEqual([]);
      expect((b as Body).betas).not.toContain(EFFORT_MESSAGE_BETA);
    }
    expect(t.roundEfforts()).toEqual(["high", "high"]);
    expect(lastUsage()).not.toHaveProperty("route");
    expectSteadyRequest(client.sent);
  });

  it("puts a chat that was lowered back at the configured level, once", async () => {
    const client = scriptedClient([text("Amsterdam."), text("Done."), text("Done again.")]);
    await turn(client).run(ask("Try Amsterdam on the top"));
    process.env.WOODCHUCK_EFFORT_ROUTING = "off";
    await turn(client).run(ask("Try Kyoto on the top"));
    await turn(client).run(ask("Try Natur on the top"));
    expect(client.sent.map((b) => efforts(b.messages))).toEqual([["low"], ["low", "high"], ["low", "high"]]);
    // The chat still holds effort messages, so the beta stays on.
    expect((client.sent[2] as Body).betas).toContain(EFFORT_MESSAGE_BETA);
    expectAppendOnly(client.sent);
  });
});

describe("the level in force", () => {
  it("is the request's own level until an effort message changes it", () => {
    expect(effortInForce([], "high")).toBe("high");
    expect(effortInForce([{ role: "user", content: "hi" }, effortMessage("low"), { role: "user", content: "again" }], "high")).toBe("low");
    expect(effortInForce([effortMessage("low"), { role: "user", content: "hi" }, effortMessage("medium")], "high")).toBe("medium");
    // A system message with words and no level leaves it alone.
    expect(effortInForce([effortMessage("low"), { role: "system", content: "Be brief." }], "high")).toBe("low");
  });

  it("counts only the summary onwards", () => {
    const summary: Anthropic.Beta.BetaMessageParam = { role: "assistant", content: [{ type: "compaction", content: "A console.", encrypted_content: null } as unknown as Anthropic.Beta.BetaContentBlockParam] };
    expect(effortInForce([effortMessage("low"), { role: "user", content: "hi" }, summary], "high")).toBe("high");
  });
});
