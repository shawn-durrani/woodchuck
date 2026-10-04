// The History tab's one list. Each change set you or Claude make is saved as
// a version in the design's git history, so this session's change sets and
// the saved versions are mostly the same changes. They're merged into one
// list, newest first: who made each change, what it was, when, and the
// version behind it to compare or restore. Kept free of React so the tests
// can hold it.

import type { ServerState } from "./api";

type Change = ServerState["history"][number];
type Version = ServerState["versions"][number];

export interface HistoryRow {
  key: string;
  /** Who made it, as the list says it. */
  who: string;
  /** Which colour the name takes. */
  whoClass: "you" | "claude" | "example" | "woodchuck";
  /** What changed, in the change set's own words. */
  label: string;
  at: string;
  /** The saved version, to compare with the one before and to restore. */
  sha?: string;
  /** The design as it is now. Restoring it would change nothing. */
  latest: boolean;
  /** One of this session's change sets, which Undo can take back. */
  session: boolean;
}

/** How each change set's author is named in the version history. */
const VERSION_AUTHOR: Record<Change["author"], string> = { you: "You", claude: "Claude", example: "Woodchuck" };
const SHOWN: Record<Change["author"], { who: string; whoClass: HistoryRow["whoClass"] }> = {
  you: { who: "You", whoClass: "you" },
  claude: { who: "Claude", whoClass: "claude" },
  example: { who: "Example", whoClass: "example" },
};

/** A change set and its version are saved within this long of each other. */
const SAME_CHANGE_MS = 10_000;

/** A version's message, as the server saves a change set's label. */
const messageOf = (label: string) => label.slice(0, 200) || "Change";

function versionWho(author: string): { who: string; whoClass: HistoryRow["whoClass"] } {
  const v = author.toLowerCase();
  if (v === "you" || v === "claude") return { who: author, whoClass: v };
  return { who: author, whoClass: "woodchuck" };
}

/** This session's change sets and the saved versions as one list, newest first. */
export function historyRows(history: Change[], versions: Version[]): HistoryRow[] {
  const used = new Set<string>();
  const rows: HistoryRow[] = [];
  // Each change set takes the nearest unclaimed version with its words and author.
  for (const h of [...history].reverse()) {
    const t = Date.parse(h.at);
    let best: Version | undefined;
    for (const v of versions) {
      if (used.has(v.sha) || v.author !== VERSION_AUTHOR[h.author] || v.message !== messageOf(h.label)) continue;
      const gap = Math.abs(Date.parse(v.at) - t);
      if (gap > SAME_CHANGE_MS) continue;
      if (!best || gap < Math.abs(Date.parse(best.at) - t)) best = v;
    }
    if (best) used.add(best.sha);
    rows.push({ key: `h${h.id}`, ...SHOWN[h.author], label: h.label, at: h.at, ...(best ? { sha: best.sha } : {}), latest: false, session: true });
  }
  for (const v of versions) {
    if (used.has(v.sha)) continue;
    rows.push({ key: v.sha, ...versionWho(v.author), label: v.message, at: v.at, sha: v.sha, latest: false, session: false });
  }
  rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  // The newest version is the design as it is now.
  const newest = versions[0]?.sha;
  for (const row of rows) row.latest = !!newest && row.sha === newest;
  return rows;
}
