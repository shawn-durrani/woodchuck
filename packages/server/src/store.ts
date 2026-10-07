// Projects on disk. Each project folder holds the design, its undo history,
// Claude's conversation and the chat log the app shows. Files are private
// to your account: the data folder is 0700 and every file 0600.
//
// Claude's conversation only grows. A summary written between turns is kept
// beside it in compactions.json, which only grows too, with the number of
// messages it stands in for. A chat whose stored summary the API refused
// says so in refused.json, and its requests leave that summary out.
// What each warm-up of the prompt cache cost goes in warmups.json, apart
// from the chat, since it isn't a turn.

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { applyOps, emptyDesign, type Design, type JointType, type LibraryPart, type Op, type Plan } from "@woodchuck/core";
import type { TurnInput } from "./agent.js";
import type { Effort, RouteReason } from "./route.js";
import type { ToolRequest } from "./tools.js";
import { DesignHistory } from "./versions.js";
import { readWorkshop, workshopFromFile, type Workshop } from "./workshop.js";

export type Author = "you" | "claude" | "example";

export interface HistoryEntry {
  id: number;
  author: Author;
  label: string;
  at: string;
  before: Design;
  after: Design;
}

/** A numbered spot the woodworker clicked on the model. */
export interface Pin {
  n: number;
  part: string;
  face: string;
  point_mm: [number, number, number];
}

export type ChatItem =
  | {
      id: string;
      kind: "user";
      text: string;
      selection: string[];
      images?: string[];
      pins?: Pin[];
      view?: string;
      /** Sent while Claude was working. */
      during?: true;
      /** When Claude took a message sent while it worked in: after a step, or by starting its next turn with it. */
      taken?: "step" | "turn";
      at: string;
    }
  | { id: string; kind: "assistant"; text: string; at: string; streaming?: boolean }
  | { id: string; kind: "thinking"; text: string; at: string }
  | { id: string; kind: "tool"; name: string; summary: string; is_error: boolean; image?: string; at: string }
  /** answered_by names a message sent while Claude worked that was taken as the answer. */
  | { id: string; kind: "question"; question: string; options: string[]; answered?: string; answered_by?: string; at: string }
  | { id: string; kind: "plan"; plan: Plan; image?: string; answered?: string; answered_by?: string; at: string }
  | { id: string; kind: "part"; proposal: string; part: LibraryPart; status: "proposed" | "approved" | "changes_requested"; at: string }
  /** A change set. It's marked undone while Undo has taken it back. */
  | { id: string; kind: "change"; change: number; author: Author; label: string; edits: number; undone?: true; at: string }
  | { id: string; kind: "tool_request"; request: string; at: string }
  | { id: string; kind: "tool_built"; request: string; pr_url?: string; at: string }
  | {
      id: string;
      kind: "preview";
      title: string;
      explanation: string;
      ops: Op[];
      status: "proposed" | "applied" | "not_applied" | "failed";
      error?: string;
      at: string;
    }
  /** stopped shows the joint's housing stopping 10 mm short of an edge of its host. */
  /** A worked joint, or with of, one of the design's own joints pulled apart on the model. */
  | { id: string; kind: "example"; joint: JointType; note?: string; stopped?: true; of?: string; at: string }
  /** retry marks a dropped connection that Claude's turn is trying again after, rather than one that ended it. */
  | { id: string; kind: "error"; text: string; retry?: true; at: string }
  /**
   * What a turn cost and how long it took. Every field past the token counts
   * is optional: turns from before timing was kept have only the tokens, and
   * some from just before it have efforts and route without rounds.
   */
  | {
      id: string;
      kind: "usage";
      input: number;
      cached: number;
      written?: number;
      output: number;
      at: string;
      /** The model asked for. */
      model?: string;
      /** The rule that picked the turn's starting level, when turns pick their own. */
      route?: RouteReason;
      /** The whole turn, start to finish. */
      ms?: number;
      /** Time spent running Claude's tool calls on this computer. */
      tool_ms?: number;
      /** One entry per request Claude replied to, each with the level it was written at. */
      rounds?: RoundTiming[];
      /**
       * The level each request was written at, from turns saved before rounds
       * were kept. Newer turns keep it on each round instead, and never write this.
       */
      efforts?: Effort[];
    }
  /**
   * The older chat was summarised to keep Claude quick. A summary written
   * between turns carries its own tokens and time. One the API wrote inside
   * a turn's request has none here, since they're in that request's round.
   */
  | { id: string; kind: "summary"; at: string; input?: number; cached?: number; written?: number; output?: number; ms?: number };

