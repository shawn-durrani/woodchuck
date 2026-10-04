// What a part's pull request says to you, and what it says while
// GitHub is off because no repository is named.

import { describe, expect, it } from "vitest";
import { PART_KEPT } from "../src/github.js";
import { canRemove, pullRequestBadge, pullRequestNote, retryLabel } from "../src/partShare.js";

const REPO = "globex/woodchuck";

describe("a part's pull request, in words", () => {
  it("says it's waiting when GitHub couldn't be reached, offers a retry, and says the part still works", () => {
    const n = pullRequestNote({ state: "waiting", error: "Couldn't reach GitHub." }, REPO);
    expect(n.text).toBe("Pull request waiting. Couldn't reach GitHub. The part works in your designs meanwhile.");
    expect(n.retry).toBe(true);
  });

  it("ends GitHub's words with a full stop before the next sentence", () => {
    expect(pullRequestNote({ state: "waiting", error: "error connecting to api.github.com" }, REPO).text).toBe(
      "Pull request waiting. error connecting to api.github.com. The part works in your designs meanwhile.",
    );
  });

  it("says it's open and merges itself, with nothing to retry", () => {
    const n = pullRequestNote({ state: "open", url: "https://github.com/globex/woodchuck/pull/9", number: 9, auto_merge: true }, REPO);
    expect(n.text).toMatch(/^Pull request open\. It merges itself/);
    expect(n.retry).toBe(false);
  });

  it("offers a retry when the pull request is open but auto-merge isn't on", () => {
    const n = pullRequestNote({ state: "open", number: 9, auto_merge: false, error: "The pull request is open, but auto-merge isn't on: not allowed." }, REPO);
    expect(n.text).toBe("The pull request is open, but auto-merge isn't on: not allowed.");
    expect(n.retry).toBe(true);
  });

  it("shows no retry while one is running", () => {
    expect(pullRequestNote({ state: "opening" }, REPO)).toEqual({ text: "Opening a pull request on GitHub.", retry: false });
  });

  it("names the state in a few words for a list row", () => {
    expect(pullRequestBadge({ state: "waiting" }, REPO)).toBe("pull request waiting");
    expect(pullRequestBadge({ state: "open", auto_merge: true }, REPO)).toBe("pull request open");
    expect(pullRequestBadge({ state: "opening" }, REPO)).toBe("opening pull request");
  });
});

describe("a part whose pull request was closed without merging", () => {
  const closed = { state: "closed", url: "https://github.com/globex/woodchuck/pull/9", number: 9 } as const;

  it("says the pull request is closed, that the part still works, and what to do next", () => {
    const n = pullRequestNote(closed, REPO);
    expect(n.text).toBe(
      "Pull request closed without merging. The part still works in your designs. Open a new pull request to share it, or remove it from the library.",
    );
    expect(n.retry).toBe(true);
  });

  it("puts what GitHub last said before the next step", () => {
    expect(pullRequestNote({ ...closed, error: "error connecting to api.github.com" }, REPO).text).toBe(
      "Pull request closed without merging. error connecting to api.github.com. The part still works in your designs. Open a new pull request to share it, or remove it from the library.",
    );
  });

  it("offers a new pull request and removal for a closed part, and neither removal nor the new wording for the rest", () => {
    expect(retryLabel(closed)).toBe("Open a new pull request");
    expect(canRemove(closed)).toBe(true);
    for (const pr of [{ state: "waiting" }, { state: "opening" }, { state: "open", auto_merge: false }, { state: "open", auto_merge: true }] as const) {
      expect(canRemove(pr), pr.state).toBe(false);
      expect(retryLabel(pr), pr.state).toBe("Retry");
    }
  });

  it("names the state in a few words for a list row", () => {
    expect(pullRequestBadge(closed, REPO)).toBe("pull request closed");
  });
});

describe("a part while GitHub is off", () => {
  it("says it's kept on this computer, how to turn GitHub on, and offers no retry", () => {
    expect(pullRequestNote({ state: "waiting" }, null)).toEqual({ text: PART_KEPT, retry: false });
    expect(PART_KEPT).toBe(
      "Kept on this computer, where it works in your designs. Sharing it as a pull request is off. To turn it on, add WOODCHUCK_REPO=owner/name to the .env file in the Woodchuck folder, then restart Woodchuck.",
    );
    expect(pullRequestBadge({ state: "waiting" }, null)).toBe("kept on this computer");
  });

  it("still says where a pull request opened before got to", () => {
    const closed = { state: "closed", url: "https://github.com/globex/woodchuck/pull/9", number: 9 } as const;
    expect(pullRequestNote(closed, null).text).toMatch(/^Pull request closed without merging\./);
    expect(pullRequestBadge(closed, null)).toBe("pull request closed");
  });
});
