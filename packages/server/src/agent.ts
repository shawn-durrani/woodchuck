// One Claude turn: send the woodworker's message, run the tools Claude
// calls, and loop until it's done or waiting on a reply. The whole turn is
// one change set, so a single undo takes back everything it did. An edit
// you make while it works splits it, so your edit is a step of its own.
//
// You can talk and edit while Claude works. What you say and change goes in
// after its next step, beside that step's tool results, so Claude carries
// on with it in mind.
//
// The conversation is append-only. Nothing earlier is ever edited, because
// the model's thinking blocks are only valid against the exact history they
// came from. A long chat is summarised by the API itself (compaction), which
// doesn't count as an edit, and only the summary onwards is sent after that.
// Claude's instructions, its tools and your workshop count as history too,
// so a deploy or a workshop change would otherwise refuse an open chat.
// Every request asks the API to drop the thinking that no longer fits.
// The whole chat stays on disk, and recall_chat searches it.
//
// Each turn picks how hard Claude thinks (route.ts). The request's own
// level never changes, since that would restart the cache, so a turn sets
// its level with an effort message in the chat, only when the level changes.

import Anthropic from "@anthropic-ai/sdk";
import type { ViewName } from "@woodchuck/core";
import { systemPrompt } from "./prompt.js";
import type { ChatItem, Job, Pending, Pin, Project, RoundTiming, Store } from "./store.js";
import { atLeast, effortRouting, isEffort, needsJudgement, routeTurn, type Effort, type Route } from "./route.js";
import { runTool, TOOLS, type LibraryAccess, type ToolContext } from "./tools.js";
import { searchCountry } from "./workshop.js";

/** Models the chat can use. All take the same request: adaptive thinking, effort, effort messages and fallbacks. */
export const MODELS = [
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", note: "the default, the quickest and the cheapest" },
  { id: "claude-opus-5-5", label: "Opus 5.5", note: "slower, at about twice the price" },
  { id: "claude-fable-5-1", label: "Fable 5.1", note: "the strongest, at about five times the price" },
] as const;
export type ModelId = (typeof MODELS)[number]["id"];

export function isModel(id: unknown): id is ModelId {
  return MODELS.some((m) => m.id === id);
}

export const MODEL: ModelId = isModel(process.env.WOODCHUCK_MODEL) ? process.env.WOODCHUCK_MODEL : "claude-sonnet-5-5";

export type { Effort } from "./route.js";
/**
 * How hard Claude thinks before it answers. It's the request's own level and
 * never changes mid-chat, since that would restart the cache. A turn that
 * needs less thought lowers it with an effort message instead.
 */
export const EFFORT: Effort = isEffort(process.env.WOODCHUCK_EFFORT) ? process.env.WOODCHUCK_EFFORT : "high";

/** The beta that lets a message in the chat change the effort from there on. */
export const EFFORT_MESSAGE_BETA = "mid-conversation-output-config-2026-07-01";

/**
 * A message that changes how hard Claude thinks from the next user turn on,
 * until another one changes it again. It carries no words, so it can sit
 * anywhere in the chat, and it leaves the cache and earlier thinking intact.
 */
export function effortMessage(effort: Effort): Anthropic.Beta.BetaMessageParam {
  return { role: "system", content: [], output_config: { effort } };
}

/** The level an effort message sets, or null for any other message. */
export function effortOf(message: Anthropic.Beta.BetaMessageParam): Effort | null {
  const effort = message.role === "system" ? message.output_config?.effort : null;
  return isEffort(effort) ? effort : null;
}

/**
 * The level Claude's next reply is written at: the latest effort message the
 * API is sent, or the request's own level without one. A summary drops the
 * effort messages before it, so only the summary onwards counts.
 */
export function effortInForce(messages: Anthropic.Beta.BetaMessageParam[], requestLevel: Effort = EFFORT): Effort {
  const sent = sendable(messages);
  for (let i = sent.length - 1; i >= 0; i--) {
    const effort = effortOf(sent[i]!);
    if (effort) return effort;
  }
  return requestLevel;
}

/**
 * The chat size, in tokens, at which the API summarises the older turns.
 * The API's floor is 50,000. "off" sends the whole chat every time.
 */
export function compactAt(value = process.env.WOODCHUCK_COMPACT_AT): number | null {
  if (value === "off") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.max(50_000, Math.round(n)) : 100_000;
}

