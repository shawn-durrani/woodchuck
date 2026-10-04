// Everything the app does on GitHub for the parts library, behind one
// interface so tests can pass a stand-in. The real one drives the gh command
// line tool with your login, the same access that files missing-tool issues.
// It works through GitHub's API, so it never clones the repo or touches a
// working tree. It only ever acts in the repository you name in
// WOODCHUCK_REPO, and with none named it stays off.

import { execFile } from "node:child_process";
import { tmpdir } from "node:os";

export class RepoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoError";
  }
}

/** What the app says while no repository is named. */
export const GITHUB_OFF = "GitHub is off until you name a repository. Add WOODCHUCK_REPO=owner/name to the .env file in the Woodchuck folder, then restart Woodchuck.";

/** The repository WOODCHUCK_REPO names, or null while it's unset, which keeps GitHub off. */
export function repoFromEnv(value = process.env.WOODCHUCK_REPO): string | null {
  return value?.trim() || null;
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** Checks a repository is written owner/name. */
export function parseRepo(value: string): { owner: string; name: string; full: string } {
  const [owner, name, ...rest] = value.trim().split("/");
  if (!owner || !name || rest.length || !OWNER.test(owner) || !NAME.test(name) || name === "." || name === "..") {
    throw new RepoError(`The repository "${value}" must be written owner/name`);
  }
  return { owner, name, full: `${owner}/${name}` };
}

export interface PullRequestRef {
  number: number;
  url: string;
}

/** Where a pull request stands. One closed without merging is "closed", and a merged one is "merged". */
export type PullRequestState = "open" | "closed" | "merged";

/** One method for each thing the app asks of GitHub. The repo is always owner/name. */
export interface GitHub {
  /** The commit the main branch points at, and that commit's tree. */
  mainCommit(repo: string): Promise<{ sha: string; tree: string }>;
  /** Stores a file's text, and returns the blob's sha. */
  createBlob(repo: string, content: string): Promise<string>;
  /** A tree that is the base tree plus one file, so every other file stays as it is. */
  createTree(repo: string, baseTree: string, file: { path: string; blob: string }): Promise<string>;
  createCommit(repo: string, commit: { message: string; tree: string; parent: string }): Promise<string>;
  /** Points a branch at a commit, making the branch if it isn't there yet. */
  setBranch(repo: string, branch: string, sha: string): Promise<void>;
  /** The open pull request from a branch into main, if there is one. */
  findPullRequest(repo: string, branch: string): Promise<PullRequestRef | null>;
  createPullRequest(repo: string, pr: { base: string; head: string; title: string; body: string }): Promise<PullRequestRef>;
  /** Squash-merges the pull request by itself once its checks pass. */
  enableAutoMerge(repo: string, number: number): Promise<void>;
  /** Whether the pull request is still open, was closed without merging, or merged. */
  pullRequestState(repo: string, number: number): Promise<PullRequestState>;
}

/** Runs gh with these arguments, and the text to send it on standard input. */
export type GhRun = (args: string[], stdin?: string) => Promise<string>;

/** The real runner. It runs from a neutral folder, so gh never looks at a checkout. */
const runGh: GhRun = (args, stdin) =>
  new Promise((resolve, reject) => {
    const child = execFile("gh", args, { timeout: 30_000, maxBuffer: 5_000_000, cwd: tmpdir() }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      resolve(stdout);
    });
    child.stdin?.end(stdin ?? "");
  });

function field<T>(json: string, read: (j: Record<string, unknown>) => T | undefined, what: string): T {
  let value: T | undefined;
  try {
    value = read(JSON.parse(json) as Record<string, unknown>);
  } catch {
    value = undefined;
  }
  if (value === undefined) throw new Error(`GitHub's answer had no ${what}`);
  return value;
}

const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);

function pullRequestFrom(repo: string, url: string): PullRequestRef {
  const link = url.trim().split("\n").pop() ?? "";
  const m = new RegExp(`^https://github\\.com/${repo.replace(/[.]/g, "\\.")}/pull/(\\d+)$`, "i").exec(link);
  if (!m) throw new Error("GitHub didn't return a pull request link");
  return { number: Number(m[1]), url: link };
}

/** The gh command line tool, run with your login. Pass a runner in tests to see the commands. */
export function ghCli(run: GhRun = runGh): GitHub {
  const api = (repo: string, route: string, method?: "POST" | "PATCH", body?: unknown) => {
    const base = parseRepo(repo).full;
    const path = `repos/${base}/${route}`;
    return method ? run(["api", path, "--method", method, "--input", "-"], JSON.stringify(body)) : run(["api", path]);
  };
  return {
    async mainCommit(repo) {
      const ref = await api(repo, "git/ref/heads/main");
      const sha = field(ref, (j) => text((j.object as Record<string, unknown>)?.sha), "commit for main");
      const commit = await api(repo, `git/commits/${sha}`);
      return { sha, tree: field(commit, (j) => text((j.tree as Record<string, unknown>)?.sha), "tree for main") };
    },
    async createBlob(repo, content) {
      return field(await api(repo, "git/blobs", "POST", { content, encoding: "utf-8" }), (j) => text(j.sha), "blob");
    },
    async createTree(repo, baseTree, file) {
      const tree = [{ path: file.path, mode: "100644", type: "blob", sha: file.blob }];
      return field(await api(repo, "git/trees", "POST", { base_tree: baseTree, tree }), (j) => text(j.sha), "tree");
    },
    async createCommit(repo, c) {
      return field(await api(repo, "git/commits", "POST", { message: c.message, tree: c.tree, parents: [c.parent] }), (j) => text(j.sha), "commit");
    },
    async setBranch(repo, branch, sha) {
      try {
        await api(repo, "git/refs", "POST", { ref: `refs/heads/${branch}`, sha });
      } catch (e) {
        // An earlier try left the branch behind. It's the app's own part/ branch with no open pull request, so move it.
        if (!/already exists/i.test((e as Error).message)) throw e;
        await api(repo, `git/refs/heads/${branch}`, "PATCH", { sha, force: true });
      }
    },
    async findPullRequest(repo, branch) {
      const full = parseRepo(repo).full;
      const out = await run(["pr", "list", "-R", full, "--head", branch, "--base", "main", "--state", "open", "--json", "number,url", "--limit", "1"]);
      const found = (JSON.parse(out) as { number: number; url: string }[])[0];
      return found ? { number: found.number, url: found.url } : null;
    },
    async createPullRequest(repo, pr) {
      const full = parseRepo(repo).full;
      const out = await run(["pr", "create", "-R", full, "--base", pr.base, "--head", pr.head, "--title", pr.title, "--body", pr.body]);
      return pullRequestFrom(full, out);
    },
    async enableAutoMerge(repo, number) {
      await run(["pr", "merge", String(number), "-R", parseRepo(repo).full, "--auto", "--squash"]);
    },
    async pullRequestState(repo, number) {
      const full = parseRepo(repo).full;
      // The number comes from a file in the data folder, so it never reaches gh unless it's a plain number.
      if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${number} isn't a pull request number`);
      const out = await run(["pr", "view", String(number), "-R", full, "--json", "state,mergedAt"]);
      return field(
        out,
        (j) => {
          const state = typeof j.state === "string" ? j.state.toUpperCase() : "";
          if (state === "OPEN") return "open" as const;
          // A merged pull request is closed too, so a merge date settles which.
          if (state === "MERGED" || (state === "CLOSED" && text(j.mergedAt))) return "merged" as const;
          return state === "CLOSED" ? ("closed" as const) : undefined;
        },
        "state",
      );
    },
  };
}
