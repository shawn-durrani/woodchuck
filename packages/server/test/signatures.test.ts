// A summary block's signature, from the stream to the saved chat and back.
// The real SDK client reads a fake API through a fake fetch, so no key and
// no network. The SDK keeps a summary block's signature only when the
// block's start event carries it, so Woodchuck takes it from whichever
// event does. A summary on request refuses a block without its signature,
// so a chat whose older summary has none is summarised whole, and a request
// the API refuses over a stored summary goes again with the chat in full.
// Follows issue #20.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultClient, ON_DEMAND_BETA, Turn, type MessagesClient } from "../src/agent.js";
import { scriptedClient, type ScriptBlock } from "../src/scripted.js";
import { Store } from "../src/store.js";
import { RETRY_AFTER_MS, RETRY_GROWTH, Summaries, WHOLE_CHAT_MAX_TOKENS } from "../src/summaries.js";

type Body = Anthropic.Beta.MessageCreateParamsStreaming & Record<string, unknown>;
type Event = Record<string, unknown>;

/** The error the API gave the live check for a summary without its signature. */
const NO_SIGNATURE = "messages.0.content.0: a `compaction` block with `content` requires its `signature`: send the block exactly as it was returned";

/** One reply as the API streams it: its blocks' events between the message's start and stop. */
function streamed(blocks: Event[][], stop = "end_turn", usage: Event = { input_tokens: 40, output_tokens: 0 }, last: Event = { output_tokens: 60 }): Event[] {
  return [
    { type: "message_start", message: { id: "msg_fake", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage } },
    ...blocks.flatMap((events, index) => [...events.map((e) => ({ ...e, index })), { type: "content_block_stop", index }]),
    { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: last },
    { type: "message_stop" },
  ];
}
const text = (words: string): Event[] => [
  { type: "content_block_start", content_block: { type: "text", text: "" } },
  { type: "content_block_delta", delta: { type: "text_delta", text: words } },
];
const thinking = (thought: string, signature: string): Event[] => [
  { type: "content_block_start", content_block: { type: "thinking", thinking: "", signature: "" } },
  { type: "content_block_delta", delta: { type: "thinking_delta", thinking: thought } },
  { type: "content_block_delta", delta: { type: "signature_delta", signature } },
];
type Carrier = "start" | "compaction_delta" | "signature_delta" | "none";
/** The API's own summary inside a request: a start, then one delta with the whole summary, with the signature where `carrier` says. */
const thresholdSummary = (content: string, carrier: Carrier, signature = "sig-threshold"): Event[] => [
  { type: "content_block_start", content_block: { type: "compaction", content: null, encrypted_content: null, ...(carrier === "start" ? { signature } : {}) } },
  { type: "content_block_delta", delta: { type: "compaction_delta", content, encrypted_content: null, ...(carrier === "compaction_delta" ? { signature } : {}) } },
  ...(carrier === "signature_delta" ? [{ type: "content_block_delta", delta: { type: "signature_delta", signature } }] : []),
];
/** A summary on request, which the docs say arrives whole in its start event. */
const onDemandReply = (content: string, signature: string) =>
  streamed([[{ type: "content_block_start", content_block: { type: "compaction", content, signature } }]], "compaction", { input_tokens: 0, output_tokens: 0 }, {
    output_tokens: 0,
    iterations: [{ type: "compaction", input_tokens: 2_000, cache_read_input_tokens: 118_000, output_tokens: 900 }],
  });
/** A plain request, for reading one reply straight off the client. */
const ASK: Anthropic.Beta.MessageCreateParamsStreaming = { model: "claude-sonnet-5-5", max_tokens: 100, messages: [{ role: "user", content: "A bookshelf for Sam" }], stream: true };
/** A reply's token counts, as the chat size the next request carries. */
const size = (n: number) => ({ input_tokens: 40, cache_read_input_tokens: n - 100, output_tokens: 0 });

/** A refusal, as the API sends one. */
interface Refusal {
  status: number;
  message: string;
}

