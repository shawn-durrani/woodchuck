// Issue #42: render_views can draw the finished look, so after setting
// finishes Claude sees the colours the woodworker sees. The plain look stays
// the default, and its pictures stay byte for byte as they were. The
// finishes on the record console are invented.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyOps, derive, emptyDesign, finishedColour, recordConsoleOps, renderSheet, type Design, type Op, type ViewName } from "@woodchuck/core";
import { Turn } from "../src/agent.js";
import { SYSTEM_PROMPT } from "../src/prompt.js";
import { renderPng, renderSvg, type RenderOptions } from "../src/render.js";
import { scriptedClient } from "../src/scripted.js";
import { Store } from "../src/store.js";
import { runTool, TOOLS, type ToolContext } from "../src/tools.js";

type Block = Record<string, unknown>;

const FINISHES: Op[] = [
  { op: "set_finish", targets: ["material:carcass_30", "material:top_30"], finish: "amsterdam" },
  { op: "set_finish", targets: ["false_front"], finish: "roussillon" },
];
const finishedConsole = (): Design => applyOps(emptyDesign("t"), [...recordConsoleOps(), ...FINISHES]);
const VIEWS: ViewName[] = ["front", "top", "left", "iso"];

describe("render_views", () => {
  const tool = TOOLS.find((t) => t.name === "render_views")!;

  it("offers the plain and finished looks, and says when to use each", () => {
    const props = tool.input_schema.properties as Record<string, { type: string; enum?: string[] }>;
    expect(props.look).toEqual({ type: "string", enum: ["plain", "finished"], description: "Default: plain" });
    expect(tool.description).toContain("The plain look, the default, is for geometry, ids and sizes.");
    expect(tool.description).toContain("use it to check colours or finishes before you tell the woodworker they're on");
    expect(tool.description).toContain("Its colours are estimates, like the app's.");
    expect(SYSTEM_PROMPT).toContain("to check finishes before you say they're on, render with look finished");
  });

  const run = (input: Block) => {
    const asked: RenderOptions[] = [];
    const design = finishedConsole();
    const ctx: ToolContext = {
      library: { list: () => [], get: () => undefined, propose: () => ({ id: "", part: {} as never }) },
      design: () => design,
      apply: () => {
        throw new Error("Drawing never changes the design");
      },
      requestTool: () => ({ id: "", count: 0 }),
      renderPng: (_views, opts) => {
        asked.push(opts);
        return Buffer.from("png");
      },
    };
    return { out: runTool("render_views", input, ctx), asked };
  };
  const words = (out: ReturnType<typeof runTool>) => (out.content as unknown as Block[]).find((b) => b.type === "text")!.text;

  it("draws the plain look unless asked, and says so as it always has", () => {
    const { out, asked } = run({});
    expect(asked).toEqual([{ highlight: undefined, isolate: undefined, xray: false, look: "plain" }]);
    expect(words(out)).toBe("Views: front, top, left, iso. Part ids are written on the parts. Overall sizes are marked on the flat views.");
  });

  it("draws the finished look when asked, and says its colours are estimates", () => {
    const { out, asked } = run({ views: ["front", "iso"], look: "finished" });
    expect(asked).toEqual([{ highlight: undefined, isolate: undefined, xray: false, look: "finished" }]);
    expect(words(out)).toBe(
      "Views: front, iso, finished look. Each face shows its timber with its finish as one flat colour, an estimate like the app's. Part ids are written on the parts. Overall sizes are marked on the flat views.",
    );
  });

  it("refuses a look it doesn't have", () => {
    const { out, asked } = run({ look: "photo" });
    expect(out).toMatchObject({ isError: true, content: "Unknown look photo. Looks: plain, finished" });
    expect(asked).toEqual([]);
  });
});

describe("the server's pictures", () => {
  it("draw the plain look byte for byte as the sheet always was", () => {
    const design = finishedConsole();
    const sheet = renderSheet(VIEWS, derive(design), { labels: true }).svg;
    expect(renderSvg(design, VIEWS)).toBe(sheet);
    expect(renderSvg(design, VIEWS, { look: "plain" })).toBe(sheet);
    // The plain look shows no finish, so finishing the console leaves it as it was.
    expect(renderSvg(applyOps(emptyDesign("t"), recordConsoleOps()), VIEWS)).toBe(sheet);
  });

  it("draw the finished look in each part's finish", () => {
    const svg = renderSvg(finishedConsole(), VIEWS, { look: "finished" });
    expect(svg).toContain(">Front, finished</text>");
    // The carcass and the fronts are sheets that name no timber, so they show as birch ply, and the solid top as oak.
    for (const finish of ["amsterdam", "roussillon"]) expect(svg).toContain(`fill="${finishedColour("birch_ply", `satin_wood_oil/${finish}`)}"`);
    expect(svg).toContain(`fill="${finishedColour("tasmanian_oak", "satin_wood_oil/amsterdam")}"`);
    expect(renderPng(finishedConsole(), ["front"], { look: "finished" }).subarray(1, 4).toString()).toBe("PNG");
  });
});

describe("a turn that checks its finishes", () => {
  let dir: string;
  let store: Store;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "woodchuck-finished-"));
    store = new Store(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("hands Claude a picture of the finished look", async () => {
    store.project.apply(recordConsoleOps());
    const call = (id: string, name: string, input: Block): Block => ({ type: "tool_use", id, name, input });
    const client = scriptedClient([
      [call("f1", "set_finish", { targets: ["material:carcass_30", "material:top_30"], finish: "amsterdam" }), call("f2", "set_finish", { targets: ["false_front"], finish: "roussillon" })],
      [call("r1", "render_views", { views: ["front"], look: "finished" })],
      [{ type: "text", text: "The carcass is in Amsterdam and the fronts in Roussillon." }],
    ]);
    const drawn: RenderOptions[] = [];
    await new Turn(store, client, { chat() {}, delta() {}, changed() {} }, (project, views, opts) => {
      drawn.push(opts);
      return renderPng(project.design, views, opts);
    }).run({ text: "Oil the carcass in Amsterdam and the fronts in Roussillon, then check them", selection: [] });

    expect(drawn.map((o) => o.look)).toEqual(["finished"]);
    const result = (client.sent[2]!.messages.at(-1)!.content as unknown as Block[]).find((b) => b.tool_use_id === "r1")!;
    const [image, text] = result.content as Block[];
    expect(image).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png" } });
    expect(String(text!.text)).toMatch(/^Views: front, finished look\./);
  });
});
