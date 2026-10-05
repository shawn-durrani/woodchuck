// A long chat summarised between turns, in the background. A scripted
// Claude replies to each turn and to each request for a summary, with token
// counts the test sets, so no key and no network. It's off unless
// WOODCHUCK_COMPACT_IDLE_AT is set, and off leaves every request as it was.
// Issue #20.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { compactAt, compactIdleAt, ON_DEMAND_BETA, SUMMARY_INSTRUCTIONS, Turn, type MessagesClient } from "../src/agent.js";
import { createApp } from "../src/index.js";
import { scriptedClient, type ScriptBlock } from "../src/scripted.js";
import { Store } from "../src/store.js";
import { RETRY_AFTER_MS, RETRY_GROWTH, SUMMARY_MAX_TOKENS, Summaries } from "../src/summaries.js";
import { turnsOf } from "../src/turnstats.js";

type Body = Anthropic.Beta.MessageCreateParamsStreaming & Record<string, unknown>;

const call = (id: string, name: string, input: ScriptBlock): ScriptBlock => ({ type: "tool_use", id, name, input });
/** A reply's token counts, as the chat size the next request carries. */
const tokens = (n: number): ScriptBlock => ({ type: "usage", input_tokens: 40, cache_read_input_tokens: n - 100, output_tokens: 60 });
/** A summary as the API returns it, signature and all. */
const summary = (content: string, signature: string): ScriptBlock => ({ type: "compaction", content, signature });
const SUMMARY_COST: ScriptBlock = { type: "usage", input_tokens: 2_000, cache_read_input_tokens: 118_000, cache_creation_input_tokens: 0, output_tokens: 900 };

/** A reply held back until the test opens it. */
function gate() {
  let open!: () => void;
  const until = new Promise<void>((r) => (open = r));
  return { block: { type: "gate", until } as ScriptBlock, open };
}

