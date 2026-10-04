// The design menu on the design's name: everything you do to a whole
// design, in one place, with Delete last. Each action calls the same
// endpoint the old buttons did. The phone layout uses the same items
// under the same names, in the same groups.

import { post } from "./api";

export type DesignItem = "rename" | "open" | "new" | "duplicate" | "download" | "import" | "star" | "all" | "workshop" | "example" | "delete";

/** The menu in order, with "-" for a divider. */
export const DESIGN_MENU: (DesignItem | "-")[] = ["rename", "open", "new", "duplicate", "download", "import", "star", "-", "all", "workshop", "example", "-", "delete"];

/** Each item's words. Star's label depends on whether the design is starred. */
export function designItem(id: DesignItem, starred = false): { label: string; tip: string } {
  switch (id) {
    case "rename":
      return { label: "Rename", tip: "Rename this design" };
    case "open":
      return { label: "Open…", tip: "Open another design, starred ones first" };
    case "new":
      return { label: "Start fresh", tip: "A blank design with a fresh chat. Your other designs stay in the list." };
    case "duplicate":
      return { label: "Duplicate", tip: "Save a copy of this design and open it" };
    case "download":
      return { label: "Download", tip: "Download this design as a file" };
    case "import":
      return { label: "Open a file", tip: "Open a design from a file" };
    case "star":
      return starred ? { label: "Unstar this design", tip: "Take this design off the top of the list" } : { label: "Star this design", tip: "Keep this design at the top of the list" };
    case "all":
      return { label: "All designs and parts", tip: "Your designs, the parts library, missing tools and your workshop, on one page" };
    case "workshop":
      return { label: "Your workshop", tip: "The tools you have, your usual finishes, and the language and country Claude uses" };
    case "example":
      return { label: "Open the record console example", tip: "Open a new copy of the record console example" };
    case "delete":
      return { label: "Delete design…", tip: "Delete this design and its chat, after you confirm" };
  }
}

/** Items that open, add or delete a design, so they wait while Claude works. Renaming is an edit, which works mid-build. */
export const WAITS_FOR_CLAUDE: ReadonlySet<DesignItem> = new Set(["open", "new", "duplicate", "import", "example", "delete"]);

/** Where Download fetches the design from. */
export const DOWNLOAD_URL = "/api/design.json";

/** The question Delete asks before it deletes. */
export const deleteQuestion = (name: string) => `Delete "${name}" and its chat? This can't be undone.`;

/** The calls behind the menu, the same ones the top bar, the name and the Versions tab made. */
export const designActions = {
  rename: (name: string) => post("/api/ops", { ops: [{ op: "rename_design", name }], label: `Rename to ${name}` }),
  open: (slug: string) => post("/api/projects/open", { slug }),
  startFresh: () => post("/api/projects", {}),
  duplicate: () => post("/api/projects/copy"),
  openFile: (design: unknown) => post("/api/projects/import", { design }),
  example: () => post("/api/projects", { name: "Record console example", example: "record_console" }),
  star: (slug: string, starred: boolean) => post("/api/projects/star", { slug, starred }),
  remove: (slug: string) => post("/api/projects/delete", { slug }),
};

/** A design file's contents, or a plain reason it isn't one. */
export async function openDesignFile(text: string): Promise<{ ok: boolean; error?: string }> {
  let design: unknown;
  try {
    design = JSON.parse(text);
  } catch {
    return { ok: false, error: "That file isn't a Woodchuck design" };
  }
  const r = await designActions.openFile(design);
  return r.ok ? r : { ok: false, error: r.error ?? "Couldn't open that file" };
}

/** How many library parts and missing tools wait for you, for the badge on "All designs and parts". */
export function needsYou(state: { library: { proposals: unknown[] }; tool_requests: { status: string }[] }): number {
  return state.library.proposals.length + state.tool_requests.filter((r) => r.status === "open").length;
}
