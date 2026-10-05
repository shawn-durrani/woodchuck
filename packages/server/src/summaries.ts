// A long chat is summarised between turns, in the background, so no turn
// pauses while the summary is written. Once a turn ends with the chat past
// WOODCHUCK_COMPACT_IDLE_AT tokens, Woodchuck asks the API for a summary
// (on-demand compaction) and doesn't wait for it.
//
// The summary covers exactly the messages of the turn's last request to
// Claude, sent with that request's model, instructions, tools and thinking.
// Everything after them is kept word for word, starting with Claude's reply,
// so the thinking in the kept turns stays valid. A turn that starts while
// the summary is being written runs on the whole chat, and the summary goes
// in at its next request.
//
// The saved chat only grows. A summary that lands is kept in the design's
// compactions.json with the number of messages it covers, and sendable()
// sends it first and every later message after it. One that fails, comes
// back empty or lands after the chat has moved on is logged and dropped.
// After one that fails or comes back empty, the design gets no new try
// until its chat has grown by RETRY_GROWTH tokens or RETRY_AFTER_MS has
// passed, so a summary that keeps failing isn't paid for after every turn.
//
// Only one summary is written at a time. None starts while Claude waits on
// the woodworker or a message waits to be read. The restart gate reports
// one in flight, and closing the app abandons it.
//
// A summary request refuses a summary block without its signature, and the
// API's own summary inside a request can come without one. A request sent
// from one of those is summarised from the saved chat in full instead,
// with the old summary taken out. The whole chat is measured first, with
// the API's free token count, or a rough count when that fails. A chat too
// long for the model keeps the API's own summaries, and the skip is logged.

import Anthropic from "@anthropic-ai/sdk";
import {
  contextTokens,
  EFFORT_MESSAGE_BETA,
  effortOf,
  holdsUnsigned,
  ON_DEMAND_BETA,
  SUMMARY_INSTRUCTIONS,
  summaryBase,
  unsigned,
  withoutSummaries,
  type Asked,
  type MessagesClient,
} from "./agent.js";
import type { ChatItem, Project, Store } from "./store.js";

/**
 * The most a summary request may write, thinking included. The docs ask for
 * several thousand tokens, and a summary cut off at the limit is dropped.
 */
export const SUMMARY_MAX_TOKENS = 16_000;

/** How much a chat grows, in tokens, before a design whose summary failed gets a new try. */
export const RETRY_GROWTH = 20_000;
/** How long before a design whose summary failed gets a new try, whatever its size. */
export const RETRY_AFTER_MS = 60 * 60_000;

/**
 * Room a whole chat leaves in the model's context, past the summary's own
 * SUMMARY_MAX_TOKENS. It covers the summarising prompt the API adds, the
 * web tools the token count can't take, and the count being an estimate.
 */
export const COUNT_MARGIN = 20_000;

/** The most a whole chat may come to for a summary of all of it on a model. */
export function wholeChatLimit(model: string): number {
  return contextTokens(model) - SUMMARY_MAX_TOKENS - COUNT_MARGIN;
}

/** What roughCount gives a picture, at the most a picture can cost. */
const PICTURE_TOKENS = 5_000;
/** What roughCount gives a PDF or other document, about ten pages' worth. */
const DOCUMENT_TOKENS = 30_000;
/** Fields that hold encoded data, which reads as nothing like its tokens. */
const ENCODED = new Set(["signature", "encrypted_content"]);

/**
 * A rough token count, for when the API's count fails. A picture counts
 * 5,000 tokens and a document 30,000, wherever they sit, such as inside a
 * tool's result. Signatures, encrypted thinking and other encoded data
 * count nothing. Everything else is a token for every three characters.
 */
export function roughCount(value: unknown): number {
  if (typeof value === "string") return Math.ceil(value.length / 3);
  if (Array.isArray(value)) return value.reduce((n: number, v) => n + roughCount(v), 0);
  if (value && typeof value === "object") {
    const type = (value as { type?: unknown }).type;
    if (type === "image") return PICTURE_TOKENS;
    if (type === "document") return DOCUMENT_TOKENS;
    if (type === "redacted_thinking" || type === "base64") return 0;
    return Object.entries(value).reduce((n: number, [k, v]) => (ENCODED.has(k) ? n : n + roughCount(v)), 0);
  }
  return 1;
}

