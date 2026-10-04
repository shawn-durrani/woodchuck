// The design history: each change set is a version, and any version can
// be restored, compared, copied, downloaded or opened again.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diffDesigns, recordConsoleOps } from "@woodchuck/core";
import { plainTime } from "../src/index.js";
import { Store } from "../src/store.js";

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "woodchuck-versions-"));
  store = new Store(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ops = recordConsoleOps().filter((o) => o.op !== "rename_design");

describe("design versions", () => {
  it("names a restored version's time in plain numbers, the same in any language", () => {
    expect(plainTime(new Date(2026, 9, 5, 9, 7).toISOString())).toBe("2026-10-05 09:07");
    expect(plainTime(new Date(2026, 0, 31, 23, 59).toISOString())).toBe("2026-01-31 23:59");
  });

  it("records each change set, with who made it", () => {
    const p = store.create("Console", ops);
    p.change("you", "Four drawers", [{ op: "set_param", name: "drawers", expr: "4", unit: "count" }]);
    p.undo();
    const log = store.versions.log(p.slug);
    expect(log.map((v) => [v.author, v.message])).toEqual([
      ["You", "Undo: Four drawers"],
      ["You", "Four drawers"],
      ["Woodchuck", "Started from the example"],
    ]);
  });

  it("restores an older version as a change you can undo", () => {
    const p = store.create("Console", ops);
    p.change("claude", "Four drawers", [{ op: "set_param", name: "drawers", expr: "4", unit: "count" }]);
    const first = store.versions.log(p.slug).at(-1)!;
    p.replace(store.versions.show(p.slug, first.sha)!, "you", "Restore the first version");
    expect(p.design.params.find((x) => x.name === "drawers")!.expr).toBe("5");
    p.undo();
    expect(p.design.params.find((x) => x.name === "drawers")!.expr).toBe("4");
  });

  it("shows the version before a change", () => {
    const p = store.create("Console", ops);
    p.change("you", "Four drawers", [{ op: "set_param", name: "drawers", expr: "4", unit: "count" }]);
    const latest = store.versions.log(p.slug)[0]!;
    expect(store.versions.show(p.slug, latest.sha, true)!.params.find((x) => x.name === "drawers")!.expr).toBe("5");
  });

  it("keeps stock settings in the design, so they version and undo in one step", () => {
    const p = store.create("Console", ops);
    p.change("you", "Stock for the cutting layout", [
      { op: "set_stock", kerf_mm: 2.5 },
      { op: "set_stock", material: "ply15", sheet_mm: [2400, 1200] },
    ]);
    expect(p.design.stock).toEqual({ kerf_mm: 2.5, materials: { ply15: { sheet_mm: [2400, 1200] } } });
    const latest = store.versions.log(p.slug)[0]!;
    expect(latest.message).toBe("Stock for the cutting layout");
    const before = store.versions.show(p.slug, latest.sha, true)!;
    expect(diffDesigns(before, store.versions.show(p.slug, latest.sha)!)).toEqual([
      "Changed the saw kerf from 3 to 2.5 mm",
      "Changed stock for ply15 to 2400 × 1200 mm sheets",
    ]);
    p.undo();
    expect(p.design.stock).toBeUndefined();
  });

  it("copies a design into a new one with a fresh chat", () => {
    store.create("Console", ops);
    const copy = store.copy();
    expect(copy.design.name).toBe("Console (copy)");
    expect(copy.chat).toEqual([]);
    expect(store.versions.log(copy.slug)[0]!.message).toBe("Copied from Console");
  });

  it("keeps deleted designs in the history", () => {
    const p = store.create("Console", ops);
    store.remove(p.slug);
    expect(store.versions.log(p.slug)[0]!.message).toBe("Deleted Console");
  });

  it("refuses to show versions by anything but a commit id", () => {
    const p = store.create("Console", ops);
    expect(store.versions.show(p.slug, "HEAD; rm -rf /")).toBeNull();
  });
});
