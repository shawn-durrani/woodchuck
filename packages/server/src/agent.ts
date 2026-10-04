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
// The whole chat stays on disk, and recall_chat searches it.

import Anthropic from "@anthropic-ai/sdk";
import type { ViewName } from "@woodchuck/core";
import { systemPrompt } from "./prompt.js";
import type { ChatItem, Job, Pin, Project, Store } from "./store.js";
import { runTool, TOOLS, type LibraryAccess, type ToolContext } from "./tools.js";
import { searchCountry } from "./workshop.js";

/** Models the chat can use. All take the same request: adaptive thinking, effort and fallbacks. */
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

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
/** How hard Claude thinks before it answers. */
export const EFFORT: Effort = (EFFORTS as readonly string[]).includes(process.env.WOODCHUCK_EFFORT ?? "") ? (process.env.WOODCHUCK_EFFORT as Effort) : "high";

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
    default:
      return `${name.replace(/_/g, " ")}${id ? ` ${String(id)}` : ""}`;
  }
}

export class Turn {
  private stream: ReturnType<MessagesClient["stream"]> | null = null;
  private stopped = false;

  constructor(
    private store: Store,
    private client: MessagesClient,
    private events: TurnEvents,
    private renderPng: (project: Project, views: ViewName[], opts: { highlight?: string[]; isolate?: string[]; xray?: boolean }) => Buffer,
    private library: LibraryAccess = EMPTY_LIBRARY,
  ) {}

  stop() {
    this.stopped = true;
    this.stream?.abort();
  }

