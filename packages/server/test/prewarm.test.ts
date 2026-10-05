// Issue #38: the prompt cache is warmed in the background before the
// woodworker's next message, once it has gone cold. A warm-up is a copy of
// the next request with max_tokens 0, and it matches that request in
// everything the cache reads. It fires only after a gap longer than the
// cache lasts, at most once a cache lifetime, never for an empty chat or
// while Claude works, and a turn that starts stops it. A scripted Claude
// with a fake create() plays every request, so nothing here needs a key.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { defaultClient, EFFORT_MESSAGE_BETA, ON_DEMAND_BETA, Turn, WARM_PLACEHOLDER, warmRequest, type TurnInput } from "../src/agent.js";
import { createApp } from "../src/index.js";
import { scriptedClient, type ScriptBlock } from "../src/scripted.js";
import { Store, type Warmup } from "../src/store.js";
import { readWarmups, report } from "../src/turnstats.js";
import { cachePrewarm, chatSize, ttlMs, Warmer } from "../src/warm.js";

type Sent = Anthropic.Beta.MessageCreateParamsStreaming;
type Warm = Anthropic.Beta.MessageCreateParamsNonStreaming;
type Block = Record<string, unknown>;

const HOUR = 60 * 60_000;
const call = (id: string, name: string, input: Block): ScriptBlock => ({ type: "tool_use", id, name, input });
const text = (t: string): ScriptBlock[] => [{ type: "text", text: t }];
const ask = (t: string): TurnInput => ({ text: t, selection: [] });
const finish = (id: string) => call(id, "set_finish", { targets: ["top"], finish: "amsterdam" });

/**
 * A scripted Claude that also answers warm-ups. Each warm-up is kept with
 * the signal it was sent with. Set `hold` to keep the next ones waiting
 * until they're stopped, or `fail` to have them fail.
 */
function warmClient(replies: ScriptBlock[][] = []) {
  const scripted = scriptedClient(replies);
  const warmed: { body: Warm; signal: AbortSignal | undefined }[] = [];
  const mode = { hold: false, fail: false, usage: { input_tokens: 9, cache_creation_input_tokens: 41_000, cache_read_input_tokens: 0 } };
  const create = (body: Warm, options?: { signal?: AbortSignal }): Promise<Anthropic.Beta.BetaMessage> => {
    warmed.push({ body: structuredClone(body), signal: options?.signal });
    if (mode.fail) return Promise.reject(new Error("Overloaded"));
    if (mode.hold) return new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("Request was aborted."))));
    return Promise.resolve({
      id: "msg_warm",
      type: "message",
      role: "assistant",
      model: body.model,
      content: [],
      stop_reason: "max_tokens",
      stop_sequence: null,
      usage: { output_tokens: 0, ...mode.usage },
    } as unknown as Anthropic.Beta.BetaMessage);
  };
  return Object.assign(scripted, { create, warmed, mode });
}

let dir: string;
let store: Store;
const saved: Record<string, string | undefined> = {};
const ENV = ["WOODCHUCK_CACHE_PREWARM", "WOODCHUCK_CACHE_TTL", "WOODCHUCK_EFFORT_ROUTING", "WOODCHUCK_COMPACT_AT", "WOODCHUCK_COMPACT_IDLE_AT"];
beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  dir = mkdtempSync(path.join(tmpdir(), "woodchuck-prewarm-"));
  store = new Store(dir);
  oakTop(store);
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

