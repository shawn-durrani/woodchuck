// How big a whole chat is, before it's summarised whole. A chat whose older
// summary has no signature is summarised from the whole saved chat, and
// that has to fit the model. The API's free token count measures it, with
// the same model, instructions, tools, thinking and betas as the summary
// request. A rough count stands in when the count fails, and it never reads
// signatures or pictures as words. A fake count and a scripted Claude, so
// no key and no network. Follows issue #20.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultClient, ON_DEMAND_BETA, summaryBase, Turn, type Asked, type MessagesClient } from "../src/agent.js";
import { scriptedClient, type ScriptBlock } from "../src/scripted.js";
import { Store } from "../src/store.js";
import { countRequest, RETRY_AFTER_MS, roughCount, summaryRequest, Summaries, SUMMARY_MAX_TOKENS, wholeChatLimit } from "../src/summaries.js";
import { TOOLS } from "../src/tools.js";

type Body = Anthropic.Beta.MessageCreateParamsStreaming & Record<string, unknown>;
type CountParams = Anthropic.Beta.Messages.MessageCountTokensParams;

/** Base64 the length of a large photo, which a count of words would read as a million tokens. */
const ENCODED = "QUJD".repeat(750_000);

describe("the rough count", () => {
  it("counts a picture as 5,000 tokens wherever it sits, such as inside a tool's result", () => {
    const picture = { type: "image", source: { type: "base64", media_type: "image/png", data: ENCODED } };
    const result = { type: "tool_result", tool_use_id: "t1", content: [picture, { type: "text", text: "Views: front." }] };
    const without = { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "Views: front." }] };
    expect(roughCount(picture)).toBe(5_000);
    expect(roughCount([{ role: "user", content: [result] }])).toBe(5_000 + roughCount([{ role: "user", content: [without] }]));
  });

  it("counts a document as 30,000 tokens, in a message or in a page the web fetch read", () => {
    const pdf = { type: "document", source: { type: "base64", media_type: "application/pdf", data: ENCODED } };
    const fetched = { type: "web_fetch_tool_result", tool_use_id: "w1", content: { type: "web_fetch_result", url: "https://example.com/slides", content: pdf } };
    expect(roughCount(pdf)).toBe(30_000);
    expect(roughCount(fetched)).toBe(30_000 + roughCount({ type: "web_fetch_tool_result", tool_use_id: "w1", content: { type: "web_fetch_result", url: "https://example.com/slides" } }));
  });

  it("never reads a signature, encrypted thinking or other encoded data as words", () => {
    const thinking = { type: "thinking", thinking: "Fir suits Sam's bookshelf.", signature: ENCODED };
    expect(roughCount(thinking)).toBe(roughCount({ type: "thinking", thinking: "Fir suits Sam's bookshelf." }));
    const summary = { type: "compaction", content: "Sam wants a fir bookshelf.", encrypted_content: ENCODED };
    expect(roughCount(summary)).toBe(roughCount({ type: "compaction", content: "Sam wants a fir bookshelf." }));
    expect(roughCount({ type: "redacted_thinking", data: ENCODED })).toBe(0);
    // A chat of a few hundred words comes out at a few hundred tokens, whatever it carries.
    const chat = [
      { role: "user", content: "A fir bookshelf for Sam, 900 wide." },
      { role: "assistant", content: [thinking, { type: "redacted_thinking", data: ENCODED }, { type: "tool_use", id: "t1", name: "render_views", input: { views: ["front"] } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: ENCODED } }] }] },
    ];
    expect(roughCount(chat)).toBeLessThan(5_200);
  });
});

