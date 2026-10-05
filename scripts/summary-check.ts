// A live check of summaries between turns: an invented chat sent to Claude
// for real, through the app's own turn loop, then summarised on request.
// It needs an Anthropic key, costs money and never runs in the tests or CI.
// The chat lives in a throwaway data folder in the system's temp folder, so
// your own designs are never touched.
//
//   npx tsx scripts/summary-check.ts --live
//
// The chat states a requirement early and answers a question Claude asks.
// It runs with the API's own summary at its floor of 50,000 tokens until
// the chat holds one, then asks for a summary between turns with a low
// threshold, and runs one more turn. It prints a PASS, FAIL or SKIP line for
// each thing the docs left to a live request, and the summary's length.
// It never prints the summary or anything else Claude wrote. It watches the
// raw stream too, to say which event carried a summary's signature.
//
// WOODCHUCK_MODEL and WOODCHUCK_EFFORT pick the model and effort, the same
// as for the app.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { EFFORT, hasCredentials, keepSignatures, MODEL, Turn, type MessagesClient } from "../packages/server/src/agent.ts";
import { renderPng } from "../packages/server/src/render.ts";
import { Store, type Project } from "../packages/server/src/store.ts";
import { Summaries } from "../packages/server/src/summaries.ts";

/** Said early, and looked for in the summary. */
const REQUIREMENT = "Every drawer must hold 12-inch LPs.";
/** The answer to Claude's question, with a number to look for in the summary. */
const ANSWER = "Undermount slides, 457 mm long. Now build it: a 2040 x 520 x 30 mm top, 30 mm carcass panels, about 400 mm tall, and one row of five drawers.";
const GO_AHEAD = "Yes, go ahead with what you suggest.";
/** Follow-ups that grow the chat until the API summarises it inside a request. */
const GROW = [
  "Draw the front, top, left and iso views, and tell me in one line each what they show.",
  "Run the full checks and list anything that needs fixing.",
  "Oil the whole console in a dark walnut colour, then draw the iso view.",
  "Make the carcass 50 mm taller, then draw the front view.",
];

const args = process.argv.slice(2);
if (!args.includes("--live")) {
  console.error("This calls Claude for real and costs money. Run it with --live to go ahead:\n\n  npx tsx scripts/summary-check.ts --live");
  process.exit(1);
}
if (!hasCredentials()) {
  console.error("There's no Anthropic key. Put ANTHROPIC_API_KEY in the environment and try again.");
  process.exit(1);
}

const scale = ({ "claude-sonnet-5-5": 1, "claude-opus-5-5": 2, "claude-fable-5-1": 5 } as Record<string, number>)[MODEL] ?? 1;
console.log(`Cost warning: this builds an invented chat of up to ${3 + GROW.length} turns on ${MODEL} at ${EFFORT} effort, asks for a summary and runs one more turn.`);
console.log(`Your Anthropic account pays for it. Expect roughly US$${(1 * scale).toFixed(2)} to US$${(3 * scale).toFixed(2)}.`);
console.log("Starting in 5 seconds. Press Ctrl-C to stop.\n");
await new Promise((r) => setTimeout(r, 5_000));

/** Every request the check sends, with what came back. */
interface Sent {
  summary: boolean;
  body: Anthropic.Beta.MessageCreateParamsStreaming;
  message?: Anthropic.Beta.BetaMessage;
  error?: unknown;
  /** The raw events that carried a summary block's signature, by type. */
  signedBy: string[];
}
const log: Sent[] = [];
/** Set for the turn after the summary, so a kept thinking block that fails the check fails the request. */
let strict = false;

// The app's own client, with the raw stream watched for signatures on the way.
const sdk = new Anthropic();
const client: MessagesClient = {
  stream(body) {
    const summary = (body as { compaction?: unknown }).compaction !== undefined;
    const sent =
      strict && !summary ? ({ ...body, thinking: { ...body.thinking, block_binding: { prefix_mismatch_behavior: "error" } } } as Anthropic.Beta.MessageCreateParamsStreaming) : body;
    const entry: Sent = { summary, body: sent, signedBy: [] };
    log.push(entry);
    const raw = sdk.beta.messages.stream(sent);
    const summaries = new Set<number>();
    raw.on("streamEvent", (event) => {
      if (event.type === "content_block_start" && event.content_block.type === "compaction") {
        summaries.add(event.index);
        if (typeof (event.content_block as { signature?: unknown }).signature === "string") entry.signedBy.push(event.type);
      } else if (event.type === "content_block_delta" && summaries.has(event.index) && typeof (event.delta as { signature?: unknown }).signature === "string") {
        entry.signedBy.push(event.delta.type);
      }
    });
    const stream = keepSignatures(raw);
    return {
      on: (event, cb) => stream.on(event, cb),
      abort: () => stream.abort(),
      finalMessage: () =>
        stream.finalMessage().then(
          (m) => {
            entry.message = m;
            return m;
          },
          (e: unknown) => {
            entry.error = e;
            throw e;
          },
        ),
    };
  },
};

