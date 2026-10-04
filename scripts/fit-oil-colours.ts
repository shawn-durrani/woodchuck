// Writes each Linolie colour's tint and pigment in packages/core/src/finishes.ts
// again, from its swatch and cover, with fitFinish. Run it after changing a
// swatch or a cover:
//
//   npx tsx scripts/fit-oil-colours.ts
//
// Natur is Linolie's clear oil, so its photo is the Douglas fir every other
// colour is fitted against, and it keeps no tint and no pigment of its own.
// A test fails when the file and the fit disagree.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PALETTES, fitFinish } from "../packages/core/src/finishes.ts";

const FILE = fileURLToPath(new URL("../packages/core/src/finishes.ts", import.meta.url));
const palette = PALETTES.find((p) => p.id === "satin_wood_oil")!;
const sample = palette.colours.find((c) => c.id === "natur")!.swatch!;

let text = readFileSync(FILE, "utf8");
let changed = 0;
for (const c of palette.colours) {
  if (c.cover === 0) continue;
  const { tint, pigment } = fitFinish(c.swatch!, c.cover, sample);
  const line = new RegExp(`^(\\s*\\{ id: "${c.id}",.*?tint: )\\[[^\\]]*\\](.*?pigment: )"#[0-9a-f]{6}"`, "m");
  if (!line.test(text)) throw new Error(`Couldn't find the line for ${c.id} in finishes.ts`);
  const next = text.replace(line, `$1[${tint.join(", ")}]$2"${pigment}"`);
  if (next !== text) changed++;
  text = next;
}
writeFileSync(FILE, text);
console.log(`Fitted ${palette.colours.length - 1} Linolie colours against Natur's ${sample}; ${changed} changed.`);
