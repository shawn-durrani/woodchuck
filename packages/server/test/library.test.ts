// The parts library: proposals wait for approval, approved parts are kept in
// the data folder until their pull request merges, and hardware can use them.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyOps, derive, recordConsoleOps, validateLibraryPart } from "@woodchuck/core";
import { Turn, webTools } from "../src/agent.js";
import { PartsLibrary } from "../src/library.js";
import { scriptedClient } from "../src/scripted.js";
import { Store } from "../src/store.js";

const slide = {
  id: "acmeco-glide-450",
  name: "AcmeCo Glide 450 side-mount slide",
  kind: "drawer_slide",
  maker: "AcmeCo",
  sources: [{ url: "https://example.com/acmeco-glide", title: "AcmeCo Glide spec sheet" }],
  specs: { length_mm: 450, clearance_per_side_mm: 12.7, load_kg: 45 },
  shape: [{ name: "slide", min_mm: [0, 0, 0], max_mm: [450, 45, 12.7] }],
};

let dir: string;
let store: Store;
let library: PartsLibrary;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "woodchuck-lib-"));
  store = new Store(path.join(dir, "data"));
  library = new PartsLibrary(path.join(dir, "library"), path.join(dir, "data", "part-proposals.json"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const access = () => ({ list: () => library.list().parts, get: (id: string) => library.get(id), propose: (i: unknown) => library.propose(i) });
const turn = (client: ReturnType<typeof scriptedClient>) =>
  new Turn(store, client, { chat() {}, delta() {}, changed() {} }, () => Buffer.from("png"), access());

describe("the parts library", () => {
  it("offers Claude web search and fetch, outside the design tools", async () => {
    const client = scriptedClient([[{ type: "text", text: "Hi." }]]);
    await turn(client).run({ text: "hello", selection: [] });
    const names = (client.sent[0]!.tools as { name: string }[]).map((t) => t.name);
    expect(names).toContain("web_search");
    expect(names).toContain("web_fetch");
    expect(webTools("AU").map((t) => t.type)).toEqual(["web_search_20260209", "web_fetch_20260209"]);
  });

  it("waits for approval, then keeps the part in the data folder and not in the checkout", async () => {
    const client = scriptedClient([[{ type: "tool_use", id: "p1", name: "propose_library_part", input: slide }]]);
    await turn(client).run({ text: "Use the AcmeCo Glide 450", selection: [] });
    expect(store.project.pending?.waiting).toEqual([{ tool_use_id: "p1", kind: "part" }]);
    expect(library.list().parts).toEqual([]);

    const waiting = library.waiting()!;
    library.approve(waiting.id);
    // Nothing is written into the library folder in the repo, which isn't even made.
    expect(existsSync(path.join(dir, "library"))).toBe(false);
    expect(readdirSync(path.join(dir, "data", "library-pending"))).toEqual(["acmeco-glide-450.json"]);
    const kept = JSON.parse(readFileSync(path.join(dir, "data", "library-pending", "acmeco-glide-450.json"), "utf8"));
    expect(validateLibraryPart(kept.part).approved_at).toBeTruthy();
    expect(kept.pull_request).toEqual({ state: "waiting" });
    // It works at once, and is marked as waiting for its pull request.
    expect(library.get("acmeco-glide-450")).toMatchObject({ id: "acmeco-glide-450", approved_at: kept.part.approved_at });
    expect(library.list().pending).toEqual({ "acmeco-glide-450": { state: "waiting" } });
  });

  it("won't propose a part that's already in the library", async () => {
    library.approve(library.propose(slide).id);
    expect(() => library.propose(slide)).toThrow(/already in the library/);
  });

  it("fills hardware from a library part when Claude uses it", async () => {
    library.approve(library.propose(slide).id);
    store.project.design = applyOps(store.project.design, recordConsoleOps());
    const client = scriptedClient([
      [
        {
          type: "tool_use",
          id: "h1",
          name: "set_hardware",
          input: {
            id: "slides",
            library_part: "acmeco-glide-450",
            connects: ["drawer_side_l", "drawer_side_r", "bottom"],
            place: { x: "left_side.right", y: "drawer_side_l.bottom + 100", z: "drawer_side_l.front - 450", length_axis: "z" },
          },
        },
      ],
      [{ type: "text", text: "Fitted." }],
    ]);
    await turn(client).run({ text: "Use the Glide slides", selection: [] });
    const h = store.project.design.hardware.find((x) => x.id === "slides")!;
    expect(h).toMatchObject({ kind: "drawer_slide", name: "AcmeCo Glide 450 side-mount slide", library_part: "acmeco-glide-450" });
    expect(h.spec).toMatchObject({ load_kg: 45 });
    expect(derive(store.project.design).hardware).toHaveLength(5);
  });

  it("refuses a library part that doesn't exist", async () => {
    store.project.design = applyOps(store.project.design, recordConsoleOps());
    const client = scriptedClient([
      [{ type: "tool_use", id: "h1", name: "set_hardware", input: { id: "slides", library_part: "nope", connects: ["bottom"] } }],
      [{ type: "text", text: "Ok." }],
    ]);
    await turn(client).run({ text: "x", selection: [] });
    const result = (client.sent[1]!.messages.at(-1)!.content as unknown as Record<string, unknown>[])[0]!;
    expect(result).toMatchObject({ is_error: true, content: expect.stringMatching(/isn't in the library/) });
  });
});

describe("the repo's library folder", () => {
  it("holds only valid parts, each in a file named for its id", () => {
    const repoLibrary = new PartsLibrary(path.resolve(__dirname, "../../../library/parts"), path.join(dir, "none.json"));
    expect(repoLibrary.list().broken).toEqual([]);
  });
});