type Result = "PASS" | "FAIL" | "SKIP";
const results: [string, Result, string][] = [];
const check = (name: string, result: Result, note = "") => {
  results.push([name, result, note]);
  console.log(`${result.padEnd(4)}  ${name}${note ? ` (${note})` : ""}`);
};
const blocks = (m: Anthropic.Beta.BetaMessageParam | undefined) => (Array.isArray(m?.content) ? (m.content as { type: string }[]) : []);
const holdsThresholdSummary = (p: Project) => p.messages.some((m) => m.role === "assistant" && blocks(m).some((b) => b.type === "compaction"));
const holdsSummary = (m: Anthropic.Beta.BetaMessageParam) => blocks(m).some((b) => b.type === "compaction");
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const dir = mkdtempSync(path.join(tmpdir(), "woodchuck-summary-check-"));
try {
  const store = new Store(dir);
  const project = store.create("Summary check");
  const summaries = new Summaries(store);
  const say = (text: string) =>
    new Turn(store, client, { chat() {}, delta() {}, changed() {} }, (p, views, o) => renderPng(p.design, views, o), undefined, undefined, undefined, summaries).run({
      text,
      selection: [],
    });
  /** Answers a plan, preview or part Claude waits on, so the chat reaches an idle point. */
  const settle = async () => {
    for (let i = 0; i < 3 && project.pending?.waiting.length; i++) await say(GO_AHEAD);
  };

  // The API's own summary at its floor, and none between turns, while the chat grows.
  process.env.WOODCHUCK_COMPACT_AT = "50000";
  process.env.WOODCHUCK_COMPACT_IDLE_AT = "off";

  await say(`I'm making a record console for Alex. ${REQUIREMENT} Before you plan or build anything, ask me one question with ask_user about the drawer slides, and wait for my answer.`);
  const asked = project.pending?.waiting.some((w) => w.kind === "question") ?? false;
  console.log(asked ? "Claude asked its question, and gets the answer." : "Claude didn't ask a question, so the answer goes in as a plain message.");
  await say(ANSWER);
  await settle();
  for (const text of GROW) {
    if (holdsThresholdSummary(project)) break;
    await say(text);
    await settle();
  }
  const threshold = holdsThresholdSummary(project);
  console.log(threshold ? "The API summarised the chat inside a request, so the chat holds an older summary.\n" : "The chat never reached 50,000 tokens, so it holds no older summary.\n");
  // The summary on request refuses one without its signature, so the app sends the whole chat in its place.
  const older = project.messages.findLast((m) => m.role === "assistant" && holdsSummary(m));
  const olderBlock = blocks(older).find((b) => b.type === "compaction") as { signature?: unknown } | undefined;
  const signedBy = log.findLast((s) => !s.summary && s.message?.content.some((b) => b.type === "compaction"))?.signedBy ?? [];
  check(
    "the stored threshold summary has a signature",
    !olderBlock ? "SKIP" : typeof olderBlock.signature === "string" && olderBlock.signature ? "PASS" : "FAIL",
    !olderBlock
      ? "the chat never held one"
      : typeof olderBlock.signature === "string" && olderBlock.signature
        ? `carried by ${signedBy.join(" and ") || "the stream"}`
        : signedBy.length
          ? `the stream carried one in ${signedBy.join(" and ")}, and it wasn't stored`
          : "the API sent none in the stream",
  );

  // Now a summary between turns, at a threshold any chat passes.
  process.env.WOODCHUCK_COMPACT_IDLE_AT = "1000";
  await say("Check that every drawer still holds 12-inch LPs, and tell me in two sentences.");
  await settle();
  if (!summaries.busy && !project.compactions.length) await say("Thanks. Anything left to do? One sentence.");
  await summaries.settled();

  const asking = log.filter((s) => s.summary).at(-1);
  const reply = asking?.message;
  const iterations = (reply?.usage.iterations ?? []) as { type: string; cache_read_input_tokens?: number }[];
  const summaryBlock = reply?.content.find((b) => b.type === "compaction") as { content?: string | null; signature?: string | null } | undefined;
  const text = summaryBlock?.content ?? "";

  if (!asking) {
    check("a summary was asked for", "FAIL", "no request went out");
  } else if (asking.error) {
    check("a summary was asked for", "FAIL", message(asking.error));
  }
  check(
    "finalMessage carries stop_reason compaction and usage.iterations",
    reply?.stop_reason === "compaction" && iterations.some((i) => i.type === "compaction") ? "PASS" : "FAIL",
    `stop_reason ${reply?.stop_reason ?? "none"}, ${iterations.length} iteration${iterations.length === 1 ? "" : "s"}`,
  );
  const cached = iterations.reduce((n, i) => n + (i.cache_read_input_tokens ?? 0), 0);
  check("the summary request reads from the cache", reply ? (cached > 0 ? "PASS" : "FAIL") : "SKIP", `${cached} tokens read from the cache`);
  // Sent from the older summary when it's signed, and as the whole chat without it when it isn't.
  const how = !asking ? "" : holdsSummary(asking.body.messages[0]!) ? "sent from it" : !asking.body.messages.some(holdsSummary) ? "sent whole, without it" : "";
  check(
    "a chat holding an older threshold summary is accepted",
    !threshold || !how ? "SKIP" : reply ? "PASS" : "FAIL",
    !threshold ? "the chat never held one" : !how ? "the summary request didn't start from it" : `${how}, ${reply ? "200" : message(asking?.error)}`,
  );
  console.log(`The summary is ${text.length} characters long.`);
  check("the summary keeps the early requirement", text ? (/\bLPs?\b/i.test(text) && /\b12\b/.test(text) ? "PASS" : "FAIL") : "SKIP", "12-inch LPs");
  check("the summary keeps the answer to the question", text ? (/\b457\b/.test(text) ? "PASS" : "FAIL") : "SKIP", "457 mm slides");

  const kept = project.compactions.at(-1);
  if (!kept) {
    check("the block round-trips as stored", "SKIP", "no summary landed");
    check("the kept turns keep their thinking", "SKIP", "no summary landed");
  } else {
    // The turn after the summary, with a kept thinking block that fails the check failing the request.
    // No new summary starts after it.
    process.env.WOODCHUCK_COMPACT_IDLE_AT = "off";
    strict = true;
    const before = log.length;
    await say("Thanks. What's still to do? One sentence.");
    strict = false;
    const next = log.slice(before).find((s) => !s.summary);
    const first = blocks(next?.body.messages[0])[0] as { type?: string; signature?: string | null } | undefined;
    const thinking = (next?.body.messages ?? []).slice(1).flatMap((m) => (m.role === "assistant" ? blocks(m) : [])).filter((b) => b.type === "thinking" || b.type === "redacted_thinking").length;
    const error = next?.error ? message(next.error) : "";
    const binding = /thinking|bound|binding|prefix/i.test(error) && !/compaction/i.test(error);
    const sentAsStored = first?.type === "compaction" && first.signature === kept.block.signature;
    check(
      "the block round-trips as stored",
      !next ? "FAIL" : !sentAsStored ? "FAIL" : !error || binding ? "PASS" : "FAIL",
      !next ? "no request went out" : !sentAsStored ? "the request didn't start with the stored block" : error ? error.slice(0, 160) : "200",
    );
    const dropped = (next?.message as { input_transformations?: unknown[] | null } | undefined)?.input_transformations ?? [];
    check(
      "the kept turns keep their thinking",
      !next?.message && !binding ? "SKIP" : thinking === 0 ? "SKIP" : !binding && dropped.length === 0 ? "PASS" : "FAIL",
      thinking === 0 ? "the kept turns hold no thinking to check" : binding ? error.slice(0, 160) : `${thinking} kept thinking block${thinking === 1 ? "" : "s"}, ${dropped.length} input transformation${dropped.length === 1 ? "" : "s"}`,
    );
  }

  // A stored summary the API refused sends the chat in full from then on, which the app logs.
  check("no stored summary was refused", project.refused ? "FAIL" : "PASS", project.refused ? `refused once the chat held ${project.refused.messages} messages` : "");

  summaries.stop();
  const count = (r: Result) => results.filter(([, x]) => x === r).length;
  const failed = count("FAIL");
  console.log(`\n${count("PASS")} passed, ${failed} failed and ${count("SKIP")} skipped.`);
  process.exitCode = failed ? 1 : 0;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
