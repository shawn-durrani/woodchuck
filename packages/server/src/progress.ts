// How Claude's current or last request is going, worked out from the chat
// at once. The server answers GET /api/progress with it, and the MCP server
// passes it on as a background block, so another app can watch a long build
// without waiting on it.

export type Item = { id: string; kind: string; [k: string]: unknown };

/** Everything in the chat after the item with this id, or the whole chat when it's gone. */
export function itemsAfter(chat: Item[], id: string | undefined): Item[] {
  const i = id ? chat.findIndex((c) => c.id === id) : -1;
  return i < 0 ? chat : chat.slice(i + 1);
}

/** A tool request as describe() needs it. */
export interface RequestInfo {
  id: string;
  name: string;
  status: string;
  issue_url?: string;
}

/** Where the woodworker finds a missing tool's card, and its buttons. */
const REQUEST_CARD = "the Missing tool card in the Woodchuck window's chat, also listed under Missing tools on the All designs and parts page in the design menu";

/**
 * What to do about a tool Claude asked for, in words another model can pass
 * on. Only the woodworker can file or copy it, from the Woodchuck window.
 */
export function requestLine(id: string, r: RequestInfo | undefined, repo: string | null): string {
  const head = `Woodchuck's Claude needs a tool the app doesn't have yet${r ? `, "${r.name}"` : ""} (tool request ${id}).`;
  if (r?.status === "built") return `${head} It has been built since, so once Woodchuck is updated the woodworker can ask Woodchuck's Claude to carry on.`;
  if (r?.issue_url) return `${head} It's filed as a GitHub issue for Claude Code to build: ${r.issue_url}. Once it's built, the woodworker can ask Woodchuck's Claude to carry on.`;
  const how = repo
    ? `the woodworker presses "File as a GitHub issue for Claude Code" on ${REQUEST_CARD}`
    : `the woodworker presses "Copy the spec" on ${REQUEST_CARD}, and pastes it into Claude Code`;
  return `${head} To get it built, ${how}. Nothing in this chat can file it or build it.`;
}

/** What describe() needs to say where things are. */
export interface DescribeContext {
  toolRequests?: RequestInfo[];
  /** The GitHub repository missing tools are filed in, or null while filing is off. */
  repo?: string | null;
}

/** What Woodchuck's Claude said and did, in words another model can pass on. */
export function describe(items: Item[], stillWorking: boolean, ctx: DescribeContext = {}): string {
  const out: string[] = [];
  let tools = 0;
  for (const c of items) {
    switch (c.kind) {
      case "assistant":
        if (String(c.text ?? "").trim()) out.push(String(c.text).trim());
        break;
      case "tool":
        tools++;
        break;
      case "question":
        out.push(`Woodchuck's Claude asks: ${String(c.question)}${(c.options as string[] | undefined)?.length ? ` (options: ${(c.options as string[]).join("; ")})` : ""}`);
        break;
      case "plan":
        out.push(
          `Woodchuck's Claude pinned a plan: ${String((c.plan as { summary?: string } | undefined)?.summary ?? "")}. ${c.answered_by ? "A message sent while it worked was taken as the reply." : 'Say "looks right" or what to change.'}`,
        );
        break;
      case "preview":
        if (c.status === "proposed") {
          out.push(
            `Woodchuck's Claude is showing a preview, "${String(c.title)}": ${String(c.explanation)} Nothing has changed yet. It's drawn on the model in the Woodchuck window; call woodchuck_picture with preview true to see it here, and woodchuck_preview to apply it or say not now.`,
          );
        }
        break;
      case "example":
        out.push(`Woodchuck's Claude opened a worked example of a ${String(c.joint).replace(/_/g, " ")} joint in the Woodchuck window.`);
        break;
      case "tool_request":
        out.push(requestLine(String(c.request), ctx.toolRequests?.find((r) => r.id === c.request), ctx.repo ?? null));
        break;
      case "change":
        if (c.author === "claude") out.push(`(Woodchuck's Claude made ${String(c.edits)} edit${c.edits === 1 ? "" : "s"}.)`);
        break;
      case "error":
        // A dropped connection Claude got past isn't news.
        if (!c.retry) out.push(`Woodchuck reported an error: ${String(c.text)}`);
        break;
    }
  }
  if (tools) out.push(`(It used ${tools} tool${tools === 1 ? "" : "s"}.)`);
  if (stillWorking) out.push("Woodchuck's Claude is still working. Call woodchuck_reply for the rest once it's done.");
  if (!out.length) out.push("Woodchuck's Claude didn't say anything.");
  return out.join("\n\n");
}

