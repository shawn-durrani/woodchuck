// Shares an approved part by opening a pull request that adds its file to the
// repo's library/parts folder. The part works from the data folder meanwhile,
// and its copy there is dropped once the file arrives with an update.

import type { LibraryPart } from "@woodchuck/core";
import { parseRepo, type GitHub } from "./github.js";

/** Where a part's pull request has got to. A merged one ends in the hand-over, so it has no state here. */
export interface PullRequestStatus {
  /**
   * "waiting" until GitHub has the pull request, then "open". "closed" is a
   * pull request closed without merging, which the app notices later and
   * which waits for you to open a new one or remove the part. "opening" is
   * shown while a try is running, and never kept.
   */
  state: "opening" | "waiting" | "open" | "closed";
  url?: string;
  number?: number;
  /** Auto-merge is on, so it merges itself once its checks pass. */
  auto_merge?: boolean;
  /** The last thing GitHub refused or couldn't do, in plain words. */
  error?: string;
}

export const partBranch = (id: string) => `part/${id}`;
export const partFilePath = (id: string) => `library/parts/${id}.json`;

/** The file as it sits in the repo, the same bytes whether it's pending or merged. */
export const partFileContent = (part: LibraryPart) => `${JSON.stringify(part, null, 2)}\n`;

/** Part text comes from web pages, so it goes in code spans, where GitHub never turns it into a mention or a link. */
const code = (s: string, max = 300) => {
  const one = s.replace(/\s+/g, " ").trim();
  return `\`${(one.length > max ? `${one.slice(0, max - 1)}…` : one).replace(/`/g, "'")}\``;
};

const link = (url: string) => (/^https?:\/\/[^\s<>`]+$/.test(url) ? `<${url}>` : code(url));

/** The pull request's title and body, in the house shape for a pull request. */
export function partPullRequestText(part: LibraryPart): { title: string; body: string } {
  const name = part.name.replace(/\s+/g, " ").trim();
  const title = `Add ${name.length > 120 ? `${name.slice(0, 119)}…` : name} to the parts library`;
  const made = [part.maker && `made by ${code(part.maker)}`, part.model && `model ${code(part.model)}`, part.sku && `SKU ${code(part.sku)}`].filter(Boolean);
  const specs = Object.entries(part.specs).slice(0, 30);
  const sources = part.sources.map((s) => {
    const label = [s.title && code(s.title), s.url && link(s.url), s.note && code(s.note)].filter(Boolean);
    return `  - ${label.join(", ")}`;
  });
  const body = [
    `You approved ${code(part.name)} in Woodchuck, so the app opened this pull request to share it. It adds the one file ${code(partFilePath(part.id))} and changes nothing else. Once it's merged and Woodchuck is updated, the copy kept in the app's data folder is dropped.`,
    "",
    "Risk of acting: small. It adds one data file that a test checks, and no design uses a part until someone places it. Risk of leaving it: the part stays only on the computer that approved it, and nothing else can use it.",
    "",
    "What prompted it: you approved the part in the Woodchuck chat.",
    "",
    "## Detail",
    "",
    `- **Part:** ${code(part.name)} (${code(part.id)}), a ${part.kind.replace(/_/g, " ")}${made.length ? `, ${made.join(", ")}` : ""}`,
    "- **Key specs:**",
    ...specs.map(([k, v]) => `  - ${code(k)}: ${typeof v === "number" ? v : code(v)}`),
    ...(Object.keys(part.specs).length > specs.length ? [`  - and ${Object.keys(part.specs).length - specs.length} more in the file`] : []),
    ...(part.mounting ? [`- **Mounting:** ${code(part.mounting, 500)}`] : []),
    "- **Sources:**",
    ...sources,
    "",
    "Opened from the Woodchuck app.",
  ].join("\n");
  return { title, body };
}

const reason = (e: unknown) => {
  const msg = (e as Error).message.replace(/\s+/g, " ").trim();
  return msg.length > 300 ? `${msg.slice(0, 299)}…` : msg;
};

/**
 * Opens the pull request, and turns on auto-merge. It is safe to run again:
 * a pull request that's already open is reused, so a retry only does what's
 * missing. GitHub failing never throws. It comes back as the status to keep.
 */
export async function openPartPullRequest(github: GitHub, repoName: string, part: LibraryPart, before?: PullRequestStatus): Promise<PullRequestStatus> {
  const head = partBranch(part.id);
  let pr: { number: number; url: string } | null;
  try {
    const repo = parseRepo(repoName).full;
    pr = await github.findPullRequest(repo, head);
    if (!pr) {
      const { title, body } = partPullRequestText(part);
      const main = await github.mainCommit(repo);
      const blob = await github.createBlob(repo, partFileContent(part));
      const tree = await github.createTree(repo, main.tree, { path: partFilePath(part.id), blob });
      const commit = await github.createCommit(repo, { message: title, tree, parent: main.sha });
      await github.setBranch(repo, head, commit);
      pr = await github.createPullRequest(repo, { base: "main", head, title, body });
    }
    try {
      await github.enableAutoMerge(repo, pr.number);
    } catch (e) {
      return { state: "open", url: pr.url, number: pr.number, auto_merge: false, error: `The pull request is open, but auto-merge isn't on: ${reason(e)}` };
    }
  } catch (e) {
    // Keep what an earlier try learned, so an open pull request doesn't show as waiting, nor a closed one as open.
    return before?.url ? { ...before, state: before.state === "closed" ? "closed" : "open", error: reason(e) } : { state: "waiting", error: reason(e) };
  }
  return { state: "open", url: pr.url, number: pr.number, auto_merge: true };
}
