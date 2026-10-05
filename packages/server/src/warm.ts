// Warms Claude's prompt cache before the woodworker's next message. The
// cache lasts an hour from the last request that used it, or five minutes
// with WOODCHUCK_CACHE_TTL=5m. The first reply after a longer gap, or after
// a deploy changed Claude's instructions or tools, writes the whole chat to
// the cache before Claude can start. A warm-up sends a copy of the next
// request with max_tokens 0, which writes the cache and answers nothing,
// while the woodworker is still looking.
//
// Opening or switching to a design, a window coming into view, and another
// app calling a Woodchuck tool through MCP each ask for one. It goes out
// only when the open design's chat isn't empty, Claude isn't working or
// summarising, and the design's last request was longer ago than the cache
// lasts, or none has gone out since the app started. A design gets one at
// most once a cache lifetime, whether it worked or not. It waits a moment
// first, so clicking through designs warms only the one you stop on. A turn
// that starts meanwhile stops it, and so does closing the app. The restart
// gate never waits on one.
//
// The request comes from nextRequest(), the same function every step of a
// turn uses, so the two match in everything the cache reads. A chat at the
// size where the API summarises inside a request isn't warmed, since its
// next request writes a new cache from the summary anyway.
//
// What each warm-up cost goes in the design's warmups.json and the log.
// The chat never shows it, and turn-stats counts it apart from the turns.

import type Anthropic from "@anthropic-ai/sdk";
import { nextRequest, requestSettings, sendable, warmRequest, type MessagesClient } from "./agent.js";
import { cacheTtl, type CacheTtl } from "./prompt.js";
import type { Project, Store, WarmTrigger, Warmup } from "./store.js";
import { roughCount } from "./summaries.js";

/** Whether warm-ups are on, from WOODCHUCK_CACHE_PREWARM. Only "off" turns them off. */
export function cachePrewarm(value = process.env.WOODCHUCK_CACHE_PREWARM): boolean {
  return value?.trim().toLowerCase() !== "off";
}

/** How long a cache entry lives, in milliseconds. */
export function ttlMs(ttl: CacheTtl): number {
  return ttl === "1h" ? 60 * 60_000 : 5 * 60_000;
}

/** How long a warm-up waits after what asked for it, so a quick run of switches or a message straight after costs nothing. */
export const WARM_DELAY_MS = 2_000;

/** What came of asking for a warm-up: one is on its way, or why not. */
export type WarmAnswer = "started" | "off" | "no_client" | "busy" | "empty" | "recent";

/**
 * The tokens the next request carries before the woodworker's message: the
 * last request Claude replied to, with its reply. A chat with no timed turn
 * gets a rough count.
 */
export function chatSize(project: Project, request: Anthropic.Beta.MessageCreateParamsStreaming): number {
  const usage = project.chat.findLast((c) => c.kind === "usage");
  const last = usage?.kind === "usage" ? usage.rounds?.at(-1) : undefined;
  if (last) return last.input + last.cached + last.written + last.output;
  return roughCount([request.system, request.tools, request.messages]);
}

interface Run {
  slug: string;
  controller: AbortController;
  /** What stopped it, once something has. */
  stoppedBy: "turn" | "close" | null;
}

export interface WarmerOptions {
  /** Whether Claude is working or a summary of the chat is being written. */
  busy: () => boolean;
  /** The client, made when it's first needed, or null with no key. */
  client: () => MessagesClient | null;
  /** The wall clock in milliseconds. Tests pass a fake. */
  clock?: () => number;
  /** How long a warm-up waits before it goes. Tests pass 0. */
  delayMs?: number;
}