/** What set off a warm-up: the design opened or switched to, a window coming into view, or another app through MCP. */
export type WarmTrigger = "open" | "window" | "mcp";

/**
 * A warm-up of Claude's prompt cache, sent before the woodworker's next
 * message. It isn't a turn and the chat never shows it, so it's kept in a
 * file of its own, warmups.json, which turn-stats reads.
 */
export interface Warmup {
  at: string;
  model: string;
  trigger: WarmTrigger;
  /** From sending the request to its answer. */
  ms: number;
  /** Tokens read at the full price, read from the cache and written to it. */
  input: number;
  cached: number;
  written: number;
}

/** The most warm-ups a design keeps, newest last. */
const WARMUPS_KEPT = 200;

/** One request to Claude within a turn: its timing, tokens and tool calls. */
export interface RoundTiming {
  /** The level this request was written at: the effort message in force, or the request's own level. */
  effort: Effort;
  /**
   * From sending the request to the first thinking or words streamed back,
   * on the try that worked. Null when neither streamed.
   */
  ttft_ms: number | null;
  /** The whole round, from its first try to the finished reply, with any waits between tries. */
  ms: number;
  input: number;
  cached: number;
  written: number;
  output: number;
  /** Tool calls the reply carried that run on this computer. Web searches aren't counted. An apply_edits call counts once. */
  calls: number;
  /** The edits the reply's apply_edits calls listed, when it made any. */
  edits?: number;
  /** Failed tries before the one that worked. */
  retries?: number;
  /** The API summarised the older chat on this request. */
  compacted?: true;
}

/**
 * A summary of the chat that Claude wrote between turns, on request. It
 * stands in for every message before `upto` in the saved conversation,
 * which itself never changes.
 */
export interface Compaction {
  /** The compaction block exactly as the API returned it, signature and all. */
  block: Anthropic.Beta.BetaCompactionBlockParam;
  /** The number of saved messages the summary covers, from the first. */
  upto: number;
  at: string;
}

/**
 * Where the API refused a request over a summary it carried. Every summary
 * stored before then is left out of later requests, which carry the chat in
 * full from the saved messages instead.
 */
export interface Refused {
  /** The API's own summaries in the first this many saved messages are left out. */
  messages: number;
  /** The first this many summaries from between turns are left out. */
  compactions: number;
  at: string;
}

export interface Pending {
  /** Results for the calls that aren't waiting, sent with the woodworker's next message. */
  held: Anthropic.Beta.BetaToolResultBlockParam[];
  /** Tool calls waiting on the woodworker. */
  waiting: { tool_use_id: string; kind: "question" | "plan" | "part" | "preview" }[];
}

/** A message sent while Claude works, waiting for Claude's next step. */
export interface Queued {
  /** Its line in the chat. */
  item: string;
  input: TurnInput;
}

/** Claude's current or last request, for telling other apps how it's going. */
export interface Job {
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

/** Where a tool request stands: waiting, sent to build, built, or not needed. */
export const TOOL_REQUEST_STATUSES = ["open", "approved", "built", "declined"] as const;
export type ToolRequestStatus = (typeof TOOL_REQUEST_STATUSES)[number];

export const isToolRequestStatus = (v: unknown): v is ToolRequestStatus => (TOOL_REQUEST_STATUSES as readonly unknown[]).includes(v);

export interface StoredToolRequest extends ToolRequest {
  id: string;
  count: number;
  /** The GitHub issue it was filed as, for Claude Code to build. */
  issue_url?: string;
  /** The merged PR that built it. */
  pr_url?: string;
  status: ToolRequestStatus;
  first_at: string;
  last_at: string;
}

const now = () => new Date().toISOString();

/** What a fresh design is called until Claude knows what it is. */
export const NEW_DESIGN = "New design";

function writePrivate(file: string, data: string | Buffer) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "design"
  );
}