/** How big a whole chat came out, and how it was counted. */
export interface Measure {
  /** The number of saved messages measured, from the first. */
  upto: number;
  tokens: number;
  by: "the token count" | "a rough count";
}

/**
 * The request that counts a summary request's tokens. It carries the same
 * model, instructions, tools, thinking and betas. The count refuses server
 * tools such as web search, so those are left out, and COUNT_MARGIN covers
 * them. It takes the summary setting and ignores it.
 */
export function countRequest(request: Anthropic.Beta.MessageCreateParamsStreaming): Anthropic.Beta.Messages.MessageCountTokensParams {
  const tools = request.tools?.filter((t) => !("type" in t) || t.type === "custom");
  return {
    model: request.model,
    messages: request.messages,
    ...(request.system !== undefined ? { system: request.system } : {}),
    ...(tools?.length ? { tools } : {}),
    ...(request.thinking !== undefined ? { thinking: request.thinking } : {}),
    ...(request.output_config !== undefined ? { output_config: request.output_config } : {}),
    ...(request.compaction ? { compaction: request.compaction } : {}),
    ...(request.betas !== undefined ? { betas: request.betas } : {}),
  } as Anthropic.Beta.Messages.MessageCountTokensParams;
}

/** A summary request's size: the API's free count, or a rough one when the client can't count or the count fails. */
async function measure(client: MessagesClient, request: Anthropic.Beta.MessageCreateParamsStreaming): Promise<Omit<Measure, "upto">> {
  if (client.countTokens) {
    try {
      return { tokens: (await client.countTokens(countRequest(request))).input_tokens, by: "the token count" };
    } catch (e) {
      console.error(`Couldn't count the chat's tokens: ${(e as Error).message}. A rough count stands in.`);
    }
  }
  return { tokens: roughCount([request.system, request.tools, request.messages]), by: "a rough count" };
}

/** Betas a summary request leaves out: the API's summary at a threshold, and fallbacks, which it doesn't send. */
const LEFT_OUT = new Set(["compact-2026-01-12", "server-side-fallback-2026-07-01", ON_DEMAND_BETA]);

/**
 * The request for a summary of what a request carried. It keeps that
 * request's model, instructions, tools, thinking, level and cache setting,
 * so the summary reads from the cache and the kept turns' thinking stays
 * valid. It leaves out the threshold summary, which the API refuses beside
 * this one, and anything else the API refuses on a summary request. Given
 * other messages, such as the whole chat, it summarises those instead.
 */
export function summaryRequest(
  body: Anthropic.Beta.MessageCreateParamsStreaming,
  messages: Anthropic.Beta.BetaMessageParam[] = body.messages,
): Anthropic.Beta.MessageCreateParamsStreaming {
  const effort = body.output_config?.effort;
  const betas = [...(body.betas ?? []).filter((b) => !LEFT_OUT.has(b)), ON_DEMAND_BETA];
  if (messages.some((m) => effortOf(m)) && !betas.includes(EFFORT_MESSAGE_BETA)) betas.push(EFFORT_MESSAGE_BETA);
  return {
    model: body.model,
    max_tokens: SUMMARY_MAX_TOKENS,
    ...(body.system !== undefined ? { system: body.system } : {}),
    ...(body.tools !== undefined ? { tools: body.tools } : {}),
    messages,
    ...(body.thinking !== undefined ? { thinking: body.thinking } : {}),
    ...(effort ? { output_config: { effort } } : {}),
    ...(body.cache_control !== undefined ? { cache_control: body.cache_control } : {}),
    compaction: { type: "summarize", instructions: SUMMARY_INSTRUCTIONS },
    betas,
  } as Anthropic.Beta.MessageCreateParamsStreaming;
}

/** Whether the API refused a request as too long for the model. */
function tooLong(e: unknown): boolean {
  return e instanceof Anthropic.BadRequestError && /prompt is too long|context window/i.test(e.message);
}

