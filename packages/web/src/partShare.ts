// What a part's pull request says to you, in a few plain words. The Library
// tab and the chat's part card both show it. With no repository named,
// GitHub is off, and a part waiting to be shared says so.

import type { PullRequestStatus } from "./api";
import { PART_KEPT } from "./github";

/** GitHub's own words end however they end, so give them a full stop before the next sentence. */
const stop = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

/** Kept on this computer because GitHub is off, rather than waiting on GitHub. */
const keptHere = (pr: PullRequestStatus, repo: string | null) => repo === null && pr.state === "waiting" && !pr.url;

export function pullRequestNote(pr: PullRequestStatus, repo: string | null): { text: string; retry: boolean } {
  if (keptHere(pr, repo)) return { text: PART_KEPT, retry: false };
  switch (pr.state) {
    case "opening":
      return { text: "Opening a pull request on GitHub.", retry: false };
    case "open":
      return pr.auto_merge
        ? { text: "Pull request open. It merges itself once the checks pass, and the copy on this computer goes when the part arrives.", retry: false }
        : { text: stop(pr.error ?? "The pull request is open, but auto-merge isn't on"), retry: true };
    case "closed":
      return {
        text: `Pull request closed without merging. ${pr.error ? `${stop(pr.error)} ` : ""}The part still works in your designs. Open a new pull request to share it, or remove it from the library.`,
        retry: true,
      };
    default:
      return { text: `Pull request waiting. ${pr.error ? `${stop(pr.error)} ` : ""}The part works in your designs meanwhile.`, retry: true };
  }
}

/** What the button that tries again says. A closed pull request can't be tried again, so it's a new one. */
export const retryLabel = (pr: PullRequestStatus) => (pr.state === "closed" ? "Open a new pull request" : "Retry");

/** Only a part whose pull request was closed can be removed. The others are still on their way. */
export const canRemove = (pr: PullRequestStatus) => pr.state === "closed";

/** A few words for a list row, saying a part is still waiting to be shared. */
export function pullRequestBadge(pr: PullRequestStatus, repo: string | null): string {
  if (keptHere(pr, repo)) return "kept on this computer";
  switch (pr.state) {
    case "opening":
      return "opening pull request";
    case "open":
      return "pull request open";
    case "closed":
      return "pull request closed";
    default:
      return "pull request waiting";
  }
}