describe("the token count request", () => {
  it("carries the summary request's model, instructions, tools, thinking and betas, without web tools or max_tokens", async () => {
    const body = {
      model: "claude-sonnet-5-5",
      max_tokens: 64_000,
      system: [{ type: "text", text: "You help design furniture." }],
      tools: [...TOOLS.slice(0, 2), { type: "web_search_20260209", name: "web_search" }, { type: "web_fetch_20260209", name: "web_fetch" }],
      messages: [{ role: "user", content: "A fir bookshelf for Sam" }],
      thinking: { type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } },
      output_config: { effort: "high" },
      cache_control: { type: "ephemeral" },
      betas: ["server-side-fallback-2026-07-01", "thinking-binding-controls-2026-08-01", "compact-2026-01-12"],
    } as unknown as Anthropic.Beta.MessageCreateParamsStreaming;
    const request = summaryRequest(body);
    const count = countRequest(request) as CountParams & Record<string, unknown>;
    expect(count.model).toBe(request.model);
    expect(count.system).toEqual(request.system);
    expect(count.tools).toEqual(TOOLS.slice(0, 2));
    expect(count.messages).toEqual(request.messages);
    expect(count.thinking).toEqual(request.thinking);
    expect(count.output_config).toEqual({ effort: "high" });
    expect(count.betas).toEqual(request.betas);
    expect(count.betas).toContain(ON_DEMAND_BETA);
    // The count takes the summary setting and ignores it.
    expect(count.compaction).toEqual(request.compaction);
    expect(count.max_tokens).toBeUndefined();

    // The real client sends it to the count endpoint, with the betas in their header.
    let url = "";
    let beta = "";
    let sent: Record<string, unknown> = {};
    const fetch = async (u: string | URL | Request, init?: RequestInit) => {
      url = String(u);
      beta = new Headers(init?.headers).get("anthropic-beta") ?? "";
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ input_tokens: 4_321, context_management: null }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const client = defaultClient(new Anthropic({ apiKey: "test", maxRetries: 0, fetch }));
    expect(await client.countTokens!(count)).toMatchObject({ input_tokens: 4_321 });
    expect(url).toMatch(/\/v1\/messages\/count_tokens\?beta=true$/);
    // The SDK adds the count's own beta to the request's.
    expect(beta.split(",")).toEqual([...request.betas!, "token-counting-2024-11-01"]);
    expect(sent.betas).toBeUndefined();
    expect(sent.max_tokens).toBeUndefined();
  });

  it("leaves the model's whole context, less the summary and a margin", () => {
    expect(wholeChatLimit("claude-sonnet-5-5")).toBe(1_000_000 - SUMMARY_MAX_TOKENS - 20_000);
    expect(wholeChatLimit("claude-fable-5-1")).toBe(wholeChatLimit("claude-opus-5-5"));
    expect(wholeChatLimit("claude-haiku-9")).toBe(200_000 - SUMMARY_MAX_TOKENS - 20_000);
  });
});