/** What the summary keeps. It replaces the API's own summarising prompt. */
export const SUMMARY_INSTRUCTIONS = `Summarise this furniture design conversation so Claude can carry on from it without the earlier turns.

Keep:
- what the woodworker is making, what for, and where it will go
- every requirement, preference and constraint they gave, in their own words where it matters: sizes they asked for, materials, timber, finishes, joints, tools they have or lack, budget
- decisions made, with the reason, and anything they turned down
- the plan they agreed, questions still open, and anything Claude said it would do next
- tool requests and what is waiting on them
- roughly when each thing came up (early, middle or recent), so the detail can be looked up later

Leave out the design's current numbers, parts, joints and finishes. The design is always available through get_design and is the record of what exists. Leave out tool call details and pictures.`;

/** The part of the chat the API still needs: from the latest summary onwards. */
export function sendable(messages: Anthropic.Beta.BetaMessageParam[]): Anthropic.Beta.BetaMessageParam[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const c = messages[i]!.content;
    if (messages[i]!.role === "assistant" && Array.isArray(c) && c.some((b) => b.type === "compaction")) return messages.slice(i);
  }
  return messages;
}
const NO_KEY = "Claude couldn't sign in. Put your Anthropic API key in .env as ANTHROPIC_API_KEY and restart the app.";

/** Whether the SDK has a key or token to use. */
export function hasCredentials(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);
}
const MAX_ROUNDS = 60;

/**
 * How long to wait before each new try when a request to Claude fails on
 * the way, such as a dropped connection. The SDK only retries a request
 * that never got going, so a reply cut off mid-stream is tried again here.
 */
export const RETRY_DELAYS_MS = [1_000, 4_000] as const;

/** A network error underneath, such as a socket closing mid-reply. */
const DROPPED = /terminated|socket|network|connection|closed|ECONN|ETIMEDOUT|EPIPE|EAI_AGAIN|UND_ERR/i;

/**
 * Whether a failed request is worth sending again: a dropped connection or
 * time-out, an overloaded API (529) or a server error (5xx). A refusal, a
 * bad key or a rate limit is never tried again.
 */
export function transient(e: unknown): boolean {
  if (e instanceof Anthropic.APIUserAbortError) return false;
  if (e instanceof Anthropic.APIConnectionError) return true;
  if (e instanceof Anthropic.APIError) {
    // An error event mid-stream has no status, only its type.
    if (e.status === undefined) return e.type === "overloaded_error" || e.type === "api_error";
    return e.status >= 500;
  }
  // A connection that drops mid-reply reaches here as the SDK's plain error, with the network's own error as its cause.
  if (e instanceof Anthropic.AnthropicError) {
    const cause = (e as { cause?: { message?: unknown; code?: unknown } }).cause;
    return !!cause && DROPPED.test(`${String(cause.message ?? "")} ${String(cause.code ?? "")}`);
  }
  return false;
}

export interface TurnEvents {
  chat(item: ChatItem): void;
  delta(id: string, text: string): void;
  changed(): void;
}

export type ImageType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";
export type AttachmentType = ImageType | "application/pdf";

/**
 * Anthropic's own web tools. They run on Anthropic's servers and only read
 * pages: a search, or a page whose address is already in the conversation.
 * They can't touch the design; anything Claude learns comes back as a part
 * proposal you approve. The search looks in your workshop's country, or
 * anywhere when it names none.
 */
export function webTools(country: string | null) {
  return [
    { type: "web_search_20260209", name: "web_search", max_uses: 5, ...(country ? { user_location: { type: "approximate", country } } : {}) },
    { type: "web_fetch_20260209", name: "web_fetch", max_uses: 6, max_content_tokens: 30000 },
  ] as const;
}

const EMPTY_LIBRARY: LibraryAccess = {
  list: () => [],
  get: () => undefined,
  propose: () => {
    throw new Error("The parts library isn't available here");
  },
};

export interface TurnInput {
  text: string;
  selection: string[];
  /** Photos, sketches or PDF spec sheets, already stored in the project. */
  images?: { media_type: AttachmentType; data: string; name: string }[];
  /** Spots the woodworker pinned on the model. */
  pins?: Pin[];
  /** A picture of the model from the woodworker's camera, already stored. */
  view?: { media_type: ImageType; data: string; name: string };
  /**
   * Chat lines already shown, for messages sent while the last turn worked
   * that it didn't take in. The turn starts with them instead of a new line.
   */
  queued?: string[];
}

const fmtMm = (v: number) => String(Math.round(v * 10) / 10);

/** The pins as Claude reads them. */
export function describePins(pins: Pin[]): string {
  return pins
    .map((p) => `pin ${p.n} on ${p.part}, ${p.face} face, at x ${fmtMm(p.point_mm[0])}, y ${fmtMm(p.point_mm[1])}, z ${fmtMm(p.point_mm[2])} mm`)
    .join("; ");
}

/** The parts of the SDK client a turn uses, so tests can pass a fake. */
export interface MessagesClient {
  stream(body: Anthropic.Beta.MessageCreateParamsStreaming): {
    on(event: "text" | "thinking", cb: (delta: string) => void): unknown;
    finalMessage(): Promise<Anthropic.Beta.BetaMessage>;
    abort(): void;
  };
}