export class Project {
  design: Design;
  history: HistoryEntry[];
  redo: HistoryEntry[];
  messages: Anthropic.Beta.BetaMessageParam[];
  /** Summaries written between turns, oldest first. Only the latest is sent. */
  compactions: Compaction[];
  /** Where the API refused a stored summary, or null when it never has. */
  refused: Refused | null;
  chat: ChatItem[];
  pending: Pending | null;
  /** What you changed since Claude's last turn, told to Claude next time. */
  notes: string[];
  /** Other things that happened since Claude's last turn, such as a tool being built. */
  news: string[];
  /** The model this design's chat uses, when you've picked one. */
  model: string | undefined;
  /** A photo of the room to place the design in, kept with its references. */
  backdrop: string | undefined;
  /** Marked to find again: starred designs come first in the list. */
  starred = false;
  /** The example this design started from, so the app can say what it is. */
  example: "record_console" | undefined;
  /**
   * Messages sent while Claude works, until it takes them in. They're held
   * in memory only, since a restart ends the turn they were sent into.
   */
  queued: Queued[] = [];
  /** Claude's current or last request on this design since the app started. */
  job: Job | null = null;
  private nextId: number;
  private open: { author: Author; label: string; before: Design; edits: number } | null = null;

  constructor(
    readonly slug: string,
    readonly dir: string,
    private versions?: DesignHistory,
  ) {
    mkdirSync(path.join(dir, "renders"), { recursive: true, mode: 0o700 });
    mkdirSync(path.join(dir, "references"), { recursive: true, mode: 0o700 });
    this.design = readJson(path.join(dir, "design.json"), emptyDesign(slug));
    const h = readJson(path.join(dir, "history.json"), { undo: [] as HistoryEntry[], redo: [] as HistoryEntry[] });
    this.history = h.undo;
    this.redo = h.redo;
    this.messages = readJson(path.join(dir, "messages.json"), []);
    this.compactions = readJson<Compaction[]>(path.join(dir, "compactions.json"), []);
    this.refused = readJson<Refused | null>(path.join(dir, "refused.json"), null);
    this.chat = readJson(path.join(dir, "chat.json"), []);
    this.pending = readJson<Pending | null>(path.join(dir, "pending.json"), null);
    this.notes = readJson<string[]>(path.join(dir, "notes.json"), []);
    this.news = readJson<string[]>(path.join(dir, "news.json"), []);
    const settings = readJson<{ model?: string; backdrop?: string; starred?: boolean; example?: string }>(path.join(dir, "settings.json"), {});
    this.model = settings.model;
    this.backdrop = settings.backdrop;
    this.starred = settings.starred === true;
    this.example = settings.example === "record_console" ? "record_console" : undefined;
    this.nextId = Math.max(0, ...this.history.map((e) => e.id), ...this.redo.map((e) => e.id)) + 1;
  }

  save() {
    writePrivate(path.join(this.dir, "design.json"), JSON.stringify(this.design, null, 2));
    writePrivate(path.join(this.dir, "history.json"), JSON.stringify({ undo: this.history.slice(-100), redo: this.redo }));
    writePrivate(path.join(this.dir, "messages.json"), JSON.stringify(this.messages));
    // Written once there's a summary from between turns, so a chat without one keeps the files it always had.
    if (this.compactions.length) writePrivate(path.join(this.dir, "compactions.json"), JSON.stringify(this.compactions));
    if (this.refused) writePrivate(path.join(this.dir, "refused.json"), JSON.stringify(this.refused));
    writePrivate(path.join(this.dir, "chat.json"), JSON.stringify(this.chat));
    writePrivate(path.join(this.dir, "pending.json"), JSON.stringify(this.pending));
    writePrivate(path.join(this.dir, "notes.json"), JSON.stringify(this.notes));
    writePrivate(path.join(this.dir, "news.json"), JSON.stringify(this.news));
    writePrivate(
      path.join(this.dir, "settings.json"),
      JSON.stringify({
        ...(this.model ? { model: this.model } : {}),
        ...(this.backdrop ? { backdrop: this.backdrop } : {}),
        ...(this.starred ? { starred: true } : {}),
        ...(this.example ? { example: this.example } : {}),
      }),
    );
  }

  /** Saves, and records the design as a version in the history. */
  private record(message: string, author: Author) {
    this.save();
    this.versions?.commit(this.slug, message, author);
  }

  /** Swaps in a whole design, such as an older version, as one undoable change. */
  replace(design: Design, author: Author, label: string): HistoryEntry | null {
    return this.between(() => {
      this.beginChange(author, label);
      this.design = structuredClone(design);
      if (this.open) this.open.edits = 1;
      return this.endChange();
    });
  }