/**
 * The SDK client on a fake API. Turns take their replies from one list and
 * requests for a summary from another, and every request is kept with its
 * betas, read from the header the SDK sends them in.
 */
function fakeApi(replies: (Event[] | Refusal)[], summaryReplies: (Event[] | Refusal)[] = []) {
  const sent: Body[] = [];
  const summarised: Body[] = [];
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Body;
    const betas = new Headers(init?.headers).get("anthropic-beta");
    const request = { ...body, betas: betas ? betas.split(",") : [] } as Body;
    const summary = body.compaction !== undefined;
    (summary ? summarised : sent).push(request);
    const reply = (summary ? summaryReplies : replies).shift() ?? { status: 500, message: "The fake API has no more replies." };
    if (!Array.isArray(reply)) {
      return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: reply.message } }), { status: reply.status, headers: { "content-type": "application/json" } });
    }
    const sse = reply.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join("");
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const client = defaultClient(new Anthropic({ apiKey: "test", maxRetries: 0, fetch }));
  return { client, sent, summarised };
}

const ENV = ["WOODCHUCK_COMPACT_AT", "WOODCHUCK_COMPACT_IDLE_AT", "WOODCHUCK_EFFORT_ROUTING"] as const;
let saved: Record<string, string | undefined>;
let dir: string;
let store: Store;
let summaries: Summaries;
let clock = 0;
let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  process.env.WOODCHUCK_EFFORT_ROUTING = "off";
  dir = mkdtempSync(path.join(tmpdir(), "woodchuck-signatures-"));
  store = new Store(dir);
  clock = 1_000;
  summaries = new Summaries(store, undefined, () => clock);
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  summaries.stop();
  log.mockRestore();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

const say = (client: MessagesClient, words: string) =>
  new Turn(store, client, { chat() {}, delta() {}, changed() {} }, () => Buffer.from("png"), undefined, [], undefined, summaries).run({ text: words, selection: [] });
const onDisk = (file: string) => JSON.parse(readFileSync(path.join(store.project.dir, file), "utf8")) as unknown;
const blocksOf = (m: Anthropic.Beta.BetaMessageParam | undefined) => (Array.isArray(m?.content) ? (m.content as unknown as ScriptBlock[]) : []);
const summaryBlocks = (messages: Anthropic.Beta.BetaMessageParam[]) => messages.flatMap(blocksOf).filter((b) => b.type === "compaction");
const logged = (pattern: RegExp) => log.mock.calls.filter((c) => pattern.test(String(c[0]))).length;