export function defaultClient(): MessagesClient {
  const client = new Anthropic();
  return { stream: (body) => client.beta.messages.stream(body) };
}

const now = () => new Date().toISOString();
let seq = 0;
const nextId = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

/** The chat line for a message from the woodworker, marked when it was sent while Claude worked. */
export function userLine(input: TurnInput, during = false): ChatItem & { kind: "user" } {
  const images = input.images ?? [];
  return {
    id: nextId("u"),
    kind: "user",
    text: input.text,
    selection: input.selection,
    at: now(),
    ...(images.length ? { images: images.map((i) => i.name) } : {}),
    ...(input.pins?.length ? { pins: input.pins } : {}),
    ...(input.view ? { view: input.view.name } : {}),
    ...(during ? { during: true as const } : {}),
  };
}

/** The pictures sent with a message, attachments first and the woodworker's own view last, nearest the words. */
function pictures(input: TurnInput): Anthropic.Beta.BetaContentBlockParam[] {
  const out: Anthropic.Beta.BetaContentBlockParam[] = (input.images ?? []).map((img) =>
    img.media_type === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: img.data } }
      : { type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } },
  );
  if (input.view) out.push({ type: "image", source: { type: "base64", media_type: input.view.media_type, data: input.view.data } });
  return out;
}

/** What the woodworker pointed at with a message: the selection, the pins and their view. */
function pointedAt(input: TurnInput): string {
  const sel = input.selection.length ? `\n\n(Selected in the app: ${input.selection.join(", ")})` : "";
  const pins = input.pins?.length ? `\n\n(Pinned in the app: ${describePins(input.pins)}.)` : "";
  const view = input.view
    ? "\n\n(The last picture is the woodworker's view of the model right now. Selected parts are blue and pins are numbered red dots.)"
    : "";
  return `${sel}${pins}${view}`;
}

/** Your edits as Claude reads them. A long run, such as trying colours, is summed up rather than listed. */
function editList(notes: string[]): string {
  const kept = notes.length > 12 ? [`made ${notes.length - 10} other changes`, ...notes.slice(-10)] : notes;
  return kept.join("; ");
}

/**
 * The messages Claude didn't take in before its turn ended, as the next
 * turn's input. Several are joined into one. A preview that was waiting
 * is left unapplied, the same as any other reply to it.
 */
export function followUp(project: Project): TurnInput | null {
  const queued = project.queued.splice(0);
  if (!queued.length) return null;
  const inputs = queued.map((q) => q.input);
  let text = inputs.map((i) => i.text).join("\n\n");
  if (project.pending?.waiting.some((w) => w.kind === "preview")) {
    const preview = [...project.chat].reverse().find((c) => c.kind === "preview" && c.status === "proposed");
    if (preview?.kind === "preview") preview.status = "not_applied";
    text += "\n\n(The preview wasn't applied.)";
  }
  const view = inputs.findLast((i) => i.view)?.view;
  return {
    text,
    selection: [...new Set(inputs.flatMap((i) => i.selection))],
    images: inputs.flatMap((i) => i.images ?? []),
    pins: inputs.flatMap((i) => i.pins ?? []),
    ...(view ? { view } : {}),
    queued: queued.map((q) => q.item),
  };
}

/** The tools that end the turn until the woodworker replies, and what each waits for. */
const WAITING_TOOLS: Record<string, Pending["waiting"][number]["kind"]> = {
  ask_user: "question",
  submit_plan: "plan",
  propose_library_part: "part",
  preview_change: "preview",
};

/**
 * Tool results in the order Claude made the calls, in its latest reply.
 * Results held from a reply that waited on the woodworker are joined by the
 * answers to its waiting calls, which can sit anywhere among the others.
 */
function inCallOrder(messages: Anthropic.Beta.BetaMessageParam[], results: Anthropic.Beta.BetaToolResultBlockParam[]) {
  const last = messages.findLast((m) => m.role === "assistant");
  const ids = Array.isArray(last?.content) ? last.content.flatMap((b) => (b.type === "tool_use" ? [b.id] : [])) : [];
  const at = (r: Anthropic.Beta.BetaToolResultBlockParam) => {
    const i = ids.indexOf(r.tool_use_id);
    return i < 0 ? ids.length : i;
  };
  return [...results].sort((a, b) => at(a) - at(b));
}

/**
 * Whether the API left out thinking from earlier in the chat because the
 * instructions, tools or workshop changed since. Other kinds of entry, such
 * as thinking from another model, are ignored.
 */