  /**
   * Makes a change set of its own while another is open, such as your edit
   * while Claude works. The open set so far becomes its own step, if it
   * changed anything, and it opens again afterwards under the same name. So
   * Undo takes back your edit or Claude's work around it, one at a time.
   */
  private between<T>(make: () => T): T {
    const held = this.open;
    try {
      if (held) this.endChange();
      return make();
    } finally {
      if (held) this.open = { author: held.author, label: held.label, before: this.design, edits: 0 };
    }
  }

  /** Starts a change set. Everything until endChange undoes as one step. */
  beginChange(author: Author, label: string) {
    if (this.open) this.endChange();
    this.open = { author, label, before: this.design, edits: 0 };
  }

  apply(ops: Op[]): Design {
    const next = applyOps(this.design, ops);
    this.design = next;
    if (this.open) this.open.edits += ops.length;
    return next;
  }

  /** Who the change set still open belongs to, and how many edits it holds so far. */
  get openChange(): { author: Author; edits: number } | null {
    return this.open ? { author: this.open.author, edits: this.open.edits } : null;
  }

  /** Closes the change set. Returns its history entry if anything changed. */
  endChange(): HistoryEntry | null {
    const open = this.open;
    this.open = null;
    if (!open || open.before === this.design) return null;
    const entry: HistoryEntry = { id: this.nextId++, author: open.author, label: open.label, at: now(), before: open.before, after: this.design };
    this.history.push(entry);
    this.redo = [];
    this.chat.push({ id: `c${entry.id}-${Date.now()}`, kind: "change", change: entry.id, author: open.author, label: open.label, edits: open.edits, at: now() });
    if (open.author !== "claude") this.notes.push(`changed: ${open.label}`);
    this.record(open.label, open.author);
    return entry;
  }

  /**
   * One change set, applied all or nothing. A change that's refused leaves
   * the design and any open change set as they were.
   */
  change(author: Author, label: string, ops: Op[]): HistoryEntry | null {
    const next = applyOps(this.design, ops);
    return this.between(() => {
      this.open = { author, label, before: this.design, edits: ops.length };
      this.design = next;
      return this.endChange();
    });
  }

  /**
   * Marks messages sent while Claude worked as taken in, and moves them to
   * the end of the chat, which is where Claude read them.
   */
  markTaken(ids: string[], how: "step" | "turn") {
    const lines = ids.flatMap((id) => this.chat.filter((c): c is ChatItem & { kind: "user" } => c.kind === "user" && c.id === id));
    if (!lines.length) return;
    this.chat = this.chat.filter((c) => !ids.includes(c.id));
    for (const line of lines) {
      line.taken = how;
      this.chat.push(line);
    }
  }

  /** Marks the chat's line for a change set as undone, or as back in force. */
  private markUndone(change: number, undone: boolean) {
    for (const item of this.chat) {
      if (item.kind !== "change" || item.change !== change) continue;
      if (undone) item.undone = true;
      else delete item.undone;
    }
  }

  undo(): HistoryEntry | null {
    const e = this.history.pop();
    if (!e) return null;
    this.design = e.before;
    this.redo.push(e);
    this.markUndone(e.id, true);
    this.notes.push(`undid ${e.author === "claude" ? "your" : "their"} change "${e.label}"`);
    this.record(`Undo: ${e.label}`, "you");
    return e;
  }

  redoOne(): HistoryEntry | null {
    const e = this.redo.pop();
    if (!e) return null;
    this.design = e.after;
    this.history.push(e);
    this.markUndone(e.id, false);
    this.notes.push(`redid ${e.author === "claude" ? "your" : "their"} change "${e.label}"`);
    this.record(`Redo: ${e.label}`, "you");
    return e;
  }

  addChat(item: ChatItem) {
    this.chat.push(item);
  }

  /** The design's warm-ups, oldest first. */
  warmups(): Warmup[] {
    return readJson<Warmup[]>(path.join(this.dir, "warmups.json"), []);
  }

  /**
   * Keeps a warm-up's numbers. Only warmups.json is written, read fresh
   * each time, so a warm-up that lands after the design was opened again
   * never writes over anything newer.
   */
  addWarmup(w: Warmup) {
    writePrivate(path.join(this.dir, "warmups.json"), JSON.stringify([...this.warmups(), w].slice(-WARMUPS_KEPT)));
  }