  async run(input: TurnInput): Promise<void> {
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

    // A reply to a question, plan, part or preview answers the tool calls that were waiting.
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    if (project.pending) {
      content.push(...project.pending.held);
      for (const w of project.pending.waiting) {
        content.push({ type: "tool_result", tool_use_id: w.tool_use_id, content: input.text });
      }
      for (const item of project.chat) {
        if (item.kind === "question" && item.answered === undefined) item.answered = input.text;
      }
      project.pending = null;
    }
    // Claude only sees the design through tools, so say what changed by hand.
    const notes = project.notes.length ? `\n\n(Since your last turn the woodworker ${editList(project.notes)}. Read the design again before editing.)` : "";
    project.notes = [];
    const news = project.news.length ? `\n\n(News since your last turn: ${project.news.join("; ")}.)` : "";
    project.news = [];
    const late = queued.length ? "\n\n(The woodworker sent this while you were still working.)" : "";
    // Pictures go before the words that refer to them.
    content.push(...pictures(input));
    content.push({ type: "text", text: `${input.text}${pointedAt(input)}${late}${notes}${news}` });
    project.messages.push({ role: "user", content });
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
    const compactTrigger = compactAt();
    // Read once a turn, so a change to the workshop never splits the cache mid-turn.
    const workshop = this.store.workshop();
    const system = systemPrompt(workshop);
    const tools = [...TOOLS, ...webTools(searchCountry(workshop))];
    try {
      for (let round = 0; round < MAX_ROUNDS && !this.stopped; round++) {
        const textId = nextId("a");
        let textItem: ChatItem | null = null;
        let thinkingItem: (ChatItem & { kind: "thinking" }) | null = null;
        this.stream = this.client.stream({
          // Switching models mid-conversation is fine: other models skip the
          // earlier thinking blocks, and the history stays append-only.
          model: project.model ?? MODEL,
          max_tokens: 64000,
          // Tools render first, then the system blocks, so the breakpoint on
          // the workshop block caches all of them. The top-level breakpoint
          // caches the history.
          system,
          tools,
          messages: sendable(project.messages),
          thinking: { type: "adaptive", display: "summarized" },
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
          betas: ["server-side-fallback-2026-07-01", ...(compactTrigger ? ["compact-2026-01-12"] : [])],
          fallbacks: "default",
        } as Anthropic.Beta.MessageCreateParamsStreaming);
        this.stream.on("thinking", (delta) => {
          if (!thinkingItem) {
            thinkingItem = { id: nextId("t"), kind: "thinking", text: "", at: now() };
            project.addChat(thinkingItem);
            this.events.chat(thinkingItem);
          }
          thinkingItem.text += delta;
          this.events.delta(thinkingItem.id, delta);
        });
        this.stream.on("text", (delta) => {
          if (!textItem) {
            textItem = { id: textId, kind: "assistant", text: "", at: now(), streaming: true };
            project.addChat(textItem);
            this.events.chat(textItem);
          }
          (textItem as { text: string }).text += delta;
          this.events.delta(textId, delta);
        });

        const message = await this.stream.finalMessage();
        this.stream = null;
        if (textItem) delete (textItem as { streaming?: boolean }).streaming;
        // The summary's own cost is reported apart from the reply's.
        const parts = [message.usage, ...(message.usage.iterations ?? []).filter((i) => i.type === "compaction")];
        for (const u of parts) {
          usage = {
            input: usage.input + (u.input_tokens ?? 0),
            cached: usage.cached + (u.cache_read_input_tokens ?? 0),
            written: usage.written + (u.cache_creation_input_tokens ?? 0),
            output: usage.output + (u.output_tokens ?? 0),
          };
        }
        project.messages.push({ role: "assistant", content: message.content as Anthropic.Beta.BetaContentBlockParam[] });
        project.save();
        if (message.content.some((b) => b.type === "compaction")) {
          const item: ChatItem = { id: nextId("s"), kind: "summary", at: now() };
          project.addChat(item);
          this.events.chat(item);
        }

        if (message.stop_reason === "refusal") {
          this.error(project, "Claude declined that request, so nothing more was changed.");
          break;
        }
        const calls = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
        if (message.stop_reason === "max_tokens" && calls.length) {
          this.error(project, "Claude's reply was cut off mid-tool call, so that call didn't run. Ask it to carry on.");
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
          project.addChat(item);
          this.events.chat(item);
        }
        for (const call of calls) {
          const input = (call.input ?? {}) as Record<string, unknown>;
          // Every call must get a result, or the next request is refused.
          let out: ReturnType<typeof runTool>;
          try {
            out = runTool(call.name, input, ctx);
          } catch (e) {
            out = { content: `The tool failed: ${(e as Error).message}`, isError: true };
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
            summary: out.isError ? `${toolSummary(call.name, input)}: ${String(out.content)}` : toolSummary(call.name, input),
            is_error: !!out.isError,
            at: now(),
            ...(image ? { image } : {}),
          };
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
              try {
                drawing = project.saveRender(this.renderPng(project, ["iso", "front"], {}));
              } catch {
                drawing = undefined;
              }
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
        // Tool results come first, then anything said or changed while Claude worked.
        project.messages.push({ role: "user", content: [...results, ...this.takeIn(project)] });
        project.save();
      }
      if (this.stopped) this.error(project, "Stopped.");
    } catch (e) {
      if (this.stopped) {
        this.error(project, "Stopped.");
      } else if (e instanceof Anthropic.AuthenticationError) {
        this.error(project, NO_KEY);
      } else if (e instanceof Anthropic.RateLimitError) {
        this.error(project, "Claude is rate limited right now. Try again in a minute.");
      } else if (e instanceof Anthropic.APIError) {
        this.error(project, `Claude's API returned an error (${e.status ?? "no status"}): ${e.message}`);
      } else if (/authentication method|api ?key/i.test((e as Error).message)) {
        this.error(project, NO_KEY);
      } else {
        this.error(project, `Something went wrong: ${(e as Error).message}`);
      }
    } finally {
      this.stream = null;
      job.ended_at = now();
      const usageItem: ChatItem = { id: nextId("n"), kind: "usage", ...usage, at: now() };
      project.addChat(usageItem);
      this.events.chat(usageItem);
      project.endChange();
      project.save();
      this.events.changed();
    }
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

  private error(project: Project, text: string) {
    const item: ChatItem = { id: nextId("e"), kind: "error", text, at: now() };
    project.addChat(item);
    this.events.chat(item);
  }
}
