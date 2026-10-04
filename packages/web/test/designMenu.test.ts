// The design menu on the design's name: one place for whole-design
// actions, Delete last, each calling the endpoint the old buttons did.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerState } from "../src/api.js";
import { DesignMenu } from "../src/components/DesignMenu.js";
import { DESIGN_MENU, DOWNLOAD_URL, deleteQuestion, designActions, designItem, needsYou, openDesignFile } from "../src/designMenu.js";

/** Every request the page sends, as path and body. */
function recordFetch() {
  const sent: { path: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: { body?: string }) => {
      sent.push({ path, body: init?.body ? JSON.parse(init.body) : undefined });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  return sent;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const state = (over: Partial<ServerState> = {}) =>
  ({
    project: { slug: "reading-bench", name: "Reading bench with book shelf" },
    projects: [
      { slug: "reading-bench", name: "Reading bench with book shelf", starred: false, changed: "2026-10-03T09:00:00Z" },
      { slug: "bedside-table", name: "Bedside table", starred: true, changed: "2026-10-01T09:00:00Z" },
      { slug: "record-console", name: "Record console", starred: false, changed: "2026-10-02T09:00:00Z" },
    ],
    design: { name: "Reading bench with book shelf" },
    busy: false,
    library: { proposals: [{}] },
    tool_requests: [{ status: "open" }, { status: "built" }],
    ...over,
  }) as unknown as ServerState;

const noop = () => {};
const menu = (s: ServerState) => renderToStaticMarkup(createElement(DesignMenu, { state: s, open: true, onOpen: noop, onResult: noop, onSwitched: noop, onShowAll: noop, onSaved: noop }));
const items = (markup: string) => [...markup.matchAll(/data-control="design\.([a-z]+)"[^>]*>.*?<span class="menu-label">([^<]+)<\/span>/g)].map((m) => [m[1], m[2]]);

describe("the design menu", () => {
  it("lists the phone layout's items in its groups, with Delete last", () => {
    const labels = DESIGN_MENU.map((id) => (id === "-" ? "-" : designItem(id).label));
    expect(labels).toEqual([
      "Rename",
      "Open…",
      "Start fresh",
      "Duplicate",
      "Download",
      "Open a file",
      "Star this design",
      "-",
      "All designs and parts",
      "Your workshop",
      "Open the record console example",
      "-",
      "Delete design…",
    ]);
    expect(designItem("star", true).label).toBe("Unstar this design");
    const drawn = items(menu(state()));
    expect(drawn.map(([, label]) => label)).toEqual(labels.filter((l) => l !== "-"));
    expect(drawn.at(-1)).toEqual(["delete", "Delete design…"]);
    expect(menu(state())).toContain('class="menu-item danger"');
  });

  it("says Unstar for a starred design, and counts what needs you", () => {
    const starred = state({ projects: [{ slug: "reading-bench", name: "Reading bench with book shelf", starred: true, changed: null }] });
    expect(menu(starred)).toContain("Unstar this design");
    expect(needsYou(state())).toBe(2);
    expect(menu(state())).toContain("2 need you");
    expect(menu(state({ library: { proposals: [] } as unknown as ServerState["library"], tool_requests: [] }))).not.toContain("need");
  });

  it("holds back the actions that switch designs while Claude works, and only those", () => {
    const markup = menu(state({ busy: true }));
    const greyed = (id: string) => new RegExp(`aria-disabled="true"[^>]*data-control="design\\.${id}"`).test(markup);
    for (const id of ["open", "new", "duplicate", "import", "example", "delete"]) expect(greyed(id), id).toBe(true);
    // Renaming is an edit, which works mid-build.
    for (const id of ["rename", "download", "star", "all", "workshop"]) expect(greyed(id), id).toBe(false);
    expect(markup).toContain('title="Claude is working. Wait or stop it first."');
    // Nothing is hidden: the same items, greyed or not.
    expect(items(markup).map(([id]) => id)).toEqual(items(menu(state())).map(([id]) => id));
  });

  it("calls the same endpoints the old buttons did", async () => {
    const sent = recordFetch();
    await designActions.rename("Reading bench, longer");
    await designActions.open("bedside-table");
    await designActions.startFresh();
    await designActions.duplicate();
    await designActions.openFile({ name: "Shelf" });
    await designActions.example();
    await designActions.star("reading-bench", true);
    await designActions.remove("reading-bench");
    expect(sent).toEqual([
      { path: "/api/ops", body: { ops: [{ op: "rename_design", name: "Reading bench, longer" }], label: "Rename to Reading bench, longer" } },
      { path: "/api/projects/open", body: { slug: "bedside-table" } },
      { path: "/api/projects", body: {} },
      { path: "/api/projects/copy", body: {} },
      { path: "/api/projects/import", body: { design: { name: "Shelf" } } },
      { path: "/api/projects", body: { name: "Record console example", example: "record_console" } },
      { path: "/api/projects/star", body: { slug: "reading-bench", starred: true } },
      { path: "/api/projects/delete", body: { slug: "reading-bench" } },
    ]);
    expect(DOWNLOAD_URL).toBe("/api/design.json");
    expect(deleteQuestion("Reading bench")).toBe(`Delete "Reading bench" and its chat? This can't be undone.`);
  });

  it("opens a design file, and refuses one that isn't a design without sending it", async () => {
    const sent = recordFetch();
    expect(await openDesignFile("not json")).toEqual({ ok: false, error: "That file isn't a Woodchuck design" });
    expect(sent).toEqual([]);
    expect(await openDesignFile('{"name":"Shelf"}')).toEqual({ ok: true });
    expect(sent).toEqual([{ path: "/api/projects/import", body: { design: { name: "Shelf" } } }]);
  });
});
