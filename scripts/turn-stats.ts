// Prints where Claude's turns spend their time, from the chats in a data
// folder: rounds, seconds, tool calls and tokens, turn by turn, then the
// medians across them all. It prints numbers only, never chat text or
// design names, and changes nothing.
//
//   npx tsx scripts/turn-stats.ts [data-folder]
//
// With no folder named, it reads WOODCHUCK_DATA_DIR, or the app's own
// data folder.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { readTurns, report } from "../packages/server/src/turnstats.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const arg = process.argv[2];
const dir = arg ? path.resolve(arg) : path.resolve(ROOT, process.env.WOODCHUCK_DATA_DIR || "data");

try {
  console.log(report(readTurns(dir)));
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
