// A live benchmark: a few invented tasks sent to Claude for real, through
// the app's own turn loop, timed. It needs an Anthropic key, costs money
// and never runs in the tests or CI. Each task gets a throwaway data folder
// in the system's temp folder, so your own designs are never touched.
//
//   npx tsx scripts/bench.ts --live [task ...]
//
// The tasks are build, lp-fix, colour and height, and all four run when
// none is named. WOODCHUCK_MODEL and WOODCHUCK_EFFORT pick the model and
// effort, the same as for the app. Each turn picks its own level up to that
// effort unless WOODCHUCK_EFFORT_ROUTING is off, and the report shows the
// levels each task's requests ran at.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { derive, recordConsoleOps, runChecks } from "../packages/core/src/index.ts";
import { defaultClient, EFFORT, hasCredentials, MODEL, Turn } from "../packages/server/src/agent.ts";
import { cacheTtl } from "../packages/server/src/prompt.ts";
import { renderPng } from "../packages/server/src/render.ts";
import { effortRouting } from "../packages/server/src/route.ts";
import { Store, type ChatItem } from "../packages/server/src/store.ts";
import { effortPath } from "../packages/server/src/turnstats.ts";

interface Task {
  name: string;
  /** Starts from the record console example, or from an empty design. */
  example: boolean;
  text: string;
}

const TASKS: Task[] = [
  {
    name: "build",
    example: false,
    text: "Build a long, low record console: a 2040 x 520 x 30 mm top, 30 mm carcass panels, about 400 mm tall, and one row of five drawers that hold 12 inch LPs.",
  },
  { name: "lp-fix", example: true, text: "The LP check fails. Change the drawers so 12-inch LPs fit, and tell me what you changed." },
  { name: "colour", example: true, text: "Oil the whole console in a dark walnut colour." },
  { name: "height", example: true, text: "Make the carcass 50 mm taller." },
];

/** What Claude is told when it stops to ask or to show a plan, so a task runs to the end. */
const GO_AHEAD = "Yes, go ahead with what you suggest.";
const MAX_REPLIES = 3;

/**
 * Price per million tokens on Sonnet 5.5, in US dollars. The app's model list puts Opus 5.5 at about twice and Fable 5.1 at about five times.
 * Writing the cache costs twice the input price for an hour's cache, and 1.25 times for five minutes.
 */
const PRICE = { input: 2, cached: 0.2, written: cacheTtl() === "1h" ? 4 : 2.5, output: 10 };
const SCALE: Record<string, number> = { "claude-sonnet-5-5": 1, "claude-opus-5-5": 2, "claude-fable-5-1": 5 };

type Usage = Extract<ChatItem, { kind: "usage" }>;

const args = process.argv.slice(2);
if (!args.includes("--live")) {
  console.error("This calls Claude for real and costs money. Run it with --live to go ahead:\n\n  npx tsx scripts/bench.ts --live [build|lp-fix|colour|height ...]");
  process.exit(1);
}
if (!hasCredentials()) {
  console.error("There's no Anthropic key. Put ANTHROPIC_API_KEY in the environment and try again.");
  process.exit(1);
}
const named = args.filter((a) => !a.startsWith("--"));
const unknown = named.filter((n) => !TASKS.some((t) => t.name === n));
if (unknown.length) {
  console.error(`There's no task called ${unknown.join(", ")}. The tasks are ${TASKS.map((t) => t.name).join(", ")}.`);
  process.exit(1);
}
const tasks = named.length ? TASKS.filter((t) => named.includes(t.name)) : TASKS;

const scale = SCALE[MODEL] ?? 1;
console.log(
  `Cost warning: this sends ${tasks.length} task${tasks.length === 1 ? "" : "s"} to ${MODEL} at ${effortRouting() ? `up to ${EFFORT}` : EFFORT} effort, and your Anthropic account pays for it.`,
);
console.log(`Expect roughly US$${(0.25 * tasks.length * scale).toFixed(2)} to US$${(0.75 * tasks.length * scale).toFixed(2)}. A build costs the most.`);
console.log("Starting in 5 seconds. Press Ctrl-C to stop.\n");
await new Promise((r) => setTimeout(r, 5_000));

const cost = (u: { input: number; cached: number; written: number; output: number }) =>
  ((u.input * PRICE.input + u.cached * PRICE.cached + u.written * PRICE.written + u.output * PRICE.output) / 1e6) * scale;

const client = defaultClient();
const header = ["task", "turns", "rounds", "secs", "tool calls", "edits", "effort", "output", "cached", "written", "input", "US$", "check errors"];
const widths = [7, 5, 6, 6, 10, 5, 16, 7, 8, 8, 7, 5, 12];
const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
console.log(line(header));

for (const task of tasks) {
  const dir = mkdtempSync(path.join(tmpdir(), "woodchuck-bench-"));
  try {
    const store = new Store(dir);
    const project = store.create(`Bench ${task.name}`, task.example ? recordConsoleOps().filter((o) => o.op !== "rename_design") : []);
    const errors = () => runChecks(project.design, derive(project.design)).errors;
    const before = errors();
    const run = (text: string) => new Turn(store, client, { chat() {}, delta() {}, changed() {} }, (p, views, o) => renderPng(p.design, views, o)).run({ text, selection: [] });
    await run(task.text);
    for (let i = 0; i < MAX_REPLIES && project.pending?.waiting.length; i++) await run(GO_AHEAD);
    const usages = project.chat.filter((c): c is Usage => c.kind === "usage");
    const rounds = usages.flatMap((u) => u.rounds ?? []);
    const sum = (k: "input" | "cached" | "written" | "output") => usages.reduce((s, u) => s + (u[k] ?? 0), 0);
    const total = { input: sum("input"), cached: sum("cached"), written: sum("written"), output: sum("output") };
    const failed = project.chat.some((c) => c.kind === "error" && !c.retry);
    console.log(
      line([
        task.name,
        String(usages.length),
        String(rounds.length),
        (usages.reduce((s, u) => s + (u.ms ?? 0), 0) / 1000).toFixed(1),
        String(rounds.reduce((s, r) => s + r.calls, 0)),
        // Edits listed in apply_edits calls, each of which counts as one tool call.
        String(rounds.reduce((s, r) => s + (r.edits ?? 0), 0)),
        effortPath(rounds.map((r) => r.effort)).slice(0, 16),
        String(total.output),
        String(total.cached),
        String(total.written),
        String(total.input),
        cost(total).toFixed(2),
        `${before} -> ${errors()}${failed ? ", turn failed" : ""}`,
      ]),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
