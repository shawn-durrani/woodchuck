// Closes the loop on missing tools. A request sent to Claude Code becomes a
// GitHub issue; when that issue closes because a PR merged, the tool is
// built, and it's in the app once Woodchuck is updated. This checks the
// issues and marks the requests, then tells each design that asked.

import { execFile } from "node:child_process";
import type { ChatItem, Store, StoredToolRequest } from "./store.js";

export interface IssueState {
  closed: boolean;
  /** Closed as completed, rather than as not planned. */
  completed: boolean;
  /** The merged PR that closed it, if GitHub links one. */
  pr?: { number: number; url: string };
}

export type IssueLookup = (url: string) => Promise<IssueState | null>;

/** Reads an issue's state with gh. Returns null when GitHub can't be reached. */
export function ghIssueLookup(): IssueLookup {
  return (url) =>
    new Promise((resolve) => {
      execFile("gh", ["issue", "view", url, "--json", "state,stateReason,closedByPullRequestsReferences"], { timeout: 20_000 }, (err, stdout) => {
        if (err) return resolve(null);
        try {
          const j = JSON.parse(stdout) as {
            state: string;
            stateReason?: string;
            closedByPullRequestsReferences?: { number: number; url: string }[];
          };
          const pr = j.closedByPullRequestsReferences?.[0];
          resolve({
            closed: j.state === "CLOSED",
            completed: j.state === "CLOSED" && j.stateReason !== "NOT_PLANNED",
            ...(pr ? { pr: { number: pr.number, url: pr.url } } : {}),
          });
        } catch {
          resolve(null);
        }
      });
    });
}

const now = () => new Date().toISOString();

/**
 * Checks every request that was sent to Claude Code and is still waiting.
 * Returns the ones that changed, so the caller can refresh the app.
 */
export async function syncToolRequests(store: Store, lookup: IssueLookup): Promise<StoredToolRequest[]> {
  const changed: StoredToolRequest[] = [];
  for (const r of store.toolRequests()) {
    if (!r.issue_url || (r.status !== "open" && r.status !== "approved")) continue;
    const issue = await lookup(r.issue_url);
    if (!issue?.closed) continue;
    const status = issue.completed ? "built" : "declined";
    store.setToolRequestStatus(r.id, status, issue.pr?.url);
    changed.push({ ...r, status, ...(issue.pr ? { pr_url: issue.pr.url } : {}) });
    if (status === "built") tellDesigns(store, r, issue.pr);
  }
  return changed;
}

/** Puts a note in every design whose chat asked for the tool, for you and for Claude. */
function tellDesigns(store: Store, r: StoredToolRequest, pr?: { number: number; url: string }) {
  for (const { slug } of store.list()) {
    const project = store.peek(slug);
    if (!project.chat.some((c) => c.kind === "tool_request" && c.request === r.id)) continue;
    const item: ChatItem = { id: `b${Date.now().toString(36)}${r.id}`, kind: "tool_built", request: r.id, at: now(), ...(pr ? { pr_url: pr.url } : {}) };
    project.addChat(item);
    project.news.push(
      `the ${r.name} tool you asked for (${r.id}) has been built and merged${pr ? ` (PR #${pr.number})` : ""}. Once Woodchuck is updated it's among your tools, so use it then to finish what you couldn't before`,
    );
    project.save();
  }
}