export function droppedStaleThinking(message: Anthropic.Beta.BetaMessage): boolean {
  const changes = (message as { input_transformations?: { type?: unknown; reason?: unknown }[] }).input_transformations;
  return Array.isArray(changes) && changes.some((c) => c?.type === "thinking_dropped" && c.reason === "prefix_binding_mismatch");
}

function toolSummary(name: string, input: Record<string, unknown>): string {
  const id = input.id ?? input.name ?? input.target ?? "";
  switch (name) {
    case "measure":
      return `measure ${String(input.from)} to ${String(input.to)}`;
    case "render_views":
      return `render ${((input.views as string[] | undefined) ?? ["front", "top", "left", "iso"]).join(", ")}`;
    case "ask_user":
      return "ask you";
    case "submit_plan":
      return "submit a plan";
    case "apply_edits": {
      const n = Array.isArray(input.edits) ? input.edits.length : 0;
      return n ? `apply ${n} edit${n === 1 ? "" : "s"}` : "apply edits";
    }
    default:
      return `${name.replace(/_/g, " ")}${id ? ` ${String(id)}` : ""}`;
  }
}

/**
 * The edits a reply's apply_edits calls listed, or null when it made none.
 * One apply_edits call is one tool call however many edits it carries, so
 * the edits are counted apart.
 */
export function editsIn(calls: readonly { name: string; input: unknown }[]): number | null {
  const batches = calls.filter((c) => c.name === "apply_edits");
  if (!batches.length) return null;
  return batches.reduce((sum, c) => {
    const edits = (c.input as { edits?: unknown } | null)?.edits;
    return sum + (Array.isArray(edits) ? edits.length : 0);
  }, 0);
}

export class Turn {
  private stream: ReturnType<MessagesClient["stream"]> | null = null;
  private stopped = false;
  /** Cuts short the wait before a new try, so Stop never waits on it. */
  private wake: (() => void) | null = null;
  /** Tool calls this turn, for saying how far it got. */
  private steps = 0;
  /** Whether this turn has logged thinking the API left out. */
  private droppedThinking = false;
  /** Whether this turn picks its own level, read once a turn. */
  private routing = false;
  /** The level this turn wants Claude at, which only rises during the turn. */
  private effort: Effort = EFFORT;
  /** Each request this turn that Claude replied to, in order: its level, timing, tokens and tool calls. */
  private readonly rounds: RoundTiming[] = [];
  /** Which rule picked the turn's starting level. */
  private route: Route | null = null;

  /** The level each request this turn was written at, one per reply, in order. */
  roundEfforts(): readonly Effort[] {
    return this.rounds.map((r) => r.effort);
  }

  constructor(
    private store: Store,
    private client: MessagesClient,
    private events: TurnEvents,
    private renderPng: (project: Project, views: ViewName[], opts: { highlight?: string[]; isolate?: string[]; xray?: boolean }) => Buffer,
    private library: LibraryAccess = EMPTY_LIBRARY,
    /** Tests pass no waits. */
    private retryDelaysMs: readonly number[] = RETRY_DELAYS_MS,
    /** Milliseconds, for timing the turn. Tests pass a fake. */
    private clock: () => number = () => performance.now(),
  ) {}

  stop() {
    this.stopped = true;
    this.stream?.abort();
    this.wake?.();
  }