describe("a whole chat measured for a summary", () => {
  const ENV = ["WOODCHUCK_COMPACT_AT", "WOODCHUCK_COMPACT_IDLE_AT", "WOODCHUCK_EFFORT_ROUTING"] as const;
  let saved: Record<string, string | undefined>;
  let dir: string;
  let store: Store;
  let summaries: Summaries;
  let clock = 0;
  let log: ReturnType<typeof vi.spyOn>;
  let errors: ReturnType<typeof vi.spyOn>;
  let replies: ScriptBlock[][];
  let summaryReplies: ScriptBlock[][];
  let scripted: ReturnType<typeof scriptedClient>;
  let counted: CountParams[];
  /** What the fake count says, or the error it throws. */
  let count: number | Error;
  let client: MessagesClient;

  beforeEach(() => {
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    for (const k of ENV) delete process.env[k];
    process.env.WOODCHUCK_EFFORT_ROUTING = "off";
    process.env.WOODCHUCK_COMPACT_IDLE_AT = "100000";
    dir = mkdtempSync(path.join(tmpdir(), "woodchuck-summary-size-"));
    store = new Store(dir);
    clock = 1_000;
    summaries = new Summaries(store, undefined, () => clock);
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
    replies = [];
    summaryReplies = [];
    scripted = scriptedClient(replies, summaryReplies);
    counted = [];
    count = 48_000;
    client = {
      stream: (body) => scripted.stream(body),
      countTokens: async (params) => {
        counted.push(structuredClone(params));
        if (count instanceof Error) throw count;
        return { input_tokens: count };
      },
    };
  });
  afterEach(() => {
    summaries.stop();
    log.mockRestore();
    errors.mockRestore();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const tokens = (n: number): ScriptBlock => ({ type: "usage", input_tokens: 40, cache_read_input_tokens: n - 100, output_tokens: 60 });
  const say = (words: string) => new Turn(store, client, { chat() {}, delta() {}, changed() {} }, () => Buffer.from("png"), undefined, [], undefined, summaries).run({ text: words, selection: [] });
  const logged = (pattern: RegExp) => log.mock.calls.filter((c) => pattern.test(String(c[0]))).length;

  /** A chat the API summarised inside a request without a signature, then a turn that ends past the threshold on top of it. */
  async function pastAnUnsignedSummary() {
    replies.push([{ type: "text", text: "Fir it is." }, tokens(60_000)]);
    await say("A fir bookshelf for Sam");
    replies.push([{ type: "compaction", content: "Sam wants a fir bookshelf.", encrypted_content: null }, { type: "text", text: "Noted." }, tokens(10_000)]);
    await say("Remember the fir");
    replies.push([{ type: "text", text: "Oak shelves." }, tokens(120_000)]);
    await say("Oak shelves, though");
    await summaries.settled();
  }

  it("uses the API's token count, with what the summary request carries, and says what it found", async () => {
    summaryReplies.push([{ type: "compaction", content: "Sam wants a fir bookshelf with oak shelves.", signature: "sig-1" }]);
    await pastAnUnsignedSummary();
    expect(counted).toHaveLength(1);
    const asked = scripted.summarised[0]! as Body;
    expect(counted[0]!.messages).toEqual(asked.messages);
    expect(counted[0]!.model).toBe(asked.model);
    expect(counted[0]!.system).toEqual(asked.system);
    expect(counted[0]!.thinking).toEqual(asked.thinking);
    expect(counted[0]!.betas).toEqual(asked.betas);
    // The web tools are left out, since the count refuses them.
    expect(counted[0]!.tools).toEqual(TOOLS);
    expect(summaries.measured.get(store.project.slug)).toEqual({ upto: 5, tokens: 48_000, by: "the token count" });
    expect(logged(/sends the whole chat instead \(48,000 tokens by the token count\)/)).toBe(1);
    expect(store.project.compactions).toHaveLength(1);
  });

  it("keeps the API's own summaries when the count is over the model's limit, and counts that chat no more", async () => {
    count = wholeChatLimit("claude-sonnet-5-5") + 1;
    await pastAnUnsignedSummary();
    expect(scripted.summarised).toHaveLength(0);
    expect(logged(/too long to summarise instead \(964,001 tokens by the token count, over 964,000\)/)).toBe(1);

    replies.push([{ type: "text", text: "Two oak shelves." }, tokens(140_000)]);
    await say("Two shelves");
    await summaries.settled();
    expect(counted).toHaveLength(1);
    expect(scripted.summarised).toHaveLength(0);
  });

  it("counts a chat once for its length, and again once it's grown", async () => {
    // The first summary comes back empty, so the next try waits an hour.
    summaryReplies.push([{ type: "text", text: "No summary." }]);
    await pastAnUnsignedSummary();
    expect(counted).toHaveLength(1);
    expect(scripted.summarised).toHaveLength(1);

    // The same request again, an hour on, isn't counted again.
    const project = store.project;
    const asked: Asked = { project, body: scripted.sent.at(-1)!, upto: 5, base: summaryBase(project.messages, project.compactions, project.refused), size: 120_000 };
    clock += RETRY_AFTER_MS;
    summaryReplies.push([{ type: "text", text: "Still no summary." }]);
    expect(summaries.start(client, asked, 100_000)).toBe(true);
    await summaries.settled();
    expect(scripted.summarised).toHaveLength(2);
    expect(counted).toHaveLength(1);

    // Grown, and another hour on, it's counted afresh.
    clock += RETRY_AFTER_MS;
    replies.push([{ type: "text", text: "Two oak shelves." }, tokens(121_000)]);
    await say("Two shelves");
    await summaries.settled();
    expect(counted).toHaveLength(2);
    expect(summaries.measured.get(project.slug)?.upto).toBe(7);
  });

  it("falls back to the rough count when the token count fails", async () => {
    count = new Error("Overloaded");
    summaryReplies.push([{ type: "compaction", content: "Sam wants a fir bookshelf with oak shelves.", signature: "sig-1" }]);
    await pastAnUnsignedSummary();
    expect(errors.mock.calls.some((c) => /Couldn't count the chat's tokens: Overloaded\. A rough count stands in\./.test(String(c[0])))).toBe(true);
    const measured = summaries.measured.get(store.project.slug)!;
    expect(measured.by).toBe("a rough count");
    expect(measured.tokens).toBeLessThan(wholeChatLimit("claude-sonnet-5-5"));
    expect(logged(/sends the whole chat instead \([\d,]+ tokens by a rough count\)/)).toBe(1);
    expect(store.project.compactions).toHaveLength(1);
  });

  it("measures nothing for a chat whose summaries are signed", async () => {
    summaryReplies.push([{ type: "compaction", content: "Sam wants a fir bookshelf.", signature: "sig-1" }]);
    replies.push([{ type: "text", text: "Fir it is." }, tokens(120_000)]);
    await say("A fir bookshelf for Sam");
    await summaries.settled();
    expect(scripted.summarised).toHaveLength(1);
    expect(counted).toHaveLength(0);
    expect(summaries.measured.size).toBe(0);
  });
});
