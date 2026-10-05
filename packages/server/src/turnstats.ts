// Counts and timings from saved chats, for seeing where Claude's turns
// spend their time. It reads each design's chat.json and messages.json and
// reports numbers only: rounds, seconds, tool calls and tokens. It never
// prints chat text, design names or anything else from a design.
//
// Turns since timing was kept carry it in their usage line. Older turns are
// rebuilt from the conversation: one round per reply from Claude, its tool
// calls counted, and the turn's time taken from the chat's timestamps.
// Each timed round keeps the effort it was written at. Turns saved just
// before rounds were kept list their efforts on the usage line instead.
//
// Warm-ups of the prompt cache aren't turns. Each design keeps them in
// warmups.json, and the report sums them up on a line of their own.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { ChatItem, RoundTiming, Warmup } from "./store.js";

type Usage = Extract<ChatItem, { kind: "usage" }>;

export interface TurnStat {
  /** The design's number in the report. Its name is never shown. */
  design: number;
  /** The turn's number within its design. */
  turn: number;
  /** Whether the turn kept its own timing, or was rebuilt from the chat. */
  timed: boolean;
  /** Tool calls in each round, or null when the conversation doesn't line up with the chat. */
  calls: number[] | null;
  ms: number | null;
  /** Timed turns only, from here down. */
  rounds: RoundTiming[] | null;
  tool_ms: number | null;
  model: string | null;
  /** The level each request was written at, in order, or null when the turn didn't keep them. */
  efforts: string[] | null;
  /** The rule that picked the turn's starting level, when turns picked their own. */
  route: string | null;
  /** Edits listed in apply_edits calls, across the turn. Timed turns only. */
  edits: number | null;
  input: number;
  cached: number;
  written: number;
  output: number;
}

/** Whether a message from the woodworker's side starts a turn, rather than carrying tool results or a word sent mid-turn. */
function startsTurn(m: Anthropic.Beta.BetaMessageParam): boolean {
  if (m.role !== "user") return false;
  if (typeof m.content === "string") return true;
  return m.content.some((b) => b.type === "text" && !b.text.startsWith("(While you were working"));
}

/** Tool calls per reply from Claude, turn by turn, from the conversation. */
export function roundsFromMessages(messages: Anthropic.Beta.BetaMessageParam[]): number[][] {
  const turns: number[][] = [];
  for (const m of messages) {
    if (startsTurn(m)) turns.push([]);
    else if (m.role === "assistant" && turns.length) {
      const calls = Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_use").length : 0;
      turns.at(-1)!.push(calls);
    }
  }
  return turns;
}

/** A model, effort or route name, kept only when it looks like one. */
const word = (v: unknown): string | null => (typeof v === "string" && /^[a-z0-9.-]{1,40}$/.test(v) ? v : null);

const ms = (from: string | undefined, to: string): number | null => {
  const a = from ? Date.parse(from) : NaN;
  const b = Date.parse(to);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : null;
};

/** One design's turns, from its chat and conversation. */
export function turnsOf(chat: ChatItem[], messages: Anthropic.Beta.BetaMessageParam[], design = 1): TurnStat[] {
  const usages: { u: Usage; start: string | undefined }[] = [];
  let since = 0;
  let last: Usage | undefined;
  chat.forEach((c, i) => {
    if (c.kind !== "usage") return;
    // An older turn starts at the first message after the last turn ended.
    // A follow-up turn, from a message sent during the last one, starts
    // when the last one ended.
    const said = chat.slice(since, i).find((x) => x.kind === "user");
    const start = said?.kind === "user" && said.during ? (last?.at ?? said.at) : said?.at;
    usages.push({ u: c, start });
    since = i + 1;
    last = c;
  });
  // Every turn adds one message that starts it and one usage line. When an
  // old chat has fewer of one than the other, the latest turns line up.
  const replies = roundsFromMessages(messages);
  const offset = replies.length - usages.length;
  return usages.map(({ u, start }, i) => {
    const rebuilt = replies[i + offset] ?? null;
    const timed = Array.isArray(u.rounds);
    // Newer turns keep each round's level on the round; turns from just before then kept a list.
    const levels = timed ? u.rounds!.map((r) => r.effort) : Array.isArray(u.efforts) ? u.efforts : null;
    const efforts = levels?.map((e) => word(e) ?? "-") ?? null;
    return {
      design,
      turn: i + 1,
      timed,
      calls: timed ? u.rounds!.map((r) => r.calls) : rebuilt,
      ms: timed && typeof u.ms === "number" ? u.ms : ms(start, u.at),
      rounds: timed ? u.rounds! : null,
      tool_ms: timed && typeof u.tool_ms === "number" ? u.tool_ms : null,
      model: word(u.model),
      efforts: efforts?.length ? efforts : null,
      route: word(u.route),
      edits: timed ? u.rounds!.reduce((sum, r) => sum + (r.edits ?? 0), 0) : null,
      input: u.input ?? 0,
      cached: u.cached ?? 0,
      written: u.written ?? 0,
      output: u.output ?? 0,
    };
  });
}

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