/** What a summary request cost. The API reports the summary as an iteration, and the top-level counts are zero. */
function spent(message: Anthropic.Beta.BetaMessage) {
  const u = message.usage;
  const parts = u.iterations?.length ? u.iterations : [u];
  const out = { input: 0, cached: 0, written: 0, output: 0 };
  for (const p of parts) {
    out.input += p.input_tokens ?? 0;
    out.cached += p.cache_read_input_tokens ?? 0;
    out.written += p.cache_creation_input_tokens ?? 0;
    out.output += p.output_tokens ?? 0;
  }
  return out;
}

interface Running {
  project: Project;
  upto: number;
  base: string;
  /** The chat's size when the summary was asked for. */
  size: number;
  /** Whether it summarises the whole saved chat, since the request held a summary without its signature. */
  whole: boolean;
  started: number;
  /** The request being written, once the whole chat has been measured. */
  stream: { abort(): void } | null;
}

const now = () => new Date().toISOString();
let seq = 0;

export class Summaries {
  private running: Running | null = null;
  private landing: Promise<void> = Promise.resolve();
  private closed = false;
  /** The last summary that failed or came back empty, by design: the chat's size then, and when. */
  private readonly failed = new Map<string, { size: number; at: number }>();
  /** Designs whose whole chat is too long to summarise in one request. */
  private readonly tooLong = new Set<string>();
  /**
   * The last whole chat measured for a summary, by design. A chat is counted
   * again only once it's grown. The live check reads it too.
   */
  readonly measured = new Map<string, Measure>();

  constructor(
    private store: Store,
    private events: { chat(item: ChatItem): void; changed(): void } = { chat() {}, changed() {} },
    /** The wall clock in milliseconds, for timing a summary and spacing out new tries. Tests pass a fake. */
    private clock: () => number = () => Date.now(),
  ) {}

  /** Whether a summary is being written, for the restart gate. */
  get busy(): boolean {
    return this.running !== null;
  }

  /** Settles once the summary being written has landed or been dropped. */
  settled(): Promise<void> {
    return this.landing;
  }

  /**
   * Asks for a summary of what a request carried, once the chat has passed
   * `at` tokens, and returns at once. Nothing starts while a summary is being
   * written, while Claude waits on the woodworker, while a message waits to
   * be read, or after a newer summary has landed. A design whose last
   * summary failed waits until its chat has grown or an hour has passed.
   * A request that held a summary without its signature is summarised from
   * the whole saved chat, measured first, unless that's too long for the
   * model. The design counts as busy while it's measured.
   */
  start(client: MessagesClient, asked: Asked | null, at: number | null): boolean {
    if (this.closed || this.running || !asked || at === null || asked.size <= at) return false;
    const project = asked.project;
    if (project.pending?.waiting.length || project.queued.length) return false;
    if (summaryBase(project.messages, project.compactions, project.refused) !== asked.base) return false;
    const failed = this.failed.get(project.slug);
    if (failed && asked.size < failed.size + RETRY_GROWTH && this.clock() - failed.at < RETRY_AFTER_MS) return false;
    const whole = holdsUnsigned(asked.body.messages);
    if (whole && this.tooLong.has(project.slug)) return false;
    const request = summaryRequest(asked.body, whole ? withoutSummaries(project.messages.slice(0, asked.upto)) : asked.body.messages);
    const run: Running = { project, upto: asked.upto, base: asked.base, size: asked.size, whole, started: this.clock(), stream: null };
    this.running = run;
    this.events.changed();
    const sending = whole
      ? this.fits(client, run, request).then((fits) => {
          // The chat can move on while it's measured, and a summary of it then would be dropped.
          if (!fits || this.closed || summaryBase(project.messages, project.compactions, project.refused) !== run.base) return;
          return this.ask(client, run, request);
        })
      : this.ask(client, run, request);
    this.landing = sending.finally(() => {
      if (this.running !== run) return;
      this.running = null;
      if (!this.closed) this.events.changed();
    });
    return true;
  }