/** An invented top for a console Alex is making: one 30 mm oak board, 1200 by 400 mm. */
function oakTop(s: Store) {
  s.project.apply([
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
  s.project.save();
}

function turn(client: ReturnType<typeof warmClient>) {
  return new Turn(store, client, { chat() {}, delta() {}, changed() {} }, () => Buffer.from("png"));
}

/** A warmer on the test's store, with a clock the test moves. */
function warmer(client: ReturnType<typeof warmClient> | null, busy = () => false) {
  const clock = { now: 1_000_000 };
  const w = new Warmer(store, { busy, client: () => client, clock: () => clock.now, delayMs: 0 });
  return { w, clock };
}

/** A chat of two turns: a question about the top, then a colour try, which Claude runs at low. */
async function twoTurns(client: ReturnType<typeof warmClient>) {
  await turn(client).run(ask("Should the top overhang the legs?"));
  await turn(client).run(ask("Try Amsterdam on the top"));
}

/** A value with every cache breakpoint taken out, since a breakpoint isn't part of what the cache matches. */
const unmarked = (v: unknown): unknown => JSON.parse(JSON.stringify(v), (k, x: unknown) => (k === "cache_control" ? undefined : x));
/** Every field of a request but its size, its messages and its top-level breakpoint, as bytes. */
function settingsOf(body: Sent | Warm): string {
  const { max_tokens: _size, messages: _messages, cache_control: _marker, ...rest } = body as Sent;
  return JSON.stringify(rest);
}

/**
 * The warm-up matches the next turn's first request byte for byte, in
 * everything but its size, its top-level breakpoint and what follows the
 * chat it shares. Returns the two for more checks.
 */
async function expectSamePrefix(client: ReturnType<typeof warmClient>, next: TurnInput) {
  const { w } = warmer(client);
  expect(w.start("open")).toBe("started");
  await w.settled();
  expect(client.warmed).toHaveLength(1);
  const warm = client.warmed[0]!.body;
  const before = client.sent.length;
  await turn(client).run(next);
  const real = client.sent[before]!;
  // The shared chat is everything the warm-up carries before its placeholder.
  const ends = warm.messages.at(-1)!;
  const count = ends.role === "user" && JSON.stringify(ends).includes(WARM_PLACEHOLDER) ? warm.messages.length - 1 : warm.messages.length;
  expect(count).toBeGreaterThan(0);
  expect(settingsOf(warm)).toBe(settingsOf(real));
  expect(JSON.stringify(unmarked(warm.messages.slice(0, count)))).toBe(JSON.stringify(unmarked(real.messages.slice(0, count))));
  expect(JSON.stringify(unmarked(warm.system))).toBe(JSON.stringify(unmarked(real.system)));
  expect(JSON.stringify(warm.system)).toBe(JSON.stringify(real.system));
  // The breakpoint the turn puts on its last block sits on the last block the two share, with the same lifetime.
  const marked = JSON.stringify(warm.messages).match(/"cache_control"/g) ?? [];
  expect(marked).toHaveLength(1);
  const lastShared = warm.messages[count - 1]!.content as unknown as Block[];
  expect(lastShared.at(-1)!.cache_control).toEqual(real.cache_control);
  return { warm, real, count };
}

describe("the warm-up request", () => {
  it("is the next request with max_tokens 0, not streamed, and its breakpoint on the chat's last block", async () => {
    const client = warmClient([text("Yes, about 20 mm.")]);
    await turn(client).run(ask("Should the top overhang the legs?"));
    const body = client.sent[0]!;
    const out = warmRequest(body)!;
    const warm = out.body as unknown as Block;
    expect(warm.max_tokens).toBe(0);
    expect(warm).not.toHaveProperty("stream");
    expect(warm).not.toHaveProperty("cache_control");
    expect(out.shared).toBe(body.messages.length);
    // Every field keeps its place, so only the size and the messages differ.
    expect(Object.keys(warm)).toEqual(Object.keys(body).filter((k) => k !== "cache_control"));
    const last = (warm.messages as Anthropic.Beta.BetaMessageParam[]).at(-1)!;
    expect((last.content as unknown as Block[]).at(-1)).toEqual({ type: "text", text: expect.any(String), cache_control: { type: "ephemeral", ttl: "1h" } });
    // The request it came from is untouched.
    expect(JSON.stringify(body.messages)).not.toContain("cache_control");
  });

  it("puts a placeholder after Claude's reply, with a result for each tool call it's waiting on", () => {
    const body = {
      model: "claude-sonnet-5-5",
      max_tokens: 64000,
      messages: [
        { role: "user", content: [{ type: "text", text: "Make a shelf for Sam" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Width first.", signature: "s" },
            { type: "tool_use", id: "q1", name: "ask_user", input: { question: "How wide?", options: [] } },
          ],
        },
      ],
      cache_control: { type: "ephemeral", ttl: "1h" },
    } as unknown as Sent;
    const warm = warmRequest(body)!.body;
    expect(warm.messages).toHaveLength(3);
    expect((warm.messages[1]!.content as unknown as Block[]).map((b) => b.cache_control ?? null)).toEqual([null, { type: "ephemeral", ttl: "1h" }]);
    expect(warm.messages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "q1", content: WARM_PLACEHOLDER },
        { type: "text", text: WARM_PLACEHOLDER },
      ],
    });
  });

  it("sends a chat that ends on the woodworker's side as it is, and skips thinking for the breakpoint", () => {
    const body = {
      model: "claude-sonnet-5-5",
      max_tokens: 64000,
      messages: [
        { role: "user", content: [{ type: "text", text: "Make a shelf" }] },
        { role: "assistant", content: [{ type: "thinking", thinking: "Hmm.", signature: "s" }] },
        { role: "user", content: [{ type: "text", text: "Stopped." }] },
      ],
      cache_control: { type: "ephemeral" },
    } as unknown as Sent;
    const warm = warmRequest(body)!.body;
    expect(warm.messages).toHaveLength(3);
    expect(warm.messages[2]).toEqual({ role: "user", content: [{ type: "text", text: "Stopped.", cache_control: { type: "ephemeral" } }] });
    const thinkingOnly = { ...body, messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "Hmm.", signature: "s" }] }] } as unknown as Sent;
    expect(warmRequest(thinkingOnly)).toBeNull();
  });
});