/** Every design's turns in a data folder. Designs are numbered in folder order, and their names are left behind. */
export function readTurns(dataDir: string): TurnStat[] {
  const projects = path.join(dataDir, "projects");
  if (!existsSync(projects)) throw new Error(`There's no projects folder in ${dataDir}`);
  const dirs = readdirSync(projects, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && existsSync(path.join(projects, d.name, "chat.json")))
    .map((d) => d.name)
    .sort();
  return dirs.flatMap((name, i) => {
    const dir = path.join(projects, name);
    return turnsOf(readJson<ChatItem[]>(path.join(dir, "chat.json"), []), readJson<Anthropic.Beta.BetaMessageParam[]>(path.join(dir, "messages.json"), []), i + 1);
  });
}

/** A warm-up of the prompt cache, with only its numbers. */
export interface WarmupStat {
  design: number;
  trigger: string | null;
  ms: number;
  input: number;
  cached: number;
  written: number;
}

const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** One design's warm-ups, from its warmups.json, with nothing but numbers kept. */
export function warmupsOf(warmups: Warmup[], design = 1): WarmupStat[] {
  return warmups.map((w) => ({ design, trigger: word(w.trigger), ms: count(w.ms), input: count(w.input), cached: count(w.cached), written: count(w.written) }));
}

/** Every design's warm-ups in a data folder, numbered the way readTurns numbers the designs. */
export function readWarmups(dataDir: string): WarmupStat[] {
  const projects = path.join(dataDir, "projects");
  if (!existsSync(projects)) throw new Error(`There's no projects folder in ${dataDir}`);
  const dirs = readdirSync(projects, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && existsSync(path.join(projects, d.name, "chat.json")))
    .map((d) => d.name)
    .sort();
  return dirs.flatMap((name, i) => warmupsOf(readJson<Warmup[]>(path.join(projects, name, "warmups.json"), []), i + 1));
}

/** The median and 90th percentile, nearest rank. */
export function spread(values: number[]): { n: number; median: number | null; p90: number | null } {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) return { n: 0, median: null, p90: null };
  const rank = (q: number) => v[Math.max(0, Math.ceil(q * v.length) - 1)]!;
  return { n: v.length, median: rank(0.5), p90: rank(0.9) };
}

/** Whether a timed turn's first request wrote more than half its input to the cache, as a cold cache does. */
export function coldStart(t: TurnStat): boolean | null {
  const r = t.rounds?.[0];
  if (!r) return null;
  const all = r.input + r.cached + r.written;
  return all > 0 && r.written > all / 2;
}