  async run(input: TurnInput): Promise<void> {
    const started = this.clock();
    const project = this.store.project;
    // Messages sent while the last turn worked are already in the chat, and move down to where this turn reads them.
    const queued = input.queued ?? [];
    if (queued.length) {
      project.markTaken(queued, "turn");
      this.events.changed();
    } else {
      const line = userLine(input);
      project.addChat(line);
      this.events.chat(line);
    }
    const job: Job = { id: queued[0] ?? project.chat.at(-1)!.id, after: project.chat.at(-1)!.id, started_at: now() };
    project.job = job;

    // How hard Claude thinks this turn, read from the message and what was waiting on it.
    this.routing = effortRouting();
    if (this.routing) {
      this.route = routeTurn(
        {
          text: input.text,
          attachments: input.images?.length ?? 0,
          waiting: project.pending?.waiting.map((w) => w.kind) ?? [],
          emptyDesign: project.design.parts.length === 0,
        },
        EFFORT,
      );
      this.effort = this.route.effort;
    }

    // A reply to a question, plan, part or preview answers the tool calls that were waiting.
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    // A message sent while Claude worked can be what answers its plan or question, so both cards and Claude are told.
    let answering = "";
    if (project.pending) {
      const answers = project.pending.waiting.map((w): Anthropic.Beta.BetaToolResultBlockParam => ({ type: "tool_result", tool_use_id: w.tool_use_id, content: input.text }));
      content.push(...inCallOrder(project.messages, [...project.pending.held, ...answers]));
      // Only what's waiting is answered. A reply cut off mid-tool call waits
      // on nothing, so its next message leaves every card as it was.
      const asked = project.pending.waiting.filter((w) => w.kind === "plan" || w.kind === "question").map((w) => w.kind);
      for (const item of project.chat) {
        if (asked.includes("question") && item.kind === "question" && item.answered === undefined) {
          item.answered = input.text;
          if (queued.length) item.answered_by = queued[0]!;
        }
      }
      if (queued.length && asked.length) {
        const plan = asked.includes("plan") ? project.chat.findLast((c) => c.kind === "plan") : undefined;
        if (plan?.kind === "plan") {
          plan.answered = input.text;
          plan.answered_by = queued[0]!;
        }
        answering = ` It's taken as their reply to your ${asked.includes("plan") ? "plan" : "question"}, though they may not have seen it yet. If it doesn't answer it, ask again.`;
      }
      project.pending = null;
    }
    // Claude only sees the design through tools, so say what changed by hand.
    const notes = project.notes.length ? `\n\n(Since your last turn the woodworker ${editList(project.notes)}. Read the design again before editing.)` : "";
    project.notes = [];
    const news = project.news.length ? `\n\n(News since your last turn: ${project.news.join("; ")}.)` : "";
    project.news = [];
    const late = queued.length ? `\n\n(The woodworker sent this while you were still working.${answering})` : "";
    // Pictures go before the words that refer to them.
    content.push(...pictures(input));
    content.push({ type: "text", text: `${input.text}${pointedAt(input)}${late}${notes}${news}` });
    this.say(project, content);
    project.save();

    project.beginChange("claude", input.text.length > 60 ? `${input.text.slice(0, 57)}...` : input.text);
    const ctx: ToolContext = {
      library: this.library,
      design: () => project.design,
      apply: (op) => {
        const d = project.apply([op]);
        this.events.changed();
        return d;
      },
      requestTool: (req) => {
        const r = this.store.addToolRequest(req);
        return { id: r.id, count: r.count };
      },
      renderPng: (views, opts) => this.renderPng(project, views, opts),
      chat: () => project.chat,
    };

    let usage = { input: 0, cached: 0, written: 0, output: 0 };
    // Timing and counts only, for seeing where a turn's time goes.
    const model = project.model ?? MODEL;
    let toolMs = 0;
    const compactTrigger = compactAt();
    // Read once a turn, so a change to the workshop never splits the cache mid-turn.
    const workshop = this.store.workshop();
    const system = systemPrompt(workshop);
    const tools = [...TOOLS, ...webTools(searchCountry(workshop))];
    try {
      for (let round = 0; round < MAX_ROUNDS && !this.stopped; round++) {
        const sent = sendable(project.messages);
        // The level this request is written at, kept with its round.
        const effort = effortInForce(project.messages);
        const { message, timing } = await this.ask(project, {
          // Switching models mid-conversation is fine: other models skip the
          // earlier thinking blocks, and the history stays append-only.
          model: project.model ?? MODEL,
          max_tokens: 64000,
          // Tools render first, then the system blocks, so the breakpoint on
          // the workshop block caches all of them. The top-level breakpoint
          // caches the history.
          system,
          tools,
          messages: sent,
          // Each thinking block is tied to the instructions, tools and chat
          // it came from. A changed prompt, tool list or workshop would
          // otherwise refuse an open chat, so the API drops the thinking
          // that no longer fits instead, on every request that carries it.
          thinking: { type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } },
          // The request's own level stays the same all chat long, so the
          // cache holds. Effort messages in the chat lower or raise it.
          output_config: { effort: EFFORT },
          cache_control: { type: "ephemeral" },
          ...(compactTrigger
            ? {
                context_management: {
                  edits: [{ type: "compact_20260112", trigger: { type: "input_tokens", value: compactTrigger }, instructions: SUMMARY_INSTRUCTIONS }],
                },
              }
            : {}),
          // If a safety check declines the request, the API retries it on
          // a fallback model instead of stopping.
          betas: [
            "server-side-fallback-2026-07-01",
            "thinking-binding-controls-2026-08-01",
            ...(compactTrigger ? ["compact-2026-01-12"] : []),
            // Sent whenever the chat holds an effort message, which stays
            // true after routing is turned off.
            ...(sent.some((m) => effortOf(m)) ? [EFFORT_MESSAGE_BETA] : []),
          ],
          fallbacks: "default",
        } as Anthropic.Beta.MessageCreateParamsStreaming);
        if (!this.droppedThinking && droppedStaleThinking(message)) {
          this.droppedThinking = true;
          console.log("Claude's earlier thinking no longer matched its instructions, tools or workshop, so the API left it out.");
        }
        // The summary's own cost is reported apart from the reply's.
        const parts = [message.usage, ...(message.usage.iterations ?? []).filter((i) => i.type === "compaction")];
        const spent = { input: 0, cached: 0, written: 0, output: 0 };
        for (const u of parts) {
          spent.input += u.input_tokens ?? 0;
          spent.cached += u.cache_read_input_tokens ?? 0;
          spent.written += u.cache_creation_input_tokens ?? 0;
          spent.output += u.output_tokens ?? 0;
        }
        usage = {
          input: usage.input + spent.input,
          cached: usage.cached + spent.cached,
          written: usage.written + spent.written,
          output: usage.output + spent.output,
        };
        const compacted = message.content.some((b) => b.type === "compaction");
        const replyCalls = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
        const edits = editsIn(replyCalls);
        this.rounds.push({
          effort,
          ...timing,
          ...spent,
          calls: replyCalls.length,
          ...(edits === null ? {} : { edits }),
          ...(compacted ? { compacted: true as const } : {}),
        });
        project.messages.push({ role: "assistant", content: message.content as Anthropic.Beta.BetaContentBlockParam[] });
        project.save();
        if (compacted) {
          const item: ChatItem = { id: nextId("s"), kind: "summary", at: now() };
          project.addChat(item);
          this.events.chat(item);
        }

        if (message.stop_reason === "refusal") {
          this.fail(project, job, "Claude declined that request, so nothing more was changed.", false);
          break;
        }
        const calls = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
        if (message.stop_reason === "max_tokens" && calls.length) {
          // The last call may be half written, so none of them run. Each still
          // needs a result, or the next request is refused, so the results
          // wait to go in with the woodworker's next message.
          const held = calls.map((c): Anthropic.Beta.BetaToolResultBlockParam => ({
            type: "tool_result",
            tool_use_id: c.id,
            content: "Not run: your reply was cut off before its tool calls were complete.",
            is_error: true,
          }));
          project.pending = { held, waiting: [] };
          project.save();
          this.fail(project, job, "Claude's reply was cut off mid-tool call, so its tool calls didn't run. Ask it to carry on.");
          break;
        }
        if (message.stop_reason === "pause_turn") continue;
        if (!calls.length) break;

        const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
        const waiting: { tool_use_id: string; kind: "question" | "plan" | "part" | "preview" }[] = [];
        // Show what Claude looked up on the web.
        for (const b of message.content) {
          if (b.type !== "server_tool_use") continue;
          const inp = (b.input ?? {}) as { query?: string; url?: string };
          // The web tools filter what they find by running code on Anthropic's side.
          const summary =
            b.name === "web_search"
              ? `search the web for "${inp.query ?? ""}"`
              : b.name === "web_fetch"
                ? `read ${inp.url ?? "a page"}`
                : "sift what it found";
          const item: ChatItem = { id: nextId("w"), kind: "tool", name: b.name, summary, is_error: false, at: now() };
          this.steps++;
          project.addChat(item);
          this.events.chat(item);
        }
        // A reply can carry many calls. They run in order, so a call can use
        // what an earlier one added, and a failed call doesn't stop the rest.
        // Calls after a waiting tool still run, and the turn waits once the
        // reply is done. Only one of each kind of wait can be open, since the
        // woodworker's one reply answers it.
        for (const call of calls) {
          const input = (call.input ?? {}) as Record<string, unknown>;
          // Every call must get a result, or the next request is refused.
          let out: ReturnType<typeof runTool>;
          const waits = WAITING_TOOLS[call.name];
          if (waits && waiting.some((w) => w.kind === waits)) {
            out = { content: `Not run: this reply already calls ${call.name}, and the woodworker answers one at a time. Call it again after they reply.`, isError: true };
          } else {
            const ran = this.clock();
            try {
              out = runTool(call.name, input, ctx);
            } catch (e) {
              out = { content: `The tool failed: ${(e as Error).message}`, isError: true };
            }
            toolMs += this.clock() - ran;
          }
          let image: string | undefined;
          if (Array.isArray(out.content)) {
            const img = out.content.find((b) => b.type === "image");
            if (img && img.type === "image" && img.source.type === "base64") {
              image = project.saveRender(Buffer.from(img.source.data, "base64"));
            }
          }
          const item: ChatItem = {
            id: nextId("x"),
            kind: "tool",
            name: call.name,
            summary: out.isError ? `${toolSummary(call.name, input)}: ${out.chatLine ?? String(out.content)}` : toolSummary(call.name, input),
            is_error: !!out.isError,
            at: now(),
            ...(image ? { image } : {}),
          };
          this.steps++;
          project.addChat(item);
          this.events.chat(item);
          // A missing tool gets its own card, so it can't be missed in the chat.
          if (call.name === "request_tool" && !out.isError && out.requestId) {
            const card: ChatItem = { id: nextId("m"), kind: "tool_request", request: out.requestId, at: now() };
            project.addChat(card);
            this.events.chat(card);
          }
          if (out.example) {
            const card: ChatItem = { id: nextId("j"), kind: "example", joint: out.example.joint, at: now(), ...(out.example.note ? { note: out.example.note } : {}) };
            project.addChat(card);
            this.events.chat(card);
          }
          if (out.waitFor) {
            waiting.push({ tool_use_id: call.id, kind: out.waitFor.kind });
            let w: ChatItem;
            if (out.waitFor.kind === "preview") {
              const { title, explanation, ops } = out.waitFor;
              w = { id: nextId("v"), kind: "preview", title, explanation, ops, status: "proposed", at: now() };
            } else if (out.waitFor.kind === "part") {
              w = { id: nextId("r"), kind: "part", proposal: out.waitFor.proposal, part: out.waitFor.part, status: "proposed", at: now() };
            } else if (out.waitFor.kind === "question") {
              w = { id: nextId("q"), kind: "question", question: out.waitFor.question, options: out.waitFor.options, at: now() };
            } else {
              // A picture of the draft as it stood when the plan was pinned.
              let drawing: string | undefined;
              const drew = this.clock();
              try {
                drawing = project.saveRender(this.renderPng(project, ["iso", "front"], {}));
              } catch {
                drawing = undefined;
              }
              toolMs += this.clock() - drew;
              w = { id: nextId("p"), kind: "plan", plan: project.design.plan!, at: now(), ...(drawing ? { image: drawing } : {}) };
            }
            project.addChat(w);
            this.events.chat(w);
            continue;
          }
          results.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: out.content,
            ...(out.isError ? { is_error: true } : {}),
          });
        }
        if (waiting.length) {
          project.pending = { held: results, waiting };
          project.save();
          break;
        }
        // A call that needs judgement puts Claude back at the full level for the rest of the turn.
        if (this.routing && needsJudgement([...calls.map((c) => c.name), ...message.content.flatMap((b) => (b.type === "server_tool_use" ? [b.name] : []))])) {
          this.effort = atLeast(this.effort, EFFORT);
        }
        // Tool results come first, then anything said or changed while Claude worked.
        this.say(project, [...results, ...this.takeIn(project)]);
        project.save();
      }
      if (this.stopped) this.halt(project, job);
    } catch (e) {
      if (this.stopped) {
        this.halt(project, job);
      } else if (e instanceof Anthropic.AuthenticationError) {
        this.fail(project, job, NO_KEY);
      } else if (e instanceof Anthropic.RateLimitError) {
        this.fail(project, job, "Claude is rate limited right now. Try again in a minute.");
      } else if (e instanceof Anthropic.APIError) {
        this.fail(project, job, `Claude's API returned an error (${e.status ?? "no status"}): ${e.message}`);
      } else if (/authentication method|api ?key/i.test((e as Error).message)) {
        this.fail(project, job, NO_KEY);
      } else {
        this.fail(project, job, `Something went wrong: ${(e as Error).message}`);
      }
    } finally {
      this.stream = null;
      job.ended_at = now();
      const usageItem: ChatItem = {
        id: nextId("n"),
        kind: "usage",
        ...usage,
        at: now(),
        model,
        ...(this.route ? { route: this.route.reason } : {}),
        ms: Math.round(this.clock() - started),
        tool_ms: Math.round(toolMs),
        rounds: [...this.rounds],
      };
      project.addChat(usageItem);
      this.events.chat(usageItem);
      project.endChange();
      project.save();
      this.events.changed();
    }
  }

  /**
   * Adds a user message to the chat. When the turn wants a level other than
   * the one in force, an effort message goes in just before it, so Claude's
   * reply to it is written at the new level. Nothing earlier changes.
   */
  private say(project: Project, content: Anthropic.Beta.BetaContentBlockParam[]) {
    if (effortInForce(project.messages) !== this.effort) project.messages.push(effortMessage(this.effort));
    project.messages.push({ role: "user", content });
  }

  /**
   * What the woodworker said and changed while Claude worked, to go in after
   * this step's tool results. The history only grows, so nothing earlier is
   * edited to fit it in.
   */
  private takeIn(project: Project): Anthropic.Beta.BetaContentBlockParam[] {
    const out: Anthropic.Beta.BetaContentBlockParam[] = [];
    const queued = project.queued.splice(0);
    for (const { input } of queued) {
      // A message mid-turn can raise the level, never lower it.
      if (this.routing) {
        const route = routeTurn({ text: input.text, attachments: input.images?.length ?? 0, waiting: [], emptyDesign: project.design.parts.length === 0 }, EFFORT);
        this.effort = atLeast(this.effort, route.effort);
      }
      out.push(...pictures(input));
      out.push({
        type: "text",
        text: `(While you were working, the woodworker said: "${input.text}" Take it in from here. If it changes your plan, say so in a line.)${pointedAt(input)}`,
      });
    }
    if (project.notes.length) {
      out.push({ type: "text", text: `(While you were working, the woodworker ${editList(project.notes)}. Read the design again before editing those parts.)` });
      project.notes = [];
    }
    if (queued.length) {
      project.markTaken(
        queued.map((q) => q.item),
        "step",
      );
      this.events.changed();
    }
    return out;
  }

  /**
   * One request to Claude, streamed into the chat as it comes. A dropped
   * connection, or an overloaded or failing API, is tried again after a
   * short wait. Nothing was added to the history, so the same request is
   * safe to send again, and what the failed try streamed leaves the chat.
   */
  private async ask(
    project: Project,
    body: Anthropic.Beta.MessageCreateParamsStreaming,
  ): Promise<{ message: Anthropic.Beta.BetaMessage; timing: Pick<RoundTiming, "ttft_ms" | "ms" | "retries"> }> {
    const first = this.clock();
    for (let attempt = 0; ; attempt++) {
      const live: { text?: ChatItem & { kind: "assistant" }; thinking?: ChatItem & { kind: "thinking" } } = {};
      const sent = this.clock();
      let firstEvent: number | null = null;
      const stream = (this.stream = this.client.stream(body));
      stream.on("thinking", (delta) => {
        firstEvent ??= this.clock();
        if (!live.thinking) {
          live.thinking = { id: nextId("t"), kind: "thinking", text: "", at: now() };
          project.addChat(live.thinking);
          this.events.chat(live.thinking);
        }
        live.thinking.text += delta;
        this.events.delta(live.thinking.id, delta);
      });
      stream.on("text", (delta) => {
        firstEvent ??= this.clock();
        if (!live.text) {
          live.text = { id: nextId("a"), kind: "assistant", text: "", at: now(), streaming: true };
          project.addChat(live.text);
          this.events.chat(live.text);
        }
        live.text.text += delta;
        this.events.delta(live.text.id, delta);
      });
      try {
        const message = await stream.finalMessage();
        // Set inside the stream callbacks, which the compiler can't follow.
        const ttft = firstEvent as number | null;
        return {
          message,
          timing: {
            ttft_ms: ttft === null ? null : Math.round(ttft - sent),
            ms: Math.round(this.clock() - first),
            ...(attempt ? { retries: attempt } : {}),
          },
        };
      } catch (e) {
        const wait = this.retryDelaysMs[attempt];
        if (this.stopped || wait === undefined || !transient(e)) throw e;
        // The next try streams its own thinking and words, so the cut-off ones go.
        const partial = [live.text?.id, live.thinking?.id];
        project.chat = project.chat.filter((c) => !partial.includes(c.id));
        const why = e instanceof Anthropic.APIConnectionError || !(e instanceof Anthropic.APIError) ? "The connection to Claude dropped" : "Claude's API is busy";
        this.error(project, `${why}, so Woodchuck is trying again (${attempt + 1} of ${this.retryDelaysMs.length}).`, true);
        this.events.changed();
        await this.pause(wait);
        if (this.stopped) throw e;
      } finally {
        this.stream = null;
        // However the reply ends, it's no longer being typed.
        if (live.text) delete live.text.streaming;
      }
    }
  }

  /** Waits before a new try, or until Stop. */
  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.stopped) return resolve();
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  /** Ends the turn on Stop. */
  private halt(project: Project, job: Job) {
    job.stopped = true;
    this.error(project, "Stopped.");
    project.news.push(`your last turn was stopped by the woodworker after ${this.stepCount()}, so it may have left work half done. Read the design and finish what was left, if the woodworker wants`);
  }

  /**
   * Ends the turn on an error, and records it on the job so other apps
   * hear it stopped early. The next turn is told, unless Claude already
   * knows why, as it does when it declined.
   */
  private fail(project: Project, job: Job, text: string, tellNext = true) {
    job.error = text;
    this.error(project, text);
    if (tellNext) {
      project.news.push(
        `your last turn stopped early with an error after ${this.stepCount()}, so it may have left work half done (${text.replace(/\.$/, "")}). Read the design and finish what was left, if the woodworker wants`,
      );
    }
  }

  private stepCount() {
    return `${this.steps} step${this.steps === 1 ? "" : "s"}`;
  }

  private error(project: Project, text: string, retry = false) {
    const item: ChatItem = { id: nextId("e"), kind: "error", text, at: now(), ...(retry ? { retry: true as const } : {}) };
    project.addChat(item);
    this.events.chat(item);
  }
}