export class Warmer {
  /** When each design last sent Claude a request since the app started: a turn or a warm-up, by the clock. */
  private readonly lastAsked = new Map<string, number>();
  /** A warm-up waiting out its delay. */
  private waiting: { slug: string; timer: ReturnType<typeof setTimeout>; done: () => void } | null = null;
  private readonly runs = new Set<Run>();
  private landing: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private store: Store,
    private opts: WarmerOptions,
  ) {}

  private now(): number {
    return (this.opts.clock ?? Date.now)();
  }

  /** Notes a request to Claude about a design, from a turn, so a warm-up waits a cache lifetime from it. */
  asked(slug: string) {
    this.lastAsked.set(slug, this.now());
  }

  /** Whether a warm-up is being sent. */
  get warming(): boolean {
    return this.runs.size > 0;
  }

  /** Settles once the latest warm-up asked for has landed, failed or been stopped. */
  settled(): Promise<void> {
    return this.landing;
  }

  /** Why the open design gets no warm-up now, or null when it needs one. */
  private refusal(): Exclude<WarmAnswer, "started"> | null {
    if (this.closed || !cachePrewarm()) return "off";
    if (!this.opts.client()?.create) return "no_client";
    const project = this.store.project;
    if (this.opts.busy() || project.queued.length) return "busy";
    if (!sendable(project.messages, project.compactions, project.refused).length) return "empty";
    const last = this.lastAsked.get(project.slug);
    if (last !== undefined && this.now() - last < ttlMs(cacheTtl())) return "recent";
    return null;
  }

  /**
   * Asks for a warm-up of the open design, and returns at once. It goes out
   * after a short wait, if the design still needs it then. A wait for
   * another design is dropped, and one already sent carries on.
   */
  start(trigger: WarmTrigger): WarmAnswer {
    const why = this.refusal();
    if (why) return why;
    const slug = this.store.project.slug;
    if (this.waiting?.slug === slug) return "started";
    this.cancelWait();
    let done!: () => void;
    this.landing = new Promise<void>((resolve) => (done = resolve));
    const timer = setTimeout(() => {
      this.waiting = null;
      void this.send(slug, trigger).finally(done);
    }, this.opts.delayMs ?? WARM_DELAY_MS);
    timer.unref?.();
    this.waiting = { slug, timer, done };
    return "started";
  }

  private cancelWait() {
    if (!this.waiting) return;
    clearTimeout(this.waiting.timer);
    this.waiting.done();
    this.waiting = null;
  }

  /** Stops a warm-up waiting or on its way, as a turn starts. */
  stop(why: "turn" | "close" = "turn") {
    this.cancelWait();
    for (const run of this.runs) {
      run.stoppedBy = why;
      run.controller.abort();
    }
  }

  /** Stops every warm-up, and starts no more, as the app closes. */
  close() {
    this.closed = true;
    this.stop("close");
  }

  /** Sends the warm-up, if the design is still open and still needs one, and keeps what it cost. */
  private async send(slug: string, trigger: WarmTrigger): Promise<void> {
    const project = this.store.project;
    if (project.slug !== slug || this.refusal()) return;
    const settings = requestSettings(this.store.workshop());
    const next = nextRequest(project, settings);
    // The API summarises a chat this size inside its next request, which starts a new cache from the summary.
    if (!next.summarised && settings.fallbackAt !== null && chatSize(project, next.body) >= settings.fallbackAt) {
      this.asked(slug);
      console.log("The chat is at the size where Claude's next request summarises it, so its cache wasn't warmed.");
      return;
    }
    const warm = warmRequest(next.body);
    const client = this.opts.client();
    if (!warm || !client?.create) return;
    const run: Run = { slug, controller: new AbortController(), stoppedBy: null };
    const started = this.now();
    this.lastAsked.set(slug, started);
    this.runs.add(run);
    try {
      const message = await client.create(warm.body, { signal: run.controller.signal });
      if (this.closed) return;
      const u = message.usage;
      const w: Warmup = {
        at: new Date().toISOString(),
        model: warm.body.model,
        trigger,
        ms: Math.round(this.now() - started),
        input: u.input_tokens ?? 0,
        cached: u.cache_read_input_tokens ?? 0,
        written: u.cache_creation_input_tokens ?? 0,
      };
      try {
        project.addWarmup(w);
      } catch (e) {
        console.error(`Couldn't keep the cache warm-up's numbers: ${(e as Error).message}`);
      }
      const n = (v: number) => v.toLocaleString("en-AU");
      console.log(`Warmed Claude's prompt cache in ${(w.ms / 1000).toFixed(1)} s (${trigger}): ${n(w.written)} tokens written, ${n(w.cached)} read, ${n(w.input)} uncached.`);
    } catch (e) {
      if (run.stoppedBy === "turn") console.log("A turn started, so the cache warm-up was stopped.");
      else if (!run.stoppedBy) console.error(`The cache warm-up failed: ${(e as Error).message}. Claude's next reply writes the cache itself.`);
    } finally {
      this.runs.delete(run);
    }
  }
}