describe("the real client", () => {
  it("sends the warm-up whole, with max_tokens 0 and its betas in the header, and can stop it", async () => {
    const client = warmClient([text("Yes, about 20 mm.")]);
    await turn(client).run(ask("Should the top overhang the legs?"));
    const warm = warmRequest(client.sent[0]!)!.body;
    const seen: { url: string; body: Record<string, unknown>; betas: string | null }[] = [];
    let hold = false;
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown>, betas: new Headers(init?.headers).get("anthropic-beta") });
      if (hold) {
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError"))));
      }
      // The answer the prompt caching docs show for a warm-up.
      const answer = { id: "msg_w", type: "message", role: "assistant", content: [], model: "claude-sonnet-5-5", stop_reason: "max_tokens", stop_sequence: null, usage: { input_tokens: 8, cache_creation_input_tokens: 5120, cache_read_input_tokens: 0, output_tokens: 0 } };
      return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
    };
    const real = defaultClient(new Anthropic({ apiKey: "test", maxRetries: 0, fetch }));
    const message = await real.create!(warm);
    expect(message).toMatchObject({ content: [], stop_reason: "max_tokens", usage: { cache_creation_input_tokens: 5120, output_tokens: 0 } });
    const sent = seen[0]!;
    expect(sent.url).toMatch(/\/v1\/messages\?beta=true$/);
    expect(sent.body.max_tokens).toBe(0);
    expect(sent.body.stream ?? false).toBe(false);
    expect(sent.body).not.toHaveProperty("betas");
    expect(sent.body).not.toHaveProperty("cache_control");
    expect(sent.betas?.split(",")).toEqual((client.sent[0] as { betas?: string[] }).betas);
    expect(sent.body.thinking).toEqual({ type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } });
    hold = true;
    const stop = new AbortController();
    const going = real.create!(warm, { signal: stop.signal });
    await new Promise((r) => setTimeout(r, 10));
    stop.abort();
    await expect(going).rejects.toBeInstanceOf(Anthropic.APIUserAbortError);
  });
});