const ENV = ["WOODCHUCK_COMPACT_AT", "WOODCHUCK_COMPACT_IDLE_AT", "WOODCHUCK_EFFORT_ROUTING"] as const;
let saved: Record<string, string | undefined>;
let dir: string;
let store: Store;
let replies: ScriptBlock[][];
let summaryReplies: ScriptBlock[][];
let client: ReturnType<typeof scriptedClient>;
let summaries: Summaries;
/** The wall clock the summaries read, in milliseconds. */
let clock = 0;

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  // Every turn at one level, so no effort message joins the chat.
  process.env.WOODCHUCK_EFFORT_ROUTING = "off";
  // On, at the size the docs suggest. The tests of it off unset it again.
  process.env.WOODCHUCK_COMPACT_IDLE_AT = "100000";
  dir = mkdtempSync(path.join(tmpdir(), "woodchuck-summaries-"));
  store = new Store(dir);
  replies = [];
  summaryReplies = [];
  client = scriptedClient(replies, summaryReplies);
  clock = 1_000;
  summaries = new Summaries(store, undefined, () => clock);
});
afterEach(async () => {
  summaries.stop();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

function turn(c: MessagesClient = client) {
  return new Turn(store, c, { chat() {}, delta() {}, changed() {} }, () => Buffer.from("png"), undefined, [], undefined, summaries);
}
const say = (text: string, c?: MessagesClient) => turn(c).run({ text, selection: [] });
const onDisk = (file: string) => JSON.parse(readFileSync(path.join(store.project.dir, file), "utf8")) as unknown[];
const firstBlock = (body: Body) => (body.messages[0]!.content as unknown as ScriptBlock[])[0];

describe("a summary between turns", () => {
  it("is asked for once a turn ends past the threshold, and only then", async () => {
    replies.push([{ type: "text", text: "A bookshelf for Sam, then." }, tokens(60_000)]);
    await say("A bookshelf for Sam");
    expect(client.summarised).toHaveLength(0);

    const held = gate();
    summaryReplies.push([held.block, summary("Sam wants a fir bookshelf.", "sig-1")]);
    replies.push([{ type: "text", text: "Fir it is." }, tokens(120_000)]);
    await say("In fir");
    // The turn has ended and the summary is still being written.
    expect(summaries.busy).toBe(true);
    expect(client.summarised).toHaveLength(1);
    held.open();
    await summaries.settled();
    expect(summaries.busy).toBe(false);
  });

  it("covers exactly the turn's last request, with its model, instructions, tools and thinking", async () => {
    summaryReplies.push([summary("Sam wants a fir bookshelf.", "sig-1")]);
    replies.push([call("t1", "set_param", { name: "width", expr: "900", unit: "mm" }), tokens(90_000)], [{ type: "text", text: "Set to 900." }, tokens(110_000)]);
    await say("Make it 900 wide");
    await summaries.settled();
    const last = client.sent.at(-1)! as Body;
    const asked = client.summarised[0]! as Body;
    expect(asked.compaction).toEqual({ type: "summarize", instructions: SUMMARY_INSTRUCTIONS });
    expect(asked.messages).toEqual(last.messages);
    for (const k of ["model", "system", "tools", "thinking", "output_config", "cache_control"]) expect(asked[k], k).toEqual(last[k]);
    expect(asked.max_tokens).toBe(SUMMARY_MAX_TOKENS);
    expect(asked.betas).toContain(ON_DEMAND_BETA);
    expect(asked.betas).toContain("thinking-binding-controls-2026-08-01");
    expect(asked.betas).not.toContain("compact-2026-01-12");
    // The API refuses a threshold summary beside this one, and fallbacks aren't asked for.
    expect(asked.context_management).toBeUndefined();
    expect(asked.fallbacks).toBeUndefined();
    expect(asked.betas).not.toContain("server-side-fallback-2026-07-01");
    expect(SUMMARY_INSTRUCTIONS).toMatch(/Don't call any tools\.$/);
  });

  it("goes first in the next turn's request, in place of the messages it covers, and the saved chat only grows", async () => {
    summaryReplies.push([summary("Sam wants a fir bookshelf, 900 wide.", "sig-1"), SUMMARY_COST]);
    replies.push([{ type: "text", text: "Fir, 900 wide." }, tokens(120_000)]);
    await say("A fir bookshelf for Sam, 900 wide");
    await summaries.settled();
    const before = onDisk("messages.json");
    expect(onDisk("compactions.json")).toEqual([{ block: { type: "compaction", content: "Sam wants a fir bookshelf, 900 wide.", signature: "sig-1" }, upto: 1, at: expect.any(String) }]);
    expect(store.project.chat.find((c) => c.kind === "summary")).toMatchObject({ input: 2_000, cached: 118_000, written: 0, output: 900, ms: expect.any(Number) });

    replies.push([{ type: "text", text: "Oak, then." }, tokens(5_000)]);
    await say("Actually oak");
    const next = client.sent.at(-1)! as Body;
    // The block exactly as returned, then Claude's reply to the request it covered, then the new message.
    expect(next.messages.map((m) => m.role)).toEqual(["assistant", "assistant", "user"]);
    expect(next.messages[0]).toEqual({ role: "assistant", content: [{ type: "compaction", content: "Sam wants a fir bookshelf, 900 wide.", signature: "sig-1" }] });
    expect(next.messages[1]).toEqual(before[1]);
    expect(next.betas).toContain(ON_DEMAND_BETA);
    // The API can't summarise at a threshold on a request that carries this summary.
    expect(next.context_management).toBeUndefined();
    expect(next.betas).not.toContain("compact-2026-01-12");

    const after = onDisk("messages.json");
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.length).toBeGreaterThan(before.length);
  });

  it("never holds up a turn that starts while it's written, and goes in at that turn's next request", async () => {
    const held = gate();
    summaryReplies.push([held.block, summary("Sam wants a fir bookshelf.", "sig-1")]);
    replies.push([{ type: "text", text: "Fir it is." }, tokens(120_000)]);
    await say("A fir bookshelf for Sam");
    expect(summaries.busy).toBe(true);

    const step = gate();
    replies.push([call("t1", "set_param", { name: "width", expr: "900", unit: "mm" }), tokens(121_000)], [step.block, call("t2", "set_param", { name: "depth", expr: "300", unit: "mm" })], [{ type: "text", text: "Sized." }]);
    const running = say("900 wide and 300 deep");
    // The turn's first two requests go out on the whole chat while the summary is still being written.
    while (client.sent.length < 3) await new Promise((r) => setTimeout(r, 5));
    expect(summaries.busy).toBe(true);
    expect(client.sent.slice(1, 3).every((b) => firstBlock(b as Body)?.type !== "compaction")).toBe(true);
    expect(client.sent[2]!.messages[0]).toEqual(store.project.messages[0]);

    held.open();
    await summaries.settled();
    step.open();
    await running;
    // The request after the summary landed starts with it, and keeps everything after the messages it covers.
    const swapped = client.sent[3]! as Body;
    expect(firstBlock(swapped)).toEqual({ type: "compaction", content: "Sam wants a fir bookshelf.", signature: "sig-1" });
    expect(swapped.messages.slice(1)).toEqual(store.project.messages.slice(1, store.project.messages.length - 1));
    expect(swapped.messages.filter((m) => Array.isArray(m.content) && (m.content as unknown as ScriptBlock[]).some((b) => b.type === "compaction"))).toHaveLength(1);
  });

  it("is dropped when it fails or comes back empty, and the next turn sends the whole chat", async () => {
    summaryReplies.push([{ type: "text", text: "Here is a summary." }]);
    replies.push([{ type: "text", text: "Fir it is." }, tokens(120_000)]);
    await say("A fir bookshelf for Sam");
    await summaries.settled();
    expect(store.project.compactions).toEqual([]);
    expect(store.project.chat.some((c) => c.kind === "summary")).toBe(false);

    // A request that fails outright is dropped the same way.
    const failing: MessagesClient = {
      stream(body) {
        if ((body as Body).compaction === undefined) return client.stream(body);
        return {
          on() {
            return this;
          },
          finalMessage: async () => {
            throw new Error("Overloaded");
          },
          abort() {},
        };
      },
    };
    replies.push([{ type: "text", text: "Oak, then." }, tokens(120_000 + RETRY_GROWTH)]);
    await say("Actually oak", failing);
    await summaries.settled();
    expect(summaries.busy).toBe(false);
    expect(store.project.compactions).toEqual([]);
    expect(client.summarised).toHaveLength(1);

    replies.push([{ type: "text", text: "Still oak." }]);
    await say("And the shelves?");
    const next = client.sent.at(-1)! as Body;
    expect(next.messages).toHaveLength(store.project.messages.length - 1);
    expect(next.context_management).toBeDefined();
  });

  it("never starts while Claude waits on the woodworker or a message waits to be read", async () => {
    replies.push([call("q1", "ask_user", { question: "Fir or oak?", options: ["Fir", "Oak"] }), tokens(120_000)]);
    await say("A bookshelf for Sam");
    expect(store.project.pending?.waiting).toEqual([{ tool_use_id: "q1", kind: "question" }]);
    expect(client.summarised).toHaveLength(0);

    const last = gate();
    replies.push([last.block, { type: "text", text: "Fir it is." }, tokens(121_000)]);
    const running = say("Fir");
    while (client.sent.length < 2) await new Promise((r) => setTimeout(r, 5));
    store.project.queued.push({ item: "u-late", input: { text: "And 900 wide", selection: [] } });
    last.open();
    await running;
    expect(client.summarised).toHaveLength(0);

    // The next idle point asks for it.
    replies.push([{ type: "text", text: "Fir, 900 wide." }, tokens(122_000)]);
    store.project.queued.length = 0;
    await say("And 900 wide");
    expect(client.summarised).toHaveLength(1);
  });

  it("is dropped when it lands after the API summarised the chat itself, or after another design was opened", async () => {
    const held = gate();
    summaryReplies.push([held.block, summary("Sam wants a fir bookshelf.", "sig-1")]);
    replies.push([{ type: "text", text: "Fir it is." }, tokens(120_000)]);
    await say("A fir bookshelf for Sam");
    replies.push([{ type: "compaction", content: "Sam wants fir.", encrypted_content: null }, { type: "text", text: "Noted." }]);
    await say("Remember the fir");
    held.open();
    await summaries.settled();
    expect(store.project.compactions).toEqual([]);

    const other = gate();
    summaryReplies.push([other.block, summary("Dave wants an oak desk.", "sig-2")]);
    replies.push([{ type: "text", text: "Oak desk." }, tokens(130_000)]);
    await say("An oak desk for Dave");
    const desk = store.project;
    store.create("Mateo's stool");
    other.open();
    await summaries.settled();
    expect(desk.compactions).toEqual([]);
    expect(store.project.compactions).toEqual([]);
  });

  it("summarises a single long turn between its steps once the chat already holds a summary", async () => {
    summaryReplies.push([summary("Sam wants a fir bookshelf.", "sig-1")]);
    replies.push([{ type: "text", text: "Fir it is." }, tokens(120_000)]);
    await say("A fir bookshelf for Sam");
    await summaries.settled();

    const step = gate();
    summaryReplies.push([summary("Sam's fir bookshelf is half built.", "sig-2")]);
    replies.push(
      [call("t1", "set_param", { name: "width", expr: "900", unit: "mm" }), tokens(160_000)],
      [step.block, call("t2", "set_param", { name: "depth", expr: "300", unit: "mm" }), tokens(170_000)],
      [{ type: "text", text: "Built." }],
    );
    const running = say("Build it");
    while (client.sent.length < 3) await new Promise((r) => setTimeout(r, 5));
    // The turn's first reply passed the fallback size, so its request is summarised without waiting.
    expect(client.summarised).toHaveLength(2);
    expect(client.summarised[1]!.messages).toEqual(client.sent[1]!.messages);
    await summaries.settled();
    step.open();
    await running;
    const swapped = client.sent[3]! as Body;
    expect(firstBlock(swapped)).toEqual({ type: "compaction", content: "Sam's fir bookshelf is half built.", signature: "sig-2" });
    expect(swapped.messages[1]!.role).toBe("assistant");
    expect(store.project.compactions.map((c) => c.upto)).toEqual([1, 3]);
  });

  it("stays off with WOODCHUCK_COMPACT_AT=off, along with the API's own, and alone with WOODCHUCK_COMPACT_IDLE_AT=off", async () => {
    process.env.WOODCHUCK_COMPACT_AT = "off";
    replies.push([{ type: "text", text: "Fir it is." }, tokens(500_000)]);
    await say("A fir bookshelf for Sam");
    expect(client.summarised).toHaveLength(0);
    expect((client.sent[0] as Body).context_management).toBeUndefined();

    process.env.WOODCHUCK_COMPACT_AT = "150000";
    process.env.WOODCHUCK_COMPACT_IDLE_AT = "off";
    replies.push([{ type: "text", text: "Oak, then." }, tokens(140_000)]);
    await say("Actually oak");
    expect(client.summarised).toHaveLength(0);
    expect((client.sent[1] as Body).context_management).toBeDefined();
  });

  it("waits after one fails until the chat has grown by 20,000 tokens or an hour has passed", async () => {
    // An empty summary at 120,000 tokens.
    summaryReplies.push([{ type: "text", text: "No summary." }]);
    replies.push([{ type: "text", text: "Fir it is." }, tokens(120_000)]);
    await say("A fir bookshelf for Sam");
    await summaries.settled();
    expect(client.summarised).toHaveLength(1);

    // Grown by less than the gap, ten minutes on: no new try.
    clock += 10 * 60_000;
    replies.push([{ type: "text", text: "Oak, then." }, tokens(120_000 + RETRY_GROWTH - 1)]);
    await say("Actually oak");
    expect(client.summarised).toHaveLength(1);

    // Grown by the gap: a new try, which comes back empty again.
    summaryReplies.push([{ type: "text", text: "Still no summary." }]);
    replies.push([{ type: "text", text: "Oak shelves." }, tokens(120_000 + RETRY_GROWTH)]);
    await say("And the shelves?");
    await summaries.settled();
    expect(client.summarised).toHaveLength(2);

    // Barely grown since that one, but an hour on: a new try, and it lands.
    replies.push([{ type: "text", text: "Two shelves." }, tokens(120_000 + RETRY_GROWTH + 1_000)]);
    await say("Two shelves");
    expect(client.summarised).toHaveLength(2);
    clock += RETRY_AFTER_MS;
    summaryReplies.push([summary("Sam wants an oak bookshelf with two shelves.", "sig-1")]);
    replies.push([{ type: "text", text: "Two oak shelves." }, tokens(120_000 + RETRY_GROWTH + 2_000)]);
    await say("Oak, two shelves");
    await summaries.settled();
    expect(client.summarised).toHaveLength(3);
    expect(store.project.compactions).toHaveLength(1);
  });

  it("keeps the woodworker's answers and asked-for sizes in the summary prompt", () => {
    expect(SUMMARY_INSTRUCTIONS).toContain(
      "- the woodworker's answers to Claude's questions, plans, previews and part proposals. These arrive as tool results, but they are the woodworker's own words, so keep them like any other requirement, with sizes and numbers exactly as given\n",
    );
    expect(SUMMARY_INSTRUCTIONS).toContain(
      "A size the woodworker asked for is a requirement, so keep it exactly as given even when it's also in the design. Their answers to questions, plans, previews and part proposals are not tool call details.",
    );
    expect(SUMMARY_INSTRUCTIONS).toMatch(/^Summarise this furniture design conversation so Claude can carry on from it without the earlier turns\./);
  });

  it("keeps its tokens on its own chat line, and the turn stats still count one turn per turn", async () => {
    summaryReplies.push([summary("Sam wants a fir bookshelf.", "sig-1"), SUMMARY_COST]);
    replies.push([{ type: "text", text: "Fir it is." }, tokens(120_000)], [{ type: "text", text: "Oak, then." }]);
    await say("A fir bookshelf for Sam");
    await summaries.settled();
    await say("Actually oak");
    const turns = turnsOf(store.project.chat, store.project.messages);
    expect(turns).toHaveLength(2);
    expect(turns.map((t) => t.calls)).toEqual([[0], [0]]);
    expect(turns[0]!.cached).toBe(119_900);
  });
});

describe("with WOODCHUCK_COMPACT_IDLE_AT unset", () => {
  beforeEach(() => {
    delete process.env.WOODCHUCK_COMPACT_IDLE_AT;
  });

  it("is off, and the thresholds read as they always have", () => {
    expect(compactIdleAt(undefined, undefined)).toBeNull();
    expect(compactIdleAt("", undefined)).toBeNull();
    expect(compactIdleAt("nonsense", undefined)).toBeNull();
    expect(compactIdleAt("off", undefined)).toBeNull();
    expect(compactIdleAt("100000", undefined)).toBe(100_000);
    expect(compactIdleAt("90000", "120000")).toBe(90_000);
    expect(compactIdleAt("100000", "off")).toBeNull();
    // The API's own summary is at 100,000 with it off, and a fallback at 150,000 with it on.
    expect(compactAt(undefined, null)).toBe(100_000);
    expect(compactAt(undefined, 100_000)).toBe(150_000);
    expect(compactAt("120000", 100_000)).toBe(120_000);
    expect(compactAt(undefined)).toBe(100_000);
  });

  it("sends every request as before, asks for no summary and writes no summaries file", async () => {
    replies.push([call("t1", "set_param", { name: "width", expr: "900", unit: "mm" }), tokens(400_000)], [{ type: "text", text: "Set to 900." }, tokens(500_000)]);
    await say("Make it 900 wide");
    replies.push([{ type: "text", text: "Fir it is." }, tokens(600_000)]);
    await say("In fir");
    expect(client.summarised).toHaveLength(0);
    expect(summaries.busy).toBe(false);
    for (const body of client.sent as Body[]) {
      expect(body.context_management).toEqual({
        edits: [{ type: "compact_20260112", trigger: { type: "input_tokens", value: 100_000 }, instructions: SUMMARY_INSTRUCTIONS }],
      });
      expect(body.betas).toEqual(["server-side-fallback-2026-07-01", "thinking-binding-controls-2026-08-01", "compact-2026-01-12"]);
    }
    // The whole saved chat goes out, as it always has.
    const last = client.sent.at(-1)! as Body;
    expect(last.messages).toEqual(store.project.messages.slice(0, -1));
    expect(store.project.compactions).toEqual([]);
    expect(existsSync(path.join(store.project.dir, "compactions.json"))).toBe(false);
  });

  it("still sends a summary a chat got while it was on, and that chat keeps its fallback for a long turn", async () => {
    process.env.WOODCHUCK_COMPACT_IDLE_AT = "100000";
    summaryReplies.push([summary("Sam wants a fir bookshelf.", "sig-1")]);
    replies.push([{ type: "text", text: "Fir it is." }, tokens(120_000)]);
    await say("A fir bookshelf for Sam");
    await summaries.settled();
    expect(store.project.compactions).toHaveLength(1);

    delete process.env.WOODCHUCK_COMPACT_IDLE_AT;
    replies.push([{ type: "text", text: "Oak, then." }, tokens(90_000)]);
    await say("Actually oak");
    const next = client.sent.at(-1)! as Body;
    expect(firstBlock(next)).toEqual({ type: "compaction", content: "Sam wants a fir bookshelf.", signature: "sig-1" });
    expect(next.betas).toContain(ON_DEMAND_BETA);
    expect(next.context_management).toBeUndefined();
    expect(client.summarised).toHaveLength(1);

    // The API can't summarise that chat inside a request, so a turn past 100,000 gets one in the background.
    summaryReplies.push([summary("Sam wants an oak bookshelf.", "sig-2")]);
    replies.push([{ type: "text", text: "Oak shelves." }, tokens(110_000)]);
    await say("And the shelves?");
    await summaries.settled();
    expect(client.summarised).toHaveLength(2);
    expect(store.project.compactions).toHaveLength(2);
  });
});

describe("the restart gate", () => {
  it("says a summary is being written, and closing the app abandons it", async () => {
    const held = gate();
    summaryReplies.push([held.block, summary("Sam wants a fir bookshelf.", "sig-1")]);
    replies.push([{ type: "text", text: "Fir it is." }, tokens(120_000)]);
    const app = createApp({ dataDir: dir, client, watchTools: false, takePicture: async () => Buffer.from("png") });
    await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const busy = async () => (await (await fetch(`${base}/api/busy`)).json()) as { busy: boolean; reasons: string[] };
    try {
      await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "A fir bookshelf for Sam", selection: [] }) });
      for (let i = 0; i < 400 && (await busy()).reasons.some((r) => r !== "chat_summary"); i++) await new Promise((r) => setTimeout(r, 10));
      expect(await busy()).toEqual({ busy: true, reasons: ["chat_summary"] });

      held.open();
      await app.summaries.settled();
      expect(await busy()).toEqual({ busy: false, reasons: [] });
      expect(app.store.project.compactions).toHaveLength(1);

      // A second summary that's still being written when the app closes is abandoned.
      summaryReplies.push([gate().block, summary("Never lands.", "sig-2")]);
      replies.push([{ type: "text", text: "Oak, then." }, tokens(130_000)]);
      await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Actually oak", selection: [] }) });
      for (let i = 0; i < 400 && !(await busy()).reasons.includes("chat_summary"); i++) await new Promise((r) => setTimeout(r, 10));
      expect(app.summaries.busy).toBe(true);
    } finally {
      await app.close();
    }
    expect(app.summaries.busy).toBe(false);
    expect(app.store.project.compactions).toHaveLength(1);
  });
});
