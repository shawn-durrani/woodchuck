// A turn that meets trouble. A dropped connection is tried again without
// leaving half a reply behind, a turn an error or Stop ends says so and
// tells the next turn, the typing cursor never sticks, and a message sent
// mid-build that answers a plan says so. A scripted Claude plays each turn,
// so nothing here needs a key.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { followUp, transient, Turn, userLine, type MessagesClient, type TurnEvents } from "../src/agent.js";
import { scriptedClient } from "../src/scripted.js";
import { Store, type ChatItem } from "../src/store.js";

type Block = Record<string, unknown>;

const call = (id: string, name: string, input: Block): Block => ({ type: "tool_use", id, name, input });

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "woodchuck-reliable-"));
  store = new Store(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** What the web app was sent: each chat line and each time the whole state went out. */
function recorder() {
  const log: string[] = [];
  const events: TurnEvents = {
    chat: (item) => log.push(`chat ${item.kind}`),
    delta() {},
    changed: () => log.push("changed"),
  };
  return { log, events };
}

/**
 * Plays the scripted replies, except that the requests named fail with
 * their error, after streaming any thinking and words they were given.
 */
function failing(client: MessagesClient, fails: Record<number, { error: unknown; thinking?: string; text?: string }>) {
  const sent: Anthropic.Beta.MessageCreateParamsStreaming[] = [];
  let n = 0;
  const wrapped: MessagesClient = {
    stream(body) {
      sent.push(structuredClone(body));
      const f = fails[n++];
      if (!f) return client.stream(body);
      const on: Record<string, (d: string) => void> = {};
      return {
        on(event: string, cb: (d: string) => void) {
          on[event] = cb;
          return this;
        },
        async finalMessage(): Promise<Anthropic.Beta.BetaMessage> {
          if (f.thinking) on.thinking?.(f.thinking);
          if (f.text) on.text?.(f.text);
          throw f.error;
        },
        abort() {},
      };
    },
  };
  return { client: wrapped, sent };
}

const dropped = () => new Anthropic.APIConnectionError({ message: "Connection error." });
const midReply = () => {
  const e = new Anthropic.AnthropicError("terminated");
  (e as { cause?: unknown }).cause = Object.assign(new TypeError("terminated"), { cause: { code: "UND_ERR_SOCKET" } });
  return e;
};

function turn(client: MessagesClient, events: TurnEvents = { chat() {}, delta() {}, changed() {} }, delays: number[] = [0, 0]) {
  return new Turn(store, client, events, () => Buffer.from("png"), undefined, delays);
}

const errors = (chat: ChatItem[]) => chat.filter((c): c is ChatItem & { kind: "error" } => c.kind === "error");

describe("a dropped connection", () => {
  it("is tried again, and what the cut-off try streamed leaves the chat", async () => {
    const { log, events } = recorder();
    const { client, sent } = failing(scriptedClient([[{ type: "thinking", thinking: "Sides first." }, { type: "text", text: "Built it." }]]), {
      0: { error: midReply(), thinking: "Sides fir", text: "Buil" },
    });
    await turn(client, events).run({ text: "Build a record cabinet", selection: [] });

    expect(sent).toHaveLength(2);
    expect(sent[1]!.messages).toEqual(sent[0]!.messages);
    const chat = store.project.chat;
    expect(chat.filter((c) => c.kind === "assistant")).toEqual([expect.objectContaining({ text: "Built it." })]);
    expect(chat.filter((c) => c.kind === "thinking")).toEqual([expect.objectContaining({ text: "Sides first." })]);
    expect(chat.find((c) => c.kind === "assistant")).not.toHaveProperty("streaming");
    expect(errors(chat)).toEqual([expect.objectContaining({ text: "The connection to Claude dropped, so Woodchuck is trying again (1 of 2).", retry: true })]);
    // The web app gets the whole chat again once the cut-off lines are gone.
    expect(log.slice(0, 5)).toEqual(["chat user", "chat thinking", "chat assistant", "chat error", "changed"]);
    expect(store.project.job).not.toHaveProperty("error");
    expect(store.project.news).toEqual([]);
  });

  it("is tried twice more at most, then ends the turn with the error and tells the next one", async () => {
    const { client, sent } = failing(scriptedClient([[call("t1", "set_param", { name: "a", expr: "1", unit: "mm" })], [{ type: "text", text: "Carrying on." }]]), {
      1: { error: dropped() },
      2: { error: dropped() },
      3: { error: dropped() },
    });
    await turn(client).run({ text: "Build a record cabinet", selection: [] });
    expect(sent).toHaveLength(4);
    const p = store.project;
    expect(errors(p.chat).map((e) => [e.text, e.retry ?? false])).toEqual([
      ["The connection to Claude dropped, so Woodchuck is trying again (1 of 2).", true],
      ["The connection to Claude dropped, so Woodchuck is trying again (2 of 2).", true],
      ["Claude's API returned an error (no status): Connection error.", false],
    ]);
    expect(p.job).toMatchObject({ error: "Claude's API returned an error (no status): Connection error." });
    const news =
      "your last turn stopped early with an error after 1 step, so it may have left work half done (Claude's API returned an error (no status): Connection error). Read the design and finish what was left, if the woodworker wants";
    expect(p.news).toEqual([news]);
    // The news is kept on disk, so a restart doesn't lose it.
    expect(new Store(dir).project.news).toEqual([news]);

    await turn(client).run({ text: "Carry on", selection: [] });
    const text = (sent.at(-1)!.messages.at(-1)!.content as unknown as Block[]).at(-1)!.text;
    expect(text).toBe(`Carry on\n\n(News since your last turn: ${news}.)`);
    expect(store.project.news).toEqual([]);
  });

  it("is never tried again once stopped, and Stop cuts the wait short", async () => {
    const { client, sent } = failing(scriptedClient([]), { 0: { error: dropped() } });
    // Stop is pressed while the turn waits to try again.
    const t = turn(client, { chat: (item) => item.kind === "error" && item.retry && setTimeout(() => t.stop(), 20), delta() {}, changed() {} }, [60_000]);
    const t0 = Date.now();
    await t.run({ text: "Build a record cabinet", selection: [] });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(sent).toHaveLength(1);
    const p = store.project;
    expect(errors(p.chat).at(-1)).toMatchObject({ text: "Stopped." });
    expect(p.job).toMatchObject({ stopped: true });
    expect(p.job).not.toHaveProperty("error");
    expect(p.news).toEqual([
      "your last turn was stopped by the woodworker after 0 steps, so it may have left work half done. Read the design and finish what was left, if the woodworker wants",
    ]);
  });

  it("isn't tried again for a bad key, a rate limit or a bad request", async () => {
    const { client, sent } = failing(scriptedClient([]), { 0: { error: new Anthropic.AuthenticationError(401, { type: "error", error: { type: "authentication_error" } }, "invalid x-api-key", new Headers()) } });
    await turn(client).run({ text: "Build a record cabinet", selection: [] });
    expect(sent).toHaveLength(1);
    expect(errors(store.project.chat).at(-1)!.text).toMatch(/^Claude couldn't sign in/);
  });
});

describe("which failures are worth trying again", () => {
  const api = (status: number | undefined, type: string) => new Anthropic.APIError(status, { type: "error", error: { type } }, type, status ? new Headers() : undefined, type as never);
  it("tries a dropped or timed-out connection, an overloaded API and a server error again", () => {
    expect(transient(dropped())).toBe(true);
    expect(transient(new Anthropic.APIConnectionTimeoutError())).toBe(true);
    expect(transient(midReply())).toBe(true);
    expect(transient(api(529, "overloaded_error"))).toBe(true);
    expect(transient(new Anthropic.InternalServerError(500, {}, "boom", new Headers()))).toBe(true);
    // An error event mid-stream has only its type.
    expect(transient(api(undefined, "overloaded_error"))).toBe(true);
    expect(transient(api(undefined, "api_error"))).toBe(true);
  });

  it("never tries a bad key, a rate limit, a bad request, a stop or a bug again", () => {
    expect(transient(new Anthropic.AuthenticationError(401, {}, "no", new Headers()))).toBe(false);
    expect(transient(new Anthropic.RateLimitError(429, {}, "slow down", new Headers()))).toBe(false);
    expect(transient(new Anthropic.BadRequestError(400, {}, "bad", new Headers()))).toBe(false);
    expect(transient(api(undefined, "invalid_request_error"))).toBe(false);
    expect(transient(new Anthropic.APIUserAbortError())).toBe(false);
    expect(transient(new Anthropic.AnthropicError("Could not parse"))).toBe(false);
    expect(transient(new Error("terminated"))).toBe(false);
  });
});

describe("the typing cursor", () => {
  it("goes when an error ends the reply, and stays gone on disk", async () => {
    const { client } = failing(scriptedClient([]), { 0: { error: new Error("boom"), text: "Building the carc" } });
    await turn(client).run({ text: "Build a record cabinet", selection: [] });
    const line = store.project.chat.find((c) => c.kind === "assistant");
    expect(line).toMatchObject({ text: "Building the carc" });
    expect(line).not.toHaveProperty("streaming");
    expect(new Store(dir).project.chat.find((c) => c.kind === "assistant")).not.toHaveProperty("streaming");
    expect(store.project.job).toMatchObject({ error: "Something went wrong: boom" });
  });

  it("goes when Stop ends the reply", async () => {
    let t!: Turn;
    const { client } = failing(scriptedClient([]), { 0: { error: new Anthropic.APIUserAbortError(), text: "Building" } });
    t = turn({ stream: (body) => (t.stop(), client.stream(body)) });
    await t.run({ text: "Build a record cabinet", selection: [] });
    expect(store.project.chat.find((c) => c.kind === "assistant")).not.toHaveProperty("streaming");
    expect(store.project.job).toMatchObject({ stopped: true });
  });
});

describe("a message sent while Claude works, when the turn ends on a plan", () => {
  it("is taken as the reply to the plan, and the card and Claude both say so", async () => {
    const client = scriptedClient([
      [call("p1", "submit_plan", { summary: "A walnut record cabinet", parts: [{ label: "Side", qty: 2, tag: "side" }], key_dims: [], joints: [], assumptions: [] })],
      [{ type: "text", text: "Oak it is." }],
    ]);
    let id = "";
    const sayIt: MessagesClient = {
      stream(body) {
        const s = client.stream(body);
        if (!id) {
          const input = { text: "Make it oak", selection: [] };
          const line = userLine(input, true);
          store.project.addChat(line);
          store.project.queued.push({ item: line.id, input });
          id = line.id;
        }
        return s;
      },
    };
    await turn(sayIt).run({ text: "Build a record cabinet", selection: [] });
    const p = store.project;
    expect(p.pending?.waiting).toEqual([{ tool_use_id: "p1", kind: "plan" }]);

    await turn(client).run(followUp(p)!);
    expect(p.chat.find((c) => c.kind === "plan")).toMatchObject({ answered: "Make it oak", answered_by: id });
    const reply = client.sent[1]!.messages.at(-1)!.content as unknown as Block[];
    expect(reply[0]).toMatchObject({ type: "tool_result", tool_use_id: "p1", content: "Make it oak" });
    expect(reply.at(-1)!.text).toBe(
      "Make it oak\n\n(The woodworker sent this while you were still working. It's taken as their reply to your plan, though they may not have seen it yet. If it doesn't answer it, ask again.)",
    );
  });
});

describe("a message sent while Claude works, when the reply is cut off mid-tool call", () => {
  it("goes in after the not-run results, and answers no card", async () => {
    const client = scriptedClient([
      [call("t1", "add_panel", { id: "side", length_mm: 600, width_mm: 300, thickness_mm: 18 }), call("t2", "check_design", {})],
      [{ type: "text", text: "Carrying on." }],
    ]);
    let id = "";
    let cut = true;
    const sayIt: MessagesClient = {
      stream(body) {
        const s = client.stream(body);
        if (!id) {
          const input = { text: "Make it oak", selection: [] };
          const line = userLine(input, true);
          store.project.addChat(line);
          store.project.queued.push({ item: line.id, input });
          id = line.id;
        }
        return {
          on: (event, cb) => s.on(event, cb),
          abort: () => s.abort(),
          finalMessage: async () => {
            const m = await s.finalMessage();
            const out = cut ? { ...m, stop_reason: "max_tokens" as const } : m;
            cut = false;
            return out;
          },
        };
      },
    };
    const p = store.project;
    // A question card an earlier turn left open isn't what this message answers.
    p.addChat({ id: "q-old", kind: "question", question: "Which timber?", options: [], at: new Date().toISOString() });
    await turn(sayIt).run({ text: "Build a record cabinet", selection: [] });
    expect(p.pending).toMatchObject({ waiting: [] });
    expect(p.job).toMatchObject({ error: expect.stringMatching(/cut off/) });
    expect(p.news).toHaveLength(1);

    await turn(sayIt).run(followUp(p)!);
    const reply = client.sent[1]!.messages.at(-1)!.content as unknown as Block[];
    expect(reply.map((b) => b.tool_use_id ?? b.type)).toEqual(["t1", "t2", "text"]);
    expect(reply.slice(0, 2).every((b) => b.is_error === true && /^Not run/.test(String(b.content)))).toBe(true);
    const text = String(reply.at(-1)!.text);
    expect(text).toMatch(/^Make it oak\n\n\(The woodworker sent this while you were still working\.\)\n\n\(News since your last turn: your last turn stopped early/);
    expect(text).not.toContain("taken as their reply");
    expect(p.chat.find((c) => c.id === "q-old")).not.toHaveProperty("answered");
    expect(p.chat.some((c) => "answered_by" in c)).toBe(false);
    expect(p.pending).toBeNull();
  });
});