  /**
   * Whether the whole chat fits one summary request on its model. One that
   * doesn't is logged once, and the design isn't summarised whole again.
   */
  private async fits(client: MessagesClient, run: Running, request: Anthropic.Beta.MessageCreateParamsStreaming): Promise<boolean> {
    const slug = run.project.slug;
    let size = this.measured.get(slug);
    if (size?.upto !== run.upto) {
      size = { upto: run.upto, ...(await measure(client, request)) };
      this.measured.set(slug, size);
    }
    if (this.closed) return false;
    const counted = `${size.tokens.toLocaleString("en-AU")} tokens by ${size.by}`;
    const limit = wholeChatLimit(request.model);
    if (size.tokens > limit) {
      this.tooLong.add(slug);
      console.log(
        `The chat's older summary has no signature, and the whole chat is too long to summarise instead (${counted}, over ${limit.toLocaleString("en-AU")}), so the API carries on summarising it inside a request.`,
      );
      return false;
    }
    console.log(`The chat's older summary has no signature, so the summary request sends the whole chat instead (${counted}).`);
    return true;
  }

  /** Sends a summary request, and keeps or drops what comes back. */
  private ask(client: MessagesClient, run: Running, request: Anthropic.Beta.MessageCreateParamsStreaming): Promise<void> {
    const project = run.project;
    let stream: ReturnType<MessagesClient["stream"]>;
    try {
      stream = client.stream(request);
    } catch (e) {
      console.error(`Couldn't ask for a summary of the chat: ${(e as Error).message}. Claude carries on with the whole chat.`);
      return Promise.resolve();
    }
    run.stream = stream;
    return stream.finalMessage().then(
      (message) => this.land(run, message),
      (e: unknown) => {
        if (this.closed) return;
        if (run.whole && tooLong(e)) return this.skipWhole(project.slug);
        this.failed.set(project.slug, { size: run.size, at: this.clock() });
        console.error(`The chat summary failed: ${(e as Error).message}. Claude carries on with the whole chat.`);
      },
    );
  }

  /** Stops summarising a design whose whole chat the API found too long. */
  private skipWhole(slug: string) {
    this.tooLong.add(slug);
    console.log("The whole chat is too long to summarise in one request, so the API carries on summarising it inside a request.");
  }

  /** Abandons a summary being written, as the app closes. */
  stop() {
    this.closed = true;
    this.running?.stream?.abort();
    this.running = null;
  }

  /**
   * Keeps a summary that came back, if the chat it covers is still the one
   * open and nothing newer has summarised it since. The saved messages stay
   * as they are, and the next request sends the summary in their place.
   */
  private land(run: Running, message: Anthropic.Beta.BetaMessage) {
    if (this.closed) return;
    const cost = spent(message);
    const tokens = `${cost.input + cost.cached + cost.written} in, ${cost.output} out`;
    const block = message.stop_reason === "compaction" ? message.content.find((b) => b.type === "compaction") : undefined;
    const project = run.project;
    if (!block && run.whole && message.stop_reason === "model_context_window_exceeded") return this.skipWhole(project.slug);
    // One without its signature would be refused on the next request, so it's dropped the same as no summary.
    if (!block || unsigned(block)) {
      this.failed.set(project.slug, { size: run.size, at: this.clock() });
      const what = block ? `without its signature (${tokens})` : `without one (${message.stop_reason ?? "no stop reason"}, ${tokens})`;
      console.log(`The chat summary came back ${what}, so Claude carries on with the whole chat.`);
      return;
    }
    if (this.store.project !== project || summaryBase(project.messages, project.compactions, project.refused) !== run.base) {
      console.log(`The chat summary arrived after the chat had moved on, so it was dropped (${tokens}).`);
      return;
    }
    this.failed.delete(project.slug);
    // Kept exactly as the API returned it, signature and all.
    project.compactions.push({ block: block as unknown as Anthropic.Beta.BetaCompactionBlockParam, upto: run.upto, at: now() });
    const item: ChatItem = { id: `s${Date.now().toString(36)}b${(seq++).toString(36)}`, kind: "summary", at: now(), ...cost, ms: Math.round(this.clock() - run.started) };
    project.addChat(item);
    project.save();
    this.events.chat(item);
  }
}