describe("a summary block's signature, read from the stream", () => {
  it.each(["start", "compaction_delta", "signature_delta"] as const)("is kept when the %s carries it, and nothing else in the reply changes", async (carrier) => {
    const api = fakeApi([streamed([thresholdSummary("Sam wants a fir bookshelf.", carrier), thinking("Fir it is.", "sig-thinking"), text("Fir, then.")])]);
    const message = await api.client.stream(ASK).finalMessage();
    expect(JSON.parse(JSON.stringify(message.content))).toEqual([
      { type: "compaction", content: "Sam wants a fir bookshelf.", encrypted_content: null, signature: "sig-threshold" },
      { type: "thinking", thinking: "Fir it is.", signature: "sig-thinking" },
      { type: "text", text: "Fir, then." },
    ]);
  });

  it("leaves a summary block the API sent unsigned as it came", async () => {
    const api = fakeApi([streamed([thresholdSummary("Sam wants a fir bookshelf.", "none"), text("Fir, then.")])]);
    const message = await api.client.stream(ASK).finalMessage();
    expect(JSON.parse(JSON.stringify(message.content[0]))).toEqual({ type: "compaction", content: "Sam wants a fir bookshelf.", encrypted_content: null });
  });

  it("goes into the saved chat with the API's own summary, and back as stored, with the setting off and every request as before", async () => {
    const api = fakeApi([streamed([thresholdSummary("Sam wants a fir bookshelf.", "compaction_delta"), text("Fir, then.")]), streamed([text("Oak, then.")])]);
    await say(api.client, "A fir bookshelf for Sam");
    const stored = { type: "compaction", content: "Sam wants a fir bookshelf.", encrypted_content: null, signature: "sig-threshold" };
    expect(blocksOf(store.project.messages[1])[0]).toEqual(stored);
    expect((onDisk("messages.json") as Anthropic.Beta.BetaMessageParam[])[1]).toEqual(store.project.messages[1]);

    await say(api.client, "Actually oak");
    const next = api.sent[1]!;
    expect(next.messages[0]).toEqual(store.project.messages[1]);
    expect(blocksOf(next.messages[0])[0]).toEqual(stored);
    expect(next.betas).toEqual(["server-side-fallback-2026-07-01", "thinking-binding-controls-2026-08-01", "compact-2026-01-12"]);
    expect(next.context_management).toBeDefined();
    expect(store.project.refused).toBeNull();
  });

  it("goes into the saved summary from between turns, and back word for word", async () => {
    process.env.WOODCHUCK_COMPACT_IDLE_AT = "100000";
    const api = fakeApi(
      [streamed([text("Fir it is.")], "end_turn", size(120_000)), streamed([text("Oak, then.")])],
      [onDemandReply("Sam wants a fir bookshelf.", "sig-on-request")],
    );
    await say(api.client, "A fir bookshelf for Sam");
    await summaries.settled();
    const block = { type: "compaction", content: "Sam wants a fir bookshelf.", signature: "sig-on-request" };
    expect(api.summarised[0]!.betas).toContain(ON_DEMAND_BETA);
    expect(store.project.compactions.map((c) => c.block)).toEqual([block]);
    expect((onDisk("compactions.json") as { block: unknown }[])[0]!.block).toEqual(block);

    await say(api.client, "Actually oak");
    const next = api.sent[1]!;
    expect(next.messages[0]).toEqual({ role: "assistant", content: [block] });
    expect(next.betas).toContain(ON_DEMAND_BETA);
    expect(next.context_management).toBeUndefined();
  });
});

