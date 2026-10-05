// Issue #19: the prompt cache lasts an hour, so a pause in a voice chat or
// between edits doesn't make the next request write the whole chat to the
// cache again. Both breakpoints carry the same lifetime, read once a turn,
// and WOODCHUCK_CACHE_TTL=5m goes back to five minutes. A scripted Claude
// plays every turn, so nothing here needs a key.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { Turn, type MessagesClient, type TurnInput } from "../src/agent.js";
import { cacheControl, cacheTtl } from "../src/prompt.js";
import { scriptedClient } from "../src/scripted.js";
import { Store } from "../src/store.js";

type Block = Record<string, unknown>;
type Sent = Anthropic.Beta.MessageCreateParamsStreaming;

const HOUR = { type: "ephemeral", ttl: "1h" };
const FIVE_MINUTES = { type: "ephemeral" };

const call = (id: string, name: string, input: Block): Block => ({ type: "tool_use", id, name, input });
const text = (t: string): Block[] => [{ type: "text", text: t }];
const ask = (t: string): TurnInput => ({ text: t, selection: [] });
// Invented sizes for a bookcase Sam is drawing up.
const width = call("t1", "set_param", { name: "width", expr: "800", unit: "mm" });
const depth = call("t2", "set_param", { name: "depth", expr: "300", unit: "mm" });

let dir: string;
let store: Store;
const envTtl = process.env.WOODCHUCK_CACHE_TTL;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "woodchuck-cache-"));
  store = new Store(dir);
  delete process.env.WOODCHUCK_CACHE_TTL;
});
afterEach(() => {
  if (envTtl === undefined) delete process.env.WOODCHUCK_CACHE_TTL;
  else process.env.WOODCHUCK_CACHE_TTL = envTtl;
  rmSync(dir, { recursive: true, force: true });
});

function turn(client: MessagesClient) {
  return new Turn(store, client, { chat() {}, delta() {}, changed() {} }, () => Buffer.from("png"));
}

/**
 * Every cache breakpoint in a request, in the order the API reads them:
 * tools, then system, then the history, with the top-level one last, since
 * it lands on the history's final block.
 */
function breakpoints(sent: Sent): unknown[] {
  const body = sent as unknown as Block;
  const found: unknown[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (k === "cache_control") found.push(x);
        else walk(x);
      }
    }
  };
  walk(body.tools);
  walk(body.system);
  walk(body.messages);
  found.push(body.cache_control);
  return found;
}

/** The request as bytes, without the history, which grows by design each round. */
function settings(sent: Sent): string {
  const { messages: _history, ...rest } = sent;
  return JSON.stringify(rest);
}

describe("the cache's lifetime", () => {
  it("is an hour on both breakpoints by default, with no beta for it", async () => {
    const client = scriptedClient([text("Hi.")]);
    await turn(client).run(ask("hello"));
    const body = client.sent[0]!;
    const system = body.system as Anthropic.Beta.BetaTextBlockParam[];
    expect(system).toHaveLength(2);
    expect(system[0]!.cache_control).toBeUndefined();
    expect(system[1]!.cache_control).toEqual(HOUR);
    expect(body.cache_control).toEqual(HOUR);
    // There's no other breakpoint, so a five-minute one can never come before an hour's.
    expect(breakpoints(body)).toEqual([HOUR, HOUR]);
    expect(body.betas!.filter((b) => /cache|ttl/i.test(b))).toEqual([]);
  });

  it("goes back to the five-minute shape, with no ttl at all, when set to 5m", async () => {
    process.env.WOODCHUCK_CACHE_TTL = "5m";
    const client = scriptedClient([text("Hi.")]);
    await turn(client).run(ask("hello"));
    const found = breakpoints(client.sent[0]!);
    expect(found).toHaveLength(2);
    for (const b of found) expect(b).toStrictEqual(FIVE_MINUTES);
  });

  it("reads the setting without regard to case or spaces", () => {
    const warn = vi.fn();
    expect(cacheTtl(undefined, warn)).toBe("1h");
    expect(cacheTtl("", warn)).toBe("1h");
    expect(cacheTtl("1h", warn)).toBe("1h");
    expect(cacheTtl(" 5M ", warn)).toBe("5m");
    expect(warn).not.toHaveBeenCalled();
    expect(cacheControl("1h")).toStrictEqual(HOUR);
    expect(cacheControl("5m")).toStrictEqual(FIVE_MINUTES);
  });

  it("falls back to an hour on a value it can't read, and warns once for it", () => {
    const warn = vi.fn();
    expect(cacheTtl("2h", warn)).toBe("1h");
    expect(cacheTtl("2h", warn)).toBe("1h");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("WOODCHUCK_CACHE_TTL should be 1h or 5m, so it's 1h.");
  });

  it("sends an hour on both breakpoints when the setting can't be read", async () => {
    process.env.WOODCHUCK_CACHE_TTL = "300";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const client = scriptedClient([text("Hi.")]);
      await turn(client).run(ask("hello"));
      expect(breakpoints(client.sent[0]!)).toEqual([HOUR, HOUR]);
      expect(warn).toHaveBeenCalledWith("WOODCHUCK_CACHE_TTL should be 1h or 5m, so it's 1h.");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("a steady request", () => {
  it("sends the same bytes on every round of a turn, and from one turn to the next", async () => {
    const client = scriptedClient([[width], [depth], text("Set the width and depth."), text("Nothing else to do.")]);
    await turn(client).run(ask("Carry on"));
    await turn(client).run(ask("Carry on"));
    expect(client.sent).toHaveLength(4);
    for (const b of client.sent) expect(settings(b)).toBe(settings(client.sent[0]!));
    // The history only grows.
    for (let i = 1; i < client.sent.length; i++) {
      const before = client.sent[i - 1]!.messages;
      expect(client.sent[i]!.messages.slice(0, before.length)).toEqual(before);
    }
  });

  it("reads the setting once a turn, so a change waits for the next turn", async () => {
    const inner = scriptedClient([[width], [depth], text("Set the width and depth."), text("Nothing else to do.")]);
    // The setting changes while the turn's first request is out.
    const client: MessagesClient = {
      stream(body) {
        const reply = inner.stream(body);
        process.env.WOODCHUCK_CACHE_TTL = "5m";
        return reply;
      },
    };
    await turn(client).run(ask("Carry on"));
    const rounds = inner.sent.slice(0, 3);
    for (const b of rounds) {
      expect(settings(b)).toBe(settings(rounds[0]!));
      expect(breakpoints(b)).toEqual([HOUR, HOUR]);
    }

    await turn(client).run(ask("Carry on"));
    for (const b of breakpoints(inner.sent[3]!)) expect(b).toStrictEqual(FIVE_MINUTES);
  });
});