describe("the warm-up matches the next turn", () => {
  it("byte for byte in a plain chat, with the summary trigger the turn sends", async () => {
    process.env.WOODCHUCK_EFFORT_ROUTING = "off";
    const client = warmClient([text("Yes, about 20 mm."), text("Done.")]);
    await turn(client).run(ask("Should the top overhang the legs?"));
    const { warm, real } = await expectSamePrefix(client, ask("Make the overhang 25 mm"));
    expect(warm).toHaveProperty("context_management");
    expect((real as { betas?: string[] }).betas).not.toContain(EFFORT_MESSAGE_BETA);
  });

  it("byte for byte with effort messages in the chat and a stored summary", async () => {
    const client = warmClient([text("Yes, about 20 mm."), [finish("t1")], text("Amsterdam on the top."), text("Done.")]);
    await twoTurns(client);
    const p = store.project;
    // A summary written between turns, standing in for the first message.
    p.compactions.push({ block: { type: "compaction", content: "Alex is making an oak console.", signature: "sig-1" } as unknown as Anthropic.Beta.BetaCompactionBlockParam, upto: 1, at: new Date().toISOString() });
    p.save();
    const { warm, real, count } = await expectSamePrefix(client, ask("Make the top 1300 wide"));
    const betas = (warm as { betas?: string[] }).betas;
    expect(betas).toContain(EFFORT_MESSAGE_BETA);
    expect(betas).toContain(ON_DEMAND_BETA);
    expect(warm).not.toHaveProperty("context_management");
    expect(warm.messages[0]!.content).toEqual([{ type: "compaction", content: "Alex is making an oak console.", signature: "sig-1" }]);
    expect(warm.messages.slice(0, count).filter((m) => m.role === "system")).toEqual([{ role: "system", content: [], output_config: { effort: "low" } }]);
    // The next turn sets its own level after the shared chat, which leaves the cache alone.
    expect(real.messages.slice(count).some((m) => m.role === "system")).toBe(true);
  });

  it("byte for byte when Claude is waiting on an answer to its question", async () => {
    const client = warmClient([[call("q1", "ask_user", { question: "How much overhang?", options: ["20 mm", "30 mm"] })], text("Done.")]);
    await turn(client).run(ask("Add an overhang to the top"));
    expect(store.project.pending?.waiting).toEqual([{ tool_use_id: "q1", kind: "question" }]);
    const { warm, real, count } = await expectSamePrefix(client, ask("30 mm"));
    expect((warm.messages.at(-1)!.content as unknown as Block[])[0]).toEqual({ type: "tool_result", tool_use_id: "q1", content: WARM_PLACEHOLDER });
    expect((real.messages[count]!.content as unknown as Block[])[0]).toMatchObject({ type: "tool_result", tool_use_id: "q1", content: "30 mm" });
  });
});