describe("a chat whose older summary has no signature", () => {
  let replies: ScriptBlock[][];
  let summaryReplies: ScriptBlock[][];
  let client: ReturnType<typeof scriptedClient>;
  const tokens = (n: number): ScriptBlock => ({ type: "usage", input_tokens: 40, cache_read_input_tokens: n - 100, output_tokens: 60 });
  const unsignedSummary: ScriptBlock = { type: "compaction", content: "Sam wants a fir bookshelf.", encrypted_content: null };

  beforeEach(() => {
    process.env.WOODCHUCK_COMPACT_IDLE_AT = "100000";
    replies = [];
    summaryReplies = [];
    client = scriptedClient(replies, summaryReplies);
  });

  /** A chat where the API summarised inside a request, then a turn ends past the threshold on top of that summary. */
  async function pastAnUnsignedSummary(first = "A fir bookshelf for Sam", c: MessagesClient = client) {
    replies.push([{ type: "text", text: "Fir it is." }, tokens(60_000)]);
    await say(c, first);
    replies.push([unsignedSummary, { type: "text", text: "Noted." }, tokens(10_000)]);
    await say(c, "Remember the fir");
    replies.push([{ type: "text", text: "Oak shelves." }, tokens(120_000)]);
    await say(c, "Oak shelves, though");
  }

  it("is summarised from the whole saved chat, with the old summary taken out", async () => {
    summaryReplies.push([{ type: "compaction", content: "Sam wants a fir bookshelf with oak shelves.", signature: "sig-1" }]);
    await pastAnUnsignedSummary();
    await summaries.settled();
    const turnRequest = client.sent.at(-1)! as Body;
    // The turn itself still went out from the API's own summary, under its own beta.
    expect(blocksOf(turnRequest.messages[0])[0]).toEqual(unsignedSummary);
    expect(turnRequest.betas).toContain("compact-2026-01-12");

    const asked = client.summarised[0]! as Body;
    const whole = store.project.messages.slice(0, -1);
    expect(summaryBlocks(asked.messages)).toEqual([]);
    expect(asked.messages).toHaveLength(whole.length);
    expect(asked.messages[0]).toEqual(whole[0]);
    // The reply that carried the old summary keeps everything else it said.
    expect(asked.messages[3]).toEqual({ role: "assistant", content: [{ type: "text", text: "Noted." }] });
    expect(asked.messages.at(-1)).toEqual(turnRequest.messages.at(-1));
    expect(asked.betas).toContain(ON_DEMAND_BETA);
    expect(asked.betas).not.toContain("compact-2026-01-12");
    expect(logged(/no signature, so the summary request sends the whole chat/)).toBe(1);

    // The new summary stands in for the whole chat it covered.
    expect(store.project.compactions.map((c) => c.upto)).toEqual([whole.length]);
    replies.push([{ type: "text", text: "Two oak shelves." }]);
    await say(client, "Two shelves");
    const next = client.sent.at(-1)! as Body;
    expect(summaryBlocks(next.messages)).toEqual([{ type: "compaction", content: "Sam wants a fir bookshelf with oak shelves.", signature: "sig-1" }]);
    expect(next.messages[1]).toEqual(store.project.messages[whole.length]);
  });

  it("keeps the API's own summaries when the whole chat is too long for one request, and says so once", async () => {
    await pastAnUnsignedSummary(`A fir bookshelf for Sam. ${"Long notes. ".repeat(Math.ceil((WHOLE_CHAT_MAX_TOKENS * 3) / 12))}`);
    replies.push([{ type: "text", text: "Two oak shelves." }, tokens(140_000)]);
    await say(client, "Two shelves");
    expect(client.summarised).toHaveLength(0);
    expect(logged(/too long to summarise instead/)).toBe(1);
    const last = client.sent.at(-1)! as Body;
    expect(blocksOf(last.messages[0])[0]).toEqual(unsignedSummary);
    expect(last.context_management).toBeDefined();
  });

  it("stops trying for that chat once the API finds the whole chat too long", async () => {
    const asked: Body[] = [];
    const refusing: MessagesClient = {
      stream(body) {
        if ((body as Body).compaction === undefined) return client.stream(body);
        asked.push(body as Body);
        return {
          on() {
            return this;
          },
          finalMessage: async () => {
            throw Anthropic.APIError.generate(400, { type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 1200000 tokens > 1000000 maximum" } }, undefined, new Headers());
          },
          abort() {},
        };
      },
    };
    await pastAnUnsignedSummary(undefined, refusing);
    await summaries.settled();
    expect(asked).toHaveLength(1);
    expect(logged(/too long to summarise in one request/)).toBe(1);

    // Grown and an hour on, which would earn a failed summary a new try.
    clock += RETRY_AFTER_MS;
    replies.push([{ type: "text", text: "Two oak shelves." }, tokens(120_000 + RETRY_GROWTH)]);
    await say(refusing, "Two shelves");
    await summaries.settled();
    expect(asked).toHaveLength(1);
  });

  it("drops a summary on request that comes back without its signature", async () => {
    summaryReplies.push([{ type: "compaction", content: "Sam wants a fir bookshelf." }]);
    replies.push([{ type: "text", text: "Fir it is." }, tokens(120_000)]);
    await say(client, "A fir bookshelf for Sam");
    await summaries.settled();
    expect(client.summarised).toHaveLength(1);
    expect(store.project.compactions).toEqual([]);
    expect(logged(/came back without its signature/)).toBe(1);
  });
});

describe("a request the API refuses over a stored summary", () => {
  it("goes again once with the chat in full, and so does every later request", async () => {
    process.env.WOODCHUCK_COMPACT_IDLE_AT = "100000";
    const api = fakeApi(
      [streamed([text("Fir it is.")], "end_turn", size(120_000)), { status: 400, message: NO_SIGNATURE }, streamed([text("Oak, then.")]), streamed([text("Two oak shelves.")])],
      [onDemandReply("Sam wants a fir bookshelf.", "sig-on-request")],
    );
    await say(api.client, "A fir bookshelf for Sam");
    await summaries.settled();
    expect(store.project.compactions).toHaveLength(1);

    await say(api.client, "Actually oak");
    const [refused, retried] = api.sent.slice(1) as [Body, Body];
    expect(summaryBlocks(refused.messages)).toHaveLength(1);
    // The same request again, with the chat in full and the API's own summary at a threshold back on.
    expect(summaryBlocks(retried.messages)).toEqual([]);
    expect(retried.messages).toEqual(store.project.messages.slice(0, 3));
    expect(retried.betas).not.toContain(ON_DEMAND_BETA);
    expect(retried.betas).toContain("compact-2026-01-12");
    expect(retried.context_management).toBeDefined();
    expect(store.project.chat.filter((c) => c.kind === "error")).toEqual([]);
    expect(store.project.messages.at(-1)).toEqual({ role: "assistant", content: [{ type: "text", text: "Oak, then." }] });
    expect(store.project.refused).toEqual({ messages: 3, compactions: 1, at: expect.any(String) });
    expect(onDisk("refused.json")).toEqual(store.project.refused);
    expect(logged(/refused this chat's stored summary, so the chat goes out in full from now on \(messages\.0\.content\.0: a `compaction` block/)).toBe(1);

    // The next turn sends the chat in full straight away, with no refusal and no new line in the log.
    await say(api.client, "Two shelves");
    expect(api.sent).toHaveLength(4);
    expect(summaryBlocks(api.sent[3]!.messages)).toEqual([]);
    expect(api.sent[3]!.messages).toEqual(store.project.messages.slice(0, 5));
    expect(logged(/refused this chat's stored summary/)).toBe(1);
  });

  it("takes out the API's own summary it refused, and sends from a newer one", async () => {
    const api = fakeApi([
      streamed([thresholdSummary("Sam wants a fir bookshelf.", "none"), text("Fir, then.")]),
      { status: 400, message: "messages.0.content.0: compaction_signature_invalid" },
      streamed([thresholdSummary("Sam wants an oak bookshelf.", "none"), text("Oak, then.")]),
      streamed([text("Two oak shelves.")]),
    ]);
    await say(api.client, "A fir bookshelf for Sam");
    await say(api.client, "Actually oak");
    const retried = api.sent[2]!;
    expect(summaryBlocks(retried.messages)).toEqual([]);
    expect(retried.messages[1]).toEqual({ role: "assistant", content: [{ type: "text", text: "Fir, then." }] });
    expect(store.project.refused).toMatchObject({ messages: 3, compactions: 0 });

    // A summary the API wrote after the refusal is sent from as usual.
    await say(api.client, "Two shelves");
    const next = api.sent[3]!;
    expect(next.messages[0]).toEqual(store.project.messages[3]);
    expect(summaryBlocks(next.messages)).toEqual([{ type: "compaction", content: "Sam wants an oak bookshelf.", encrypted_content: null }]);
  });

  it("fails the turn as before when the refusal names no summary, or the request carried none", async () => {
    const api = fakeApi([
      { status: 400, message: "max_tokens: 64000 > 32000, which is the maximum" },
      { status: 400, message: "messages.0: compaction parameter requires anthropic-beta: compact-2026-09-04" },
    ]);
    await say(api.client, "A fir bookshelf for Sam");
    await say(api.client, "Hello again");
    expect(api.sent).toHaveLength(2);
    expect(store.project.chat.filter((c) => c.kind === "error")).toHaveLength(2);
    expect(store.project.refused).toBeNull();
    expect(existsSync(path.join(store.project.dir, "refused.json"))).toBe(false);
  });
});