const s1 = (ms: number | null) => (ms === null ? "-" : (ms / 1000).toFixed(1));
const num = (v: number | null) => (v === null ? "-" : String(Math.round(v * 10) / 10));
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "-");
const pad = (cells: string[], widths: number[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();

/** A turn's levels in a few letters: each change in order, such as "low>high". */
export function effortPath(efforts: string[] | null): string {
  if (!efforts?.length) return "-";
  return efforts.filter((e, i) => e !== efforts[i - 1]).join(">");
}

/** "a 3, b 1", most first, then by name. */
function counted(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return (
    [...counts]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([k, v]) => `${k} ${v}`)
      .join(", ") || "-"
  );
}

/** The report: one line per turn, then the medians and shares across them all, and the warm-ups of the cache. */
export function report(turns: TurnStat[], warmups: WarmupStat[] = []): string {
  const out: string[] = [];
  const head = ["design", "turn", "src", "rounds", "secs", "s/round", "tool s", "calls per round", "output", "cached", "written", "input", "model", "effort", "route"];
  const widths = [6, 4, 3, 6, 7, 7, 6, 24, 7, 9, 8, 7, 17, 16, 12];
  out.push(pad(head, widths));
  for (const t of turns) {
    const n = t.calls?.length ?? null;
    out.push(
      pad(
        [
          String(t.design),
          String(t.turn),
          t.timed ? "rec" : "est",
          n === null ? "-" : String(n),
          s1(t.ms),
          n && t.ms !== null ? s1(t.ms / n) : "-",
          s1(t.tool_ms),
          t.calls ? (t.calls.join(",") || "-").slice(0, 24) : "-",
          String(t.output),
          String(t.cached),
          String(t.written),
          String(t.input),
          t.model ?? "-",
          effortPath(t.efforts).slice(0, 16),
          t.route ?? "-",
        ],
        widths,
      ),
    );
  }

  const timed = turns.filter((t) => t.timed);
  const known = turns.filter((t) => t.calls);
  const rounds = timed.flatMap((t) => t.rounds!);
  const calls = known.flatMap((t) => t.calls!);
  const rows: [string, ReturnType<typeof spread>, (v: number | null) => string][] = [
    ["rounds per turn", spread(known.map((t) => t.calls!.length)), num],
    ["seconds per turn", spread(turns.flatMap((t) => (t.ms === null ? [] : [t.ms]))), s1],
    ["seconds per round, timed", spread(rounds.map((r) => r.ms)), s1],
    [
      "seconds per round, rebuilt",
      spread(known.filter((t) => !t.timed && t.ms !== null && t.calls!.length).map((t) => t.ms! / t.calls!.length)),
      s1,
    ],
    ["seconds to first event", spread(rounds.flatMap((r) => (r.ttft_ms === null ? [] : [r.ttft_ms]))), s1],
    ["output tokens per round", spread(rounds.map((r) => r.output)), num],
    ["tool calls per round", spread(calls), num],
    ["tool seconds per turn", spread(timed.flatMap((t) => (t.tool_ms === null ? [] : [t.tool_ms]))), s1],
  ];
  out.push("");
  out.push(`${turns.length} turns in ${new Set(turns.map((t) => t.design)).size} designs: ${timed.length} timed, ${turns.length - timed.length} rebuilt from older chats.`);
  out.push("");
  out.push(pad(["", "median", "p90", "n"], [28, 7, 7, 5]));
  for (const [label, s, f] of rows) out.push(pad([label, f(s.median), f(s.p90), String(s.n)], [28, 7, 7, 5]));
  out.push("");
  const calling = calls.filter((c) => c > 0).length;
  const many = calls.filter((c) => c > 1).length;
  out.push(`Rounds with more than one tool call: ${many} of ${calling} that called a tool (${pct(many, calling)}), ${pct(many, calls.length)} of all rounds.`);
  const starts = timed.map(coldStart).filter((c) => c !== null);
  const cold = starts.filter(Boolean).length;
  out.push(`Timed turns that started on a cold cache: ${cold} of ${starts.length} (${pct(cold, starts.length)}).`);
  const retries = rounds.reduce((sum, r) => sum + (r.retries ?? 0), 0);
  out.push(`Requests tried again: ${retries}. Requests where the chat was summarised: ${rounds.filter((r) => r.compacted).length}.`);
  const batched = rounds.filter((r) => r.edits !== undefined);
  if (batched.length) {
    const edits = batched.reduce((sum, r) => sum + (r.edits ?? 0), 0);
    out.push(`Rounds that used apply_edits: ${batched.length}, listing ${edits} edits between them.`);
  }
  out.push(`Models: ${counted(timed.map((t) => t.model ?? "-"))}.`);
  out.push(`Effort per request: ${counted(turns.flatMap((t) => t.efforts ?? []))}.`);
  out.push(`Routes: ${counted(turns.flatMap((t) => (t.route ? [t.route] : [])))}.`);
  const warmed = warmups.reduce((sum, w) => sum + w.written, 0);
  const read = warmups.reduce((sum, w) => sum + w.cached, 0);
  out.push(
    `Cache warm-ups, which aren't turns: ${warmups.length}, writing ${warmed} tokens and reading ${read}, median ${s1(spread(warmups.map((w) => w.ms)).median)} s. Asked for by ${counted(warmups.map((w) => w.trigger ?? "-"))}.`,
  );
  return out.join("\n");
}