/** Where the current or last request stands. Failed is an error, and stopped is Stop. */
export type JobState = "running" | "waiting" | "done" | "failed" | "stopped" | "idle";
/** The states the background block was agreed with, which another app may check against. */
export type BlockState = "running" | "waiting" | "done" | "idle";
export type WaitingFor = "question" | "preview" | "plan" | "part";

/** Claude's current or last request, as the server keeps it. */
export interface JobRecord {
  /** The chat line of the message that started it. */
  id: string;
  /** The chat line its own lines come after. */
  after: string;
  started_at: string;
  ended_at?: string;
  /** Why it ended early, when an error ended it. */
  error?: string;
  /** Set when Stop ended it. */
  stopped?: true;
}

export interface Progress {
  busy: boolean;
  /** The chat line of the message that started the current or last request, or "" before any. */
  job: string;
  state: JobState;
  started_at: string | null;
  elapsed_s: number;
  /** Tool calls in this request. */
  steps: number;
  /** Parts in the design now, which the Woodchuck window shows as they're added. */
  parts: number;
  /** Edits Claude has made to the design in this request. */
  edits: number;
  /** When an error ended the request, what it was. */
  error: string;
  /** A plan or question this request was started by answering, with a message sent while Claude worked. */
  answered: string;
  /** What Claude is doing, in one plain line. */
  stage: string;
  /** The last three tool calls, oldest first. */
  recent: string[];
  waiting_for: WaitingFor | null;
  /** The question, or the preview, plan or part, when Claude is waiting on one. */
  ask: string;
  /** Messages sent while Claude worked that it hasn't taken in yet. */
  queued: { id: string; text: string }[];
  /** When it's done or waiting, what Claude said and did, as describe() puts it. */
  reply: string;
}

/** The longest stage line, in characters. */
const STAGE_MAX = 160;

const clip = (s: string, n = STAGE_MAX) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** A line of plain words: no markdown emphasis or heading marks. */
const plain = (s: string) =>
  s
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** The last line Claude said out loud. */
function lastLine(text: string): string {
  const lines = text
    .split("\n")
    .map(plain)
    .filter((l) => l.length > 0);
  return lines.at(-1) ?? "";
}

/** The first sentence of Claude's thinking, often its own heading for what it's about to do. */
function firstSentence(text: string): string {
  const first = text
    .split("\n")
    .map(plain)
    .find((l) => l.length > 0);
  if (!first) return "";
  return first.split(/(?<=[.!?])\s/)[0]!;
}

/**
 * One plain line for what Claude is doing: its latest narration line if it
 * has said one, else the first sentence of its latest thinking, else its
 * latest tool call.
 */
export function stageOf(items: Item[]): string {
  const said = items.findLast((c) => c.kind === "assistant" && lastLine(String(c.text ?? "")));
  if (said) return clip(lastLine(String(said.text)));
  const thought = items.findLast((c) => c.kind === "thinking" && firstSentence(String(c.text ?? "")));
  if (thought) return clip(firstSentence(String(thought.text)));
  const tool = items.findLast((c) => c.kind === "tool");
  return tool ? clip(String(tool.summary ?? "")) : "";
}

/** What Claude is waiting on, in a few words: the question, or the preview's, plan's or part's name. */
function askOf(chat: Item[], kind: WaitingFor): string {
  const last = (test: (c: Item) => boolean) => chat.findLast(test);
  switch (kind) {
    case "question":
      return String(last((c) => c.kind === "question" && c.answered === undefined)?.question ?? "");
    case "preview":
      return String(last((c) => c.kind === "preview" && c.status === "proposed")?.title ?? "");
    case "plan":
      return String((last((c) => c.kind === "plan")?.plan as { summary?: string } | undefined)?.summary ?? "");
    case "part":
      return String((last((c) => c.kind === "part" && c.status === "proposed")?.part as { name?: string } | undefined)?.name ?? "");
  }
}

