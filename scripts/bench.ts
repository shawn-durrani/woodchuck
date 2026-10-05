// The quality benchmark: invented tasks sent to Claude for real, through
// the app's own turn loop, with every result checked. It needs an Anthropic
// key and --live, costs money and never runs in CI. Each run gets a
// throwaway data folder in the system's temp folder, so your own designs
// are never touched.
//
//   npx tsx scripts/bench.ts --live [--tasks height,lp-fix] [--repeat 2] [--configs routing,no-routing,medium]
//
// The tasks and their checks live in packages/server/src/quality.ts. Each
// task runs --repeat times, two by default. Each config runs in a process
// of its own, because the app reads the model and effort once at start:
// current keeps your environment, routing and no-routing turn the effort
// routing on and off, an effort's name such as medium holds every turn at
// that level, and routing-<effort> lets turns pick up to it.
//
// --dry-run plays a stand-in for Claude that answers every message with one
// fixed line and changes nothing. It needs no key and costs nothing, so it
// tries the script itself, and every check that needs a change fails.

import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultClient, hasCredentials, MODEL, type MessagesClient } from "../packages/server/src/agent.ts";
import { cacheTtl } from "../packages/server/src/prompt.ts";
import {
  costUsd,
  describeConfig,
  envFor,
  estimateUsd,
  formatTable,
  judge,
  parseBenchArgs,
  runTask,
  summarise,
  verdict,
  type BenchArgs,
  type RunResult,
} from "../packages/server/src/quality.ts";
import { renderPng } from "../packages/server/src/render.ts";
import { scriptedClient } from "../packages/server/src/scripted.ts";
import { Store } from "../packages/server/src/store.ts";

const USAGE = "npx tsx scripts/bench.ts --live [--tasks height,lp-fix] [--repeat 2] [--configs routing,no-routing,medium]";
const SCRIPT = fileURLToPath(import.meta.url);

const parsed = parseBenchArgs(process.argv.slice(2));
if ("error" in parsed) {
  console.error(`${parsed.error}\n\n  ${USAGE}`);
  process.exit(1);
}
const args: BenchArgs = parsed;
if (!args.live && !args.dry) {
  console.error(`This calls Claude for real and costs money. Run it with --live to go ahead:\n\n  ${USAGE}`);
  process.exit(1);
}
if (args.live && !hasCredentials()) {
  console.error("There's no Anthropic key. Put ANTHROPIC_API_KEY in the environment and try again.");
  process.exit(1);
}

/** Claude, or the stand-in for a dry run. */
const client = (): MessagesClient => (args.dry ? scriptedClient([]) : defaultClient());

/** One line a run, with a line for each check that failed. Numbers and ids only, never chat text. */
function report(r: RunResult): string {
  const head = `${r.config}  ${r.task} #${r.run}  ${r.passed ? "pass" : "FAIL"}  ${r.secs.toFixed(1)} s  ${r.rounds} round${r.rounds === 1 ? "" : "s"}  US$${r.usd.toFixed(2)}`;
  return [head, ...r.checks.filter((c) => !c.ok).map((c) => `    ${c.name}: ${c.reason ?? ""}`)].join("\n");
}

/** Runs every task for one config, writing a JSON line a run so a stopped run keeps what it finished. */
async function runConfig(config: string, out: string) {
  const ttl = cacheTtl();
  for (const task of args.tasks) {
    for (let run = 1; run <= args.repeat; run++) {
      const dir = mkdtempSync(path.join(tmpdir(), "woodchuck-bench-"));
      let result: RunResult;
      try {
        const { outcome, usage } = await runTask(task, new Store(dir), client(), (p, views, o) => renderPng(p.design, views, o));
        const checks = judge(task, outcome);
        result = { config, task: task.name, run, passed: checks.every((c) => c.ok), checks, ...usage, usd: costUsd(usage.tokens, MODEL, ttl) };
      } catch (e) {
        const checks = [{ name: "finished", ok: false, reason: `the run stopped: ${(e as Error).message.split("\n")[0]}` }];
        const tokens = { input: 0, cached: 0, written: 0, output: 0 };
        result = { config, task: task.name, run, passed: false, checks, secs: 0, turns: 0, rounds: 0, tool_calls: 0, edits: 0, efforts: "-", tokens, usd: 0 };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      appendFileSync(out, `${JSON.stringify(result)}\n`);
      console.log(report(result));
    }
  }
}

/** Runs each config in a process of its own with its settings, then sums up. */
async function compare() {
  const started = new Date();
  const stamp = started.toISOString().replace(/[:.]/g, "-");
  const total = args.tasks.length * args.repeat * args.configs.length;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  console.log(
    `${args.dry ? "Dry run: a stand-in plays Claude, so nothing is sent and nothing is spent." : "Cost warning:"} ` +
      `${plural(args.tasks.length, "task")} x ${plural(args.repeat, "repeat")} x ${plural(args.configs.length, "config")} is ${plural(total, "run")} on ${MODEL}.`,
  );
  for (const c of args.configs) console.log(`  ${c}: ${describeConfig(c, process.env)}`);
  if (!args.dry) {
    const [low, high] = estimateUsd(args.tasks, args.repeat, args.configs.length, MODEL);
    console.log(`Expect roughly US$${low.toFixed(2)} to US$${high.toFixed(2)}, and your Anthropic account pays for it. A build costs the most.`);
    console.log("Starting in 5 seconds. Press Ctrl-C to stop.\n");
    await new Promise((r) => setTimeout(r, 5_000));
  }

  // Ctrl-C stops the config that's running and skips the rest, and the runs that finished are still summed up. A second one stops at once.
  let stopped = false;
  process.once("SIGINT", () => {
    stopped = true;
  });
  const runs: RunResult[] = [];
  for (const config of args.configs) {
    const out = path.join(tmpdir(), `woodchuck-quality-${stamp}-${config}.jsonl`);
    writeFileSync(out, "");
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(
        process.execPath,
        [
          ...process.execArgv,
          SCRIPT,
          args.dry ? "--dry-run" : "--live",
          "--child",
          config,
          "--out",
          out,
          "--repeat",
          String(args.repeat),
          "--tasks",
          args.tasks.map((t) => t.name).join(","),
        ],
        { env: envFor(config, process.env), stdio: "inherit" },
      );
      child.on("exit", resolve);
    });
    runs.push(...readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as RunResult));
    rmSync(out, { force: true });
    if (code !== 0) console.log(`${config} stopped early, with exit code ${code ?? "none"}.`);
    if (stopped) break;
  }

  const rows = summarise(runs);
  console.log("");
  for (const l of formatTable(rows)) console.log(l);
  console.log("");
  for (const c of args.configs.filter((c) => rows.some((r) => r.config === c))) console.log(verdict(c, rows));
  const file = path.join(tmpdir(), `woodchuck-quality-${stamp}.json`);
  const results = {
    started_at: started.toISOString(),
    finished_at: new Date().toISOString(),
    model: MODEL,
    dry_run: args.dry,
    repeat: args.repeat,
    tasks: args.tasks.map((t) => t.name),
    configs: args.configs.map((name) => ({ name, settings: describeConfig(name, process.env) })),
    runs,
    summary: rows,
  };
  writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`\nResults: ${file}`);
}

if (args.child) await runConfig(args.child, args.out ?? path.join(tmpdir(), `woodchuck-quality-${args.child}.jsonl`));
else await compare();