describe("when a warm-up goes", () => {
  it("goes once the gap since the design's last request outlasts the cache, and at most once a cache lifetime", async () => {
    const client = warmClient([text("Yes, about 20 mm.")]);
    await turn(client).run(ask("Should the top overhang the legs?"));
    const { w, clock } = warmer(client);
    w.asked(store.project.slug);
    clock.now += HOUR - 1;
    expect(w.start("open")).toBe("recent");
    clock.now += 2;
    expect(w.start("open")).toBe("started");
    await w.settled();
    expect(client.warmed).toHaveLength(1);
    clock.now += HOUR - 1;
    expect(w.start("window")).toBe("recent");
    clock.now += 2;
    expect(w.start("window")).toBe("started");
    await w.settled();
    expect(client.warmed).toHaveLength(2);
  });

  it("goes when nothing has been asked since the app started, and a failed one waits a lifetime too", async () => {
    const client = warmClient([text("Yes, about 20 mm.")]);
    await turn(client).run(ask("Should the top overhang the legs?"));
    client.mode.fail = true;
    const { w, clock } = warmer(client);
    expect(w.start("open")).toBe("started");
    await w.settled();
    expect(client.warmed).toHaveLength(1);
    expect(store.project.warmups()).toEqual([]);
    clock.now += HOUR / 2;
    expect(w.start("open")).toBe("recent");
  });

  it("follows a five-minute cache", async () => {
    process.env.WOODCHUCK_CACHE_TTL = "5m";
    const client = warmClient([text("Yes, about 20 mm.")]);
    await turn(client).run(ask("Should the top overhang the legs?"));
    const { w, clock } = warmer(client);
    w.asked(store.project.slug);
    clock.now += 4 * 60_000;
    expect(w.start("open")).toBe("recent");
    clock.now += 60_001;
    expect(w.start("open")).toBe("started");
    await w.settled();
    expect(client.warmed[0]!.body.messages.at(-1)!.content).toEqual([{ type: "text", text: WARM_PLACEHOLDER }]);
    expect(JSON.stringify(client.warmed[0]!.body)).toContain('"cache_control":{"type":"ephemeral"}');
    expect(ttlMs("5m")).toBe(300_000);
  });

  it("never goes for an empty chat", () => {
    const client = warmClient();
    const { w } = warmer(client);
    expect(w.start("open")).toBe("empty");
    expect(client.warmed).toHaveLength(0);
  });

  it("never goes while Claude works or a summary is written", async () => {
    const client = warmClient([text("Yes, about 20 mm.")]);
    await turn(client).run(ask("Should the top overhang the legs?"));
    let busy = true;
    const { w } = warmer(client, () => busy);
    expect(w.start("window")).toBe("busy");
    busy = false;
    store.project.queued.push({ item: "u1", input: ask("And oil it") });
    expect(w.start("window")).toBe("busy");
    expect(client.warmed).toHaveLength(0);
  });

  it("checks again when it's due, and goes for nothing that's changed meanwhile", async () => {
    const client = warmClient([text("Yes, about 20 mm.")]);
    await turn(client).run(ask("Should the top overhang the legs?"));
    let busy = false;
    const w = new Warmer(store, { busy: () => busy, client: () => client, clock: () => 0, delayMs: 30 });
    expect(w.start("open")).toBe("started");
    busy = true;
    await w.settled();
    expect(client.warmed).toHaveLength(0);
  });

  it("stays off with WOODCHUCK_CACHE_PREWARM=off, and with no client that can warm", async () => {
    const client = warmClient([text("Yes, about 20 mm.")]);
    await turn(client).run(ask("Should the top overhang the legs?"));
    process.env.WOODCHUCK_CACHE_PREWARM = "off";
    expect(cachePrewarm()).toBe(false);
    expect(warmer(client).w.start("open")).toBe("off");
    process.env.WOODCHUCK_CACHE_PREWARM = "on";
    expect(cachePrewarm()).toBe(true);
    expect(cachePrewarm(undefined)).toBe(true);
    expect(warmer(null).w.start("open")).toBe("no_client");
    expect(warmer(scriptedClient([]) as ReturnType<typeof warmClient>).w.start("open")).toBe("no_client");
    expect(client.warmed).toHaveLength(0);
  });

  it("skips a chat at the size where its next request summarises it", async () => {
    process.env.WOODCHUCK_COMPACT_AT = "50000";
    const client = warmClient([[{ type: "usage", input_tokens: 10, cache_read_input_tokens: 49_000, output_tokens: 1_000 }, ...text("Yes, about 20 mm.")]]);
    await turn(client).run(ask("Should the top overhang the legs?"));
    expect(chatSize(store.project, client.sent[0]!)).toBe(50_010);
    const { w, clock } = warmer(client);
    expect(w.start("open")).toBe("started");
    await w.settled();
    expect(client.warmed).toHaveLength(0);
    // It isn't asked about again for a lifetime.
    clock.now += 1;
    expect(w.start("open")).toBe("recent");
  });

  it("is stopped by a turn, and by closing", async () => {
    const client = warmClient([text("Yes, about 20 mm.")]);
    await turn(client).run(ask("Should the top overhang the legs?"));
    client.mode.hold = true;
    const { w } = warmer(client);
    expect(w.start("open")).toBe("started");
    await new Promise((r) => setTimeout(r, 10));
    expect(w.warming).toBe(true);
    w.stop();
    await w.settled();
    expect(client.warmed[0]!.signal!.aborted).toBe(true);
    expect(w.warming).toBe(false);
    expect(store.project.warmups()).toEqual([]);
    w.close();
    expect(w.start("open")).toBe("off");
  });
});

describe("what a warm-up cost", () => {
  it("is kept apart from the chat, where turn-stats counts it and no turn", async () => {
    const client = warmClient([text("Yes, about 20 mm.")]);
    await turn(client).run(ask("Should the top overhang the legs?"));
    const chat = JSON.stringify(store.project.chat);
    const { w } = warmer(client);
    w.start("mcp");
    await w.settled();
    expect(store.project.warmups()).toEqual([
      { at: expect.any(String), model: "claude-sonnet-5-5", trigger: "mcp", ms: expect.any(Number), input: 9, cached: 0, written: 41_000 },
    ] satisfies Warmup[]);
    expect(JSON.stringify(store.project.chat)).toBe(chat);
    expect(readWarmups(dir)).toEqual([{ design: 1, trigger: "mcp", ms: expect.any(Number), input: 9, cached: 0, written: 41_000 }]);
    const out = report([], readWarmups(dir));
    expect(out).toContain("Cache warm-ups, which aren't turns: 1, writing 41000 tokens and reading 0");
    expect(out).toContain("Asked for by mcp 1.");
    expect(out).toContain("0 turns in 0 designs");
  });
});