  saveRender(png: Buffer): string {
    const name = `${Date.now()}.png`;
    writePrivate(path.join(this.dir, "renders", name), png);
    return name;
  }

  /** Keeps a photo, sketch or spec sheet you attached, so the chat can show it again. */
  saveReference(data: Buffer, ext: string): string {
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    writePrivate(path.join(this.dir, "references", name), data);
    return name;
  }

  referencePath(name: string): string | null {
    if (!/^\d+-[a-z0-9]+\.(jpg|png|webp|gif|pdf)$/.test(name)) return null;
    const file = path.join(this.dir, "references", name);
    return existsSync(file) ? file : null;
  }

  renderPath(name: string): string | null {
    if (!/^\d+\.png$/.test(name)) return null;
    const file = path.join(this.dir, "renders", name);
    return existsSync(file) ? file : null;
  }
}

export class Store {
  readonly projectsDir: string;
  private current: Project;

  readonly versions: DesignHistory;

  constructor(readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o700);
    this.projectsDir = path.join(dataDir, "projects");
    mkdirSync(this.projectsDir, { recursive: true, mode: 0o700 });
    this.versions = new DesignHistory(this.projectsDir);
    // Designs made before the history existed get a first version.
    for (const p of this.list()) this.versions.commit(p.slug, "Versions start here", "you");
    const last = readJson<{ slug?: string }>(path.join(dataDir, "current.json"), {}).slug;
    const slugs = this.list().map((p) => p.slug);
    this.current = this.load(last && slugs.includes(last) ? last : (slugs[0] ?? this.create(NEW_DESIGN).slug));
  }

  get project(): Project {
    return this.current;
  }

  /** Every design, with whether it's starred and when its design last changed. */
  list(): { slug: string; name: string; starred: boolean; changed: string | null }[] {
    // Only design folders: the version history's .git sits beside them.
    return readdirSync(this.projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && existsSync(path.join(this.projectsDir, d.name, "design.json")))
      .map((d) => {
        const dir = path.join(this.projectsDir, d.name);
        const design = readJson<Design | null>(path.join(dir, "design.json"), null);
        const settings = readJson<{ starred?: boolean }>(path.join(dir, "settings.json"), {});
        let changed: string | null = null;
        try {
          changed = statSync(path.join(dir, "design.json")).mtime.toISOString();
        } catch {
          changed = null;
        }
        return { slug: d.name, name: design?.name ?? d.name, starred: settings.starred === true, changed };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Which designs use each library part, found by reading every design's
   * hardware for the part it came from. The open design is read from memory.
   */
  partUses(): Record<string, { slug: string; name: string }[]> {
    const uses: Record<string, { slug: string; name: string }[]> = {};
    for (const { slug, name } of this.list()) {
      let design: Design | null;
      try {
        design = slug === this.current.slug ? this.current.design : readJson<Design | null>(path.join(this.projectsDir, slug, "design.json"), null);
      } catch {
        continue;
      }
      for (const id of new Set((design?.hardware ?? []).map((h) => h.library_part).filter((id): id is string => !!id))) {
        (uses[id] ??= []).push({ slug, name });
      }
    }
    return uses;
  }

  /**
   * Stars or unstars a design. Only its settings are written, so starring
   * doesn't count as changing the design.
   */
  setStarred(slug: string, starred: boolean) {
    // Only a design in the list, so a slug can never name a folder outside it.
    if (!this.list().some((p) => p.slug === slug)) throw new Error(`There's no design "${slug}"`);
    const dir = path.join(this.projectsDir, slug);
    if (this.current.slug === slug) this.current.starred = starred;
    const file = path.join(dir, "settings.json");
    const settings = readJson<Record<string, unknown>>(file, {});
    if (starred) settings.starred = true;
    else delete settings.starred;
    writePrivate(file, JSON.stringify(settings));
  }

  private load(slug: string): Project {
    const p = new Project(slug, path.join(this.projectsDir, slug), this.versions);
    writePrivate(path.join(this.dataDir, "current.json"), JSON.stringify({ slug }));
    return p;
  }

  /** A design without switching to it. The open one is shared, so edits aren't lost. */
  peek(slug: string): Project {
    if (slug === this.current.slug) return this.current;
    return new Project(slug, path.join(this.projectsDir, slug), this.versions);
  }

  open(slug: string): Project {
    if (!this.list().some((p) => p.slug === slug)) throw new Error(`There's no project "${slug}"`);
    this.current = this.load(slug);
    return this.current;
  }

  create(name: string, ops: Op[] = [], start?: Design, how?: string): Project {
    let slug = slugify(name);
    for (let i = 2; existsSync(path.join(this.projectsDir, slug)); i++) slug = `${slugify(name)}-${i}`;
    const dir = path.join(this.projectsDir, slug);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const p = new Project(slug, dir);
    p.design = start ?? applyOps(emptyDesign(name), [{ op: "rename_design", name }, ...ops]);
    p.save();
    this.versions.commit(slug, how ?? (ops.length ? "Started from the example" : "Started fresh"), ops.length ? "example" : "you");
    this.current = this.load(slug);
    return this.current;
  }

  /** A new design that starts as a copy of the open one, with a fresh chat. */
  copy(): Project {
    const from = this.current.design;
    const name = `${from.name} (copy)`;
    return this.create(name, [], { ...structuredClone(from), name }, `Copied from ${from.name}`);
  }

  /** Deletes a design, its chat and its pictures. Opens another, or a fresh one. */
  remove(slug: string) {
    if (!this.list().some((p) => p.slug === slug)) throw new Error(`There's no design "${slug}"`);
    const dir = path.join(this.projectsDir, slug);
    if (path.dirname(dir) !== this.projectsDir) throw new Error("That isn't a design folder");
    const name = readJson<Design | null>(path.join(dir, "design.json"), null)?.name ?? slug;
    rmSync(dir, { recursive: true, force: true });
    this.versions.commit(slug, `Deleted ${name}`, "you");
    if (this.current.slug === slug) {
      const next = this.list()[0];
      this.current = next ? this.load(next.slug) : this.create(NEW_DESIGN);
    }
  }

  // Tool requests are shared across projects, so a recurring need shows up.
  private get requestsFile() {
    return path.join(this.dataDir, "tool-requests.json");
  }

  toolRequests(): StoredToolRequest[] {
    return readJson(this.requestsFile, [] as StoredToolRequest[]);
  }

  addToolRequest(req: ToolRequest): StoredToolRequest {
    const all = this.toolRequests();
    const key = slugify(req.name);
    const hit = all.find((r) => slugify(r.name) === key && r.status !== "built" && r.status !== "declined");
    if (hit) {
      hit.count++;
      hit.last_at = now();
      hit.example = `${hit.example}\n\nAlso: ${req.example}`;
      writePrivate(this.requestsFile, JSON.stringify(all, null, 2));
      return hit;
    }
    const r: StoredToolRequest = { ...req, id: `tr_${all.length + 1}`, count: 1, status: "open", first_at: now(), last_at: now() };
    all.push(r);
    writePrivate(this.requestsFile, JSON.stringify(all, null, 2));
    return r;
  }

  setToolRequestIssue(id: string, url: string) {
    const all = this.toolRequests();
    const r = all.find((x) => x.id === id);
    if (!r) throw new Error(`There's no tool request "${id}"`);
    r.issue_url = url;
    if (r.status === "open") r.status = "approved";
    writePrivate(this.requestsFile, JSON.stringify(all, null, 2));
  }

  setToolRequestStatus(id: string, status: ToolRequestStatus, prUrl?: string) {
    if (!isToolRequestStatus(status)) throw new Error(`A tool request's status is one of ${TOOL_REQUEST_STATUSES.join(", ")}`);
    const all = this.toolRequests();
    const r = all.find((x) => x.id === id);
    if (!r) throw new Error(`There's no tool request "${id}"`);
    r.status = status;
    if (prUrl) r.pr_url = prUrl;
    writePrivate(this.requestsFile, JSON.stringify(all, null, 2));
  }

  // Your workshop is app-wide, so it sits beside the tool requests, never in a design.
  private get workshopFile() {
    return path.join(this.dataDir, "workshop.json");
  }

  /** Your workshop, or the defaults until you change it. */
  workshop(): Workshop {
    try {
      return workshopFromFile(readJson<unknown>(this.workshopFile, {}));
    } catch {
      return workshopFromFile({});
    }
  }

  /** Checks and saves new workshop settings over the ones you have. Returns what was saved. */
  setWorkshop(input: unknown): Workshop {
    const next = readWorkshop(input, this.workshop());
    writePrivate(this.workshopFile, JSON.stringify(next, null, 2));
    return next;
  }
}