/** The error that ended a request, if one did: its last, once Claude's turn has stopped. */
const endingError = (items: Item[]) => items.findLast((c) => c.kind === "error" && !c.retry);

/**
 * The request a chat shows when the app has no record of one, such as after
 * a restart: from the last message that started a turn to the chat's end.
 * An error in it means it stopped early.
 */
function jobFromChat(chat: Item[]): JobRecord | null {
  const start = chat.findLast((c) => c.kind === "user" && (!c.during || c.taken === "turn"));
  if (!start) return null;
  const job: JobRecord = { id: start.id, after: start.id, started_at: String(start.at), ended_at: String(chat.at(-1)?.at ?? start.at) };
  const err = endingError(itemsAfter(chat, start.id));
  if (err?.text === "Stopped.") job.stopped = true;
  else if (err) job.error = String(err.text);
  return job;
}

/** The plan or question a message sent while Claude worked was taken as the reply to, in a line. */
function answeredBy(chat: Item[], id: string): string {
  const card = chat.findLast((c) => (c.kind === "plan" || c.kind === "question") && c.answered_by === id);
  if (!card) return "";
  const what = card.kind === "plan" ? `plan, "${String((card.plan as { summary?: string } | undefined)?.summary ?? "")}"` : `question, "${String(card.question)}"`;
  return `A message the woodworker sent while Woodchuck's Claude worked was taken as the reply to its ${what}, so it isn't waiting on that any more.`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** How Claude's current or last request is going. Pure, so it answers at once and tests can pass the clock. */
export function progress(o: {
  chat: Item[];
  job: JobRecord | null;
  busy: boolean;
  waiting: WaitingFor[];
  queued: { id: string; text: string }[];
  now: number;
  /** Parts in the design now. */
  parts?: number;
  /** Claude's edits in the change set still open, which have no chat line yet. */
  openEdits?: number;
  toolRequests?: RequestInfo[];
  repo?: string | null;
}): Progress {
  const job = o.job ?? jobFromChat(o.chat);
  const items = job ? itemsAfter(o.chat, job.after) : [];
  const tools = items.filter((c) => c.kind === "tool");
  const waitingFor = !o.busy && o.waiting.length ? o.waiting[0]! : null;
  const state: JobState = o.busy ? "running" : waitingFor ? "waiting" : job?.error ? "failed" : job?.stopped ? "stopped" : job ? "done" : "idle";
  const end = o.busy || !job?.ended_at ? o.now : Date.parse(job.ended_at);
  const edits = items.filter((c) => c.kind === "change" && c.author === "claude").reduce((n, c) => n + Number(c.edits ?? 0), 0) + (o.busy ? (o.openEdits ?? 0) : 0);
  const answered = job ? answeredBy(o.chat, job.id) : "";
  const ctx = { toolRequests: o.toolRequests ?? [], repo: o.repo ?? null };
  let reply = "";
  if (state === "failed" || state === "stopped") {
    // How it ended comes first, since another app may pass on only the start.
    const err = endingError(items);
    const head =
      state === "failed"
        ? `Woodchuck's Claude stopped with an error before it finished, after ${plural(tools.length, "step")}. The error: ${job!.error} The woodworker can ask it to carry on, and it picks up from the design as it is.`
        : `Woodchuck's Claude was stopped before it finished, after ${plural(tools.length, "step")}. The woodworker can ask it to carry on.`;
    reply = [head, answered, describe(items.filter((c) => c !== err), false, ctx)].filter(Boolean).join("\n\n");
  } else if (state === "done" || state === "waiting") {
    reply = [answered, describe(items, false, ctx)].filter(Boolean).join("\n\n");
  }
  return {
    busy: o.busy,
    job: job?.id ?? "",
    state,
    started_at: job?.started_at ?? null,
    elapsed_s: job ? Math.max(0, Math.round((end - Date.parse(job.started_at)) / 1000)) : 0,
    steps: tools.length,
    parts: o.parts ?? 0,
    edits,
    error: state === "failed" ? job!.error! : "",
    answered,
    stage: stageOf(items),
    recent: tools.slice(-3).map((c) => String(c.summary ?? "")),
    waiting_for: waitingFor,
    ask: waitingFor ? askOf(o.chat, waitingFor) : "",
    queued: o.queued,
    reply,
  };
}

/** Whether the request has something to say: it's over, or waiting on the woodworker. */
export const hasReply = (state: JobState) => state !== "running" && state !== "idle";

/** A length of time in plain words, such as "5 min 12 s". */
export function duration(s: number): string {
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
}

/** How far the design has got, in a line: its parts, and Claude's edits in this request. */
export function designLine(p: Pick<Progress, "state" | "parts" | "edits">): string {
  if (p.state === "idle") return "";
  const parts = p.parts ? `${plural(p.parts, "part")} in the design` : "No parts in the design";
  const edits = `${plural(p.edits, "edit")} by Woodchuck's Claude in this request`;
  if (p.state === "running") return `${parts} so far, from ${edits}, showing live in the Woodchuck window.`;
  return p.edits ? `${parts}, after ${edits}.` : `${parts}.`;
}

/** The progress in a few lines another model can pass on. */
export function progressText(p: Progress): string {
  const steps = plural(p.steps, "step");
  const lines: string[] = [];
  if (p.answered) lines.push(p.answered);
  switch (p.state) {
    case "running":
      lines.push(`Woodchuck's Claude is working${p.stage ? `: ${p.stage}` : "."} (${steps}, ${duration(p.elapsed_s)} so far.)`);
      if (p.recent.length) lines.push(`Latest steps: ${p.recent.join("; ")}.`);
      break;
    case "waiting":
      lines.push(`Woodchuck's Claude is waiting for an answer to a ${p.waiting_for}${p.ask ? `: ${p.ask}` : "."}`);
      break;
    case "done":
      lines.push(`Woodchuck's Claude has finished (${steps}, ${duration(p.elapsed_s)}).`);
      break;
    case "failed":
      lines.push(`Woodchuck's Claude stopped with an error before it finished (${steps}, ${duration(p.elapsed_s)}). The error: ${p.error}`);
      lines.push("The woodworker can ask it to carry on.");
      break;
    case "stopped":
      lines.push(`Woodchuck's Claude was stopped before it finished (${steps}, ${duration(p.elapsed_s)}). The woodworker can ask it to carry on.`);
      break;
    case "idle":
      lines.push("Woodchuck's Claude isn't working on anything.");
      break;
  }
  const design = designLine(p);
  if (design) lines.push(design);
  if (p.queued.length) {
    lines.push(`${p.queued.length === 1 ? "One message is" : `${p.queued.length} messages are`} waiting to reach it after its current step.`);
  }
  return lines.join("\n");
}

/** The machine-readable block another app watches a request by. */
export interface Background {
  job: string;
  /** A request that failed or was stopped is done here, with outcome saying how, so an app that knows only the four states still hears it ended. */
  state: BlockState;
  title: "Woodchuck";
  progress_tool: "woodchuck_progress";
  stage: string;
  steps: number;
  elapsed_s: number;
  waiting_for: WaitingFor | null;
  ask: string;
  reply: string;
  /** How a request that's over ended, or null while it runs or waits. */
  outcome: "finished" | "failed" | "stopped" | null;
  error: string;
  parts: number;
  edits: number;
}

export function background(p: Progress): { background: Background } {
  const over = p.state === "done" || p.state === "failed" || p.state === "stopped";
  return {
    background: {
      job: p.job,
      state: over ? "done" : (p.state as BlockState),
      title: "Woodchuck",
      progress_tool: "woodchuck_progress",
      stage: p.stage,
      steps: p.steps,
      elapsed_s: p.elapsed_s,
      waiting_for: p.waiting_for,
      ask: p.ask,
      reply: p.reply,
      outcome: over ? (p.state === "done" ? "finished" : (p.state as "failed" | "stopped")) : null,
      error: p.error,
      parts: p.parts,
      edits: p.edits,
    },
  };
}