describe("in the app", () => {
  let close: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await close?.();
    close = null;
  });

  async function app(client: ReturnType<typeof warmClient>) {
    const clock = { now: 5_000_000 };
    const a = createApp({ dataDir: dir, client, watchTools: false, prewarm: { clock: () => clock.now, delayMs: 0 } });
    await new Promise<void>((r) => a.server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(a.server.address() as AddressInfo).port}`;
    close = a.close;
    const post = (p: string, body: unknown = {}) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const get = async <T>(p: string) => (await (await fetch(base + p)).json()) as T;
    const until = async (test: () => boolean | Promise<boolean>, ms = 5000) => {
      const end = Date.now() + ms;
      while (!(await test())) {
        if (Date.now() > end) throw new Error("timed out");
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    const idle = () => until(async () => !(await get<{ busy: boolean }>("/api/busy")).busy);
    return { a, base, clock, post, get, until, idle };
  }

  it("warms a design you switch to after a gap, and not one you just used", async () => {
    const client = warmClient([text("Yes, about 20 mm.")]);
    const { a, clock, post, until, idle } = await app(client);
    const slug = a.store.project.slug;
    await post("/api/chat", { text: "Should the top overhang the legs?", selection: [] });
    await idle();
    // Straight after a turn, the cache is warm.
    expect(await (await post("/api/warm", { from: "window" })).json()).toEqual({ ok: true, started: false, answer: "recent" });
    await post("/api/projects", { name: "Hall table for Sam" });
    expect(await (await post("/api/warm", {})).json()).toMatchObject({ answer: "empty" });
    clock.now += HOUR + 1;
    expect((await post("/api/projects/open", { slug })).status).toBe(200);
    await until(() => client.warmed.length === 1);
    await a.warmer.settled();
    expect(a.store.project.warmups()).toMatchObject([{ trigger: "open", written: 41_000 }]);
  });

  it("stops a warm-up on its way when a turn starts, and when the app closes", async () => {
    const client = warmClient([text("Yes, about 20 mm."), text("Done.")]);
    const { a, clock, post, get, until, idle } = await app(client);
    await post("/api/chat", { text: "Should the top overhang the legs?", selection: [] });
    await idle();
    client.mode.hold = true;
    clock.now += HOUR + 1;
    expect(await (await post("/api/warm", { from: "window" })).json()).toEqual({ ok: true, started: true, answer: "started" });
    await until(() => client.warmed.length === 1);
    expect(a.warmer.warming).toBe(true);
    expect(await get("/api/busy")).toEqual({ busy: false, reasons: [] });
    expect((await get<{ busy: boolean }>("/api/state")).busy).toBe(false);
    await post("/api/chat", { text: "Make the overhang 25 mm", selection: [] });
    expect(client.warmed[0]!.signal!.aborted).toBe(true);
    await idle();
    expect(a.warmer.warming).toBe(false);

    clock.now += HOUR + 1;
    expect(await (await post("/api/warm", {})).json()).toMatchObject({ started: true });
    await until(() => client.warmed.length === 2);
    await close!();
    close = null;
    expect(client.warmed[1]!.signal!.aborted).toBe(true);
    expect(a.store.project.warmups()).toEqual([]);
  });

  it("warms when another app calls a Woodchuck tool through MCP", async () => {
    const client = warmClient([text("Yes, about 20 mm.")]);
    const { a, base, clock, post, until, idle } = await app(client);
    await post("/api/chat", { text: "Should the top overhang the legs?", selection: [] });
    await idle();
    clock.now += HOUR + 1;
    process.env.WOODCHUCK_URL = base;
    const { buildServer } = await import("../src/mcp.js");
    const [x, y] = InMemoryTransport.createLinkedPair();
    await buildServer().connect(x);
    const mcp = new Client({ name: "test", version: "1.0.0" });
    await mcp.connect(y);
    try {
      await mcp.callTool({ name: "woodchuck_status", arguments: {} });
      await until(() => client.warmed.length === 1);
      await a.warmer.settled();
      expect(JSON.parse(readFileSync(path.join(a.store.project.dir, "warmups.json"), "utf8"))).toMatchObject([{ trigger: "mcp" }]);
    } finally {
      await mcp.close();
    }
  });
});
