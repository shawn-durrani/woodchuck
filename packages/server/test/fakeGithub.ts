// A stand-in for GitHub. It keeps a tiny repo in memory and records every
// call, so a test can see exactly what the app asked for and no test can reach
// the real GitHub.

import type { GitHub, PullRequestRef, PullRequestState } from "../src/github.js";

export class FakeGitHub implements GitHub {
  calls: { method: string; repo: string; args: unknown[] }[] = [];
  /** Methods that fail, with what GitHub says, until you delete them. */
  failing = new Map<string, string>();
  /** Holds every call until it's released, so a test can look at a part mid-way. */
  gate: Promise<void> | null = null;
  readonly main = { sha: "main-sha", tree: "main-tree" };
  blobs = new Map<string, string>();
  trees = new Map<string, { base: string; path: string; blob: string }>();
  commits = new Map<string, { message: string; tree: string; parent: string }>();
  branches = new Map<string, string>();
  pulls: { number: number; url: string; base: string; head: string; title: string; body: string; autoMerge: boolean; state: PullRequestState }[] = [];

  private async hit(method: string, repo: string, ...args: unknown[]) {
    this.calls.push({ method, repo, args });
    await this.gate;
    const why = this.failing.get(method);
    if (why) throw new Error(why);
  }

  names = () => this.calls.map((c) => c.method);

  async mainCommit(repo: string) {
    await this.hit("mainCommit", repo);
    return { ...this.main };
  }
  async createBlob(repo: string, content: string) {
    await this.hit("createBlob", repo, content);
    const sha = `blob-${this.blobs.size + 1}`;
    this.blobs.set(sha, content);
    return sha;
  }
  async createTree(repo: string, baseTree: string, file: { path: string; blob: string }) {
    await this.hit("createTree", repo, baseTree, file);
    const sha = `tree-${this.trees.size + 1}`;
    this.trees.set(sha, { base: baseTree, path: file.path, blob: file.blob });
    return sha;
  }
  async createCommit(repo: string, c: { message: string; tree: string; parent: string }) {
    await this.hit("createCommit", repo, c);
    const sha = `commit-${this.commits.size + 1}`;
    this.commits.set(sha, c);
    return sha;
  }
  async setBranch(repo: string, branch: string, sha: string) {
    await this.hit("setBranch", repo, branch, sha);
    this.branches.set(branch, sha);
  }
  async findPullRequest(repo: string, branch: string): Promise<PullRequestRef | null> {
    await this.hit("findPullRequest", repo, branch);
    // Only an open pull request, as GitHub's own listing does. A closed one doesn't stop a new one.
    const found = this.pulls.find((p) => p.head === branch && p.state === "open");
    return found ? { number: found.number, url: found.url } : null;
  }
  async createPullRequest(repo: string, pr: { base: string; head: string; title: string; body: string }) {
    await this.hit("createPullRequest", repo, pr);
    const number = this.pulls.length + 1;
    const made = { ...pr, number, url: `https://github.com/${repo}/pull/${number}`, autoMerge: false, state: "open" as PullRequestState };
    this.pulls.push(made);
    return { number, url: made.url };
  }
  async enableAutoMerge(repo: string, number: number) {
    await this.hit("enableAutoMerge", repo, number);
    this.pulls.find((p) => p.number === number)!.autoMerge = true;
  }

  async pullRequestState(repo: string, number: number): Promise<PullRequestState> {
    await this.hit("pullRequestState", repo, number);
    const found = this.pulls.find((p) => p.number === number);
    if (!found) throw new Error(`Could not resolve to a PullRequest with the number of ${number}.`);
    return found.state;
  }

  /** What happens on GitHub itself: someone closes the pull request without merging it, or it merges. */
  close(number: number) {
    this.pulls.find((p) => p.number === number)!.state = "closed";
  }
  merge(number: number) {
    this.pulls.find((p) => p.number === number)!.state = "merged";
  }

  /** The one file the branch adds, as the repo would hold it. */
  fileOn(branch: string) {
    const commit = this.commits.get(this.branches.get(branch) ?? "");
    const tree = commit && this.trees.get(commit.tree);
    return commit && tree ? { path: tree.path, content: this.blobs.get(tree.blob), baseTree: tree.base, parent: commit.parent, message: commit.message } : undefined;
  }
}
