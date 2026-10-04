// The parts library. Merged parts are JSON files in the repo's library/parts
// folder, shared through git. Claude's proposals wait in the data folder until
// you approve or decline them. An approved part works at once from the data
// folder too, while its pull request waits to merge. The running app never
// writes into library/parts.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LibraryError, PART_KINDS, validateLibraryPart, type LibraryPart } from "@woodchuck/core";
import { parseRepo, type GitHub, type PullRequestState } from "./github.js";
import { openPartPullRequest, type PullRequestStatus } from "./partpr.js";

export interface Proposal {
  id: string;
  part: LibraryPart;
  status: "proposed" | "approved" | "changes_requested";
  at: string;
}

/** An approved part kept in the data folder until its pull request merges. */
interface PendingFile {
  part: LibraryPart;
  pull_request: PullRequestStatus;
}

/** The pull request is one in this repository, so asking the repository about its number is safe. */
function isOn(repo: string, pr: PullRequestStatus): pr is PullRequestStatus & { number: number; url: string } {
  return (
    typeof pr.number === "number" &&
    Number.isSafeInteger(pr.number) &&
    pr.number > 0 &&
    typeof pr.url === "string" &&
    pr.url.toLowerCase() === `https://github.com/${repo}/pull/${pr.number}`.toLowerCase()
  );
}

export interface BrokenFile {
  file: string;
  error: string;
  /** It's one of the approved parts kept in the data folder, not a file in library/parts. */
  pending?: true;
}

export class PartsLibrary {
  /** Parts whose pull request is being opened right now. */
  private sharing = new Map<string, Promise<PullRequestStatus>>();
  readonly pendingDir: string;

  constructor(
    /** The repo's library/parts folder. It's only ever read. */
    readonly dir: string,
    private proposalsFile: string,
    /** Approved parts waiting for their pull request to merge. Beside the proposals by default. */
    pendingDir?: string,
  ) {
    this.pendingDir = pendingDir ?? path.join(path.dirname(proposalsFile), "library-pending");
  }

  /** Reads every part file in a folder. A file that fails validation is reported, not hidden. */
  private read<T extends { part: LibraryPart }>(dir: string, open: (json: unknown) => T, pending?: true) {
    const found: T[] = [];
    const broken: BrokenFile[] = [];
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
    for (const file of files) {
      try {
        const item = open(JSON.parse(readFileSync(path.join(dir, file), "utf8")));
        if (`${item.part.id}.json` !== file) throw new LibraryError(`the file should be named ${item.part.id}.json`);
        found.push(item);
      } catch (e) {
        broken.push({ file, error: (e as Error).message, ...(pending ? { pending } : {}) });
      }
    }
    return { found, broken };
  }

  private scan() {
    const merged = this.read(this.dir, (json) => ({ part: validateLibraryPart(json) }));
    const kept = this.read<PendingFile>(
      this.pendingDir,
      (json) => {
        const o = json as { part?: unknown; pull_request?: Partial<PullRequestStatus> };
        const pr = o.pull_request;
        const status: PullRequestStatus =
          pr?.state === "open" || pr?.state === "closed" ? { ...pr, state: pr.state } : { state: "waiting", ...(pr?.error ? { error: pr.error } : {}) };
        return { part: validateLibraryPart(o.part), pull_request: status };
      },
      true,
    );
    // Once the merged file is in library/parts, the pending copy has done its job.
    const have = new Set(merged.found.map((m) => m.part.id));
    const dropped = kept.found.filter((k) => have.has(k.part.id)).map((k) => k.part.id);
    for (const id of dropped) rmSync(path.join(this.pendingDir, `${id}.json`), { force: true });
    return { merged: merged.found, pending: kept.found.filter((k) => !have.has(k.part.id)), broken: [...merged.broken, ...kept.broken], dropped };
  }

  /**
   * Merged parts and pending ones together, so an approved part works at
   * once. `pending` marks the ones still waiting for their pull request.
   */
  list(): { parts: LibraryPart[]; pending: Record<string, PullRequestStatus>; broken: BrokenFile[] } {
    const s = this.scan();
    const parts = [...s.merged.map((m) => m.part), ...s.pending.map((p) => p.part)].sort((a, b) => a.id.localeCompare(b.id));
    const pending = Object.fromEntries(
      s.pending.map((p) => [p.part.id, this.sharing.has(p.part.id) ? { ...p.pull_request, state: "opening" as const } : p.pull_request]),
    );
    return { parts, pending, broken: s.broken };
  }

  /** Drops each pending part whose file has arrived in library/parts. Returns their ids. */
  handOver(): string[] {
    return this.scan().dropped;
  }

  get(id: string): LibraryPart | undefined {
    return this.list().parts.find((p) => p.id === id);
  }

  proposals(): Proposal[] {
    return existsSync(this.proposalsFile) ? (JSON.parse(readFileSync(this.proposalsFile, "utf8")) as Proposal[]) : [];
  }

  private saveProposals(all: Proposal[]) {
    const tmp = `${this.proposalsFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    renameSync(tmp, this.proposalsFile);
  }

  private savePending(file: PendingFile) {
    mkdirSync(this.pendingDir, { recursive: true, mode: 0o700 });
    const target = path.join(this.pendingDir, `${file.part.id}.json`);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    renameSync(tmp, target);
  }

  propose(input: unknown): Proposal {
    const part = validateLibraryPart(input);
    delete part.approved_at;
    if (this.get(part.id)) throw new LibraryError(`${part.id} is already in the library. Use it, or pick a new id for a different part`);
    const all = this.proposals();
    const p: Proposal = { id: `pp_${all.length + 1}`, part, status: "proposed", at: new Date().toISOString() };
    all.push(p);
    this.saveProposals(all);
    return p;
  }

  /** The newest proposal still waiting on you. */
  waiting(): Proposal | undefined {
    return [...this.proposals()].reverse().find((p) => p.status === "proposed");
  }

  /**
   * Keeps an approved part in the data folder, where designs can use it at
   * once. Sharing it through a pull request is a separate step, since that
   * needs GitHub and the part shouldn't wait on it.
   */
  approve(id: string): LibraryPart {
    const all = this.proposals();
    const p = all.find((x) => x.id === id);
    if (!p || p.status !== "proposed") throw new LibraryError(`There's no proposal ${id} waiting`);
    if (this.get(p.part.id)) throw new LibraryError(`${p.part.id} is already in the library`);
    const part: LibraryPart = { ...p.part, approved_at: new Date().toISOString() };
    this.savePending({ part, pull_request: { state: "waiting" } });
    p.status = "approved";
    this.saveProposals(all);
    return part;
  }

  /**
   * Opens the pending part's pull request, or finishes one that stopped
   * partway, and keeps what GitHub said on the part. A second call while one
   * is running waits for that one.
   */
  share(id: string, github: GitHub, repo: string): Promise<PullRequestStatus> {
    const running = this.sharing.get(id);
    if (running) return running;
    const pending = this.scan().pending.find((p) => p.part.id === id);
    if (!pending) return Promise.reject(new LibraryError(`There's no part ${id} waiting for a pull request`));
    const run = openPartPullRequest(github, repo, pending.part, pending.pull_request)
      .then((status) => {
        // The part may have arrived in library/parts while GitHub was answering.
        if (existsSync(path.join(this.pendingDir, `${id}.json`))) this.savePending({ part: pending.part, pull_request: status });
        return status;
      })
      .finally(() => this.sharing.delete(id));
    this.sharing.set(id, run);
    return run;
  }

  /**
   * Asks GitHub about each part whose pull request is open, and marks one
   * that was closed without merging. A merged one is left for the hand-over,
   * which drops its copy once the file arrives. It only asks the repository
   * it's given, and only about pull requests that live there. When GitHub
   * can't be reached nothing changes. Returns the ids it marked closed.
   */
  async syncPullRequests(github: GitHub, repoName: string): Promise<string[]> {
    let repo: string;
    try {
      repo = parseRepo(repoName).full;
    } catch {
      // A repository the app won't act in has no pull requests to ask about.
      return [];
    }
    const closed: string[] = [];
    for (const { part, pull_request: pr } of this.scan().pending) {
      if (pr.state !== "open" || !isOn(repo, pr) || this.sharing.has(part.id)) continue;
      let state: PullRequestState;
      try {
        state = await github.pullRequestState(repo, pr.number);
      } catch {
        continue;
      }
      if (state !== "closed") continue;
      // A retry may have opened a new pull request, or the file may have arrived, while GitHub answered.
      const now = this.scan().pending.find((p) => p.part.id === part.id);
      if (!now || this.sharing.has(part.id) || now.pull_request.state !== "open" || now.pull_request.number !== pr.number) continue;
      this.savePending({ part: now.part, pull_request: { state: "closed", url: pr.url, number: pr.number } });
      closed.push(part.id);
    }
    return closed;
  }

  /**
   * Takes a part whose pull request was closed out of the library. Only its
   * pending copy goes. A design that uses it keeps the specs and model it
   * was given, since they're stored in the design itself.
   */
  remove(id: string): void {
    if (this.sharing.has(id)) throw new LibraryError(`${id} is having its pull request opened right now. Try again in a moment`);
    const found = this.scan().pending.find((p) => p.part.id === id);
    if (!found) throw new LibraryError(`There's no part ${id} waiting for a pull request`);
    if (found.pull_request.state !== "closed") throw new LibraryError(`${id} can only be removed once its pull request is closed`);
    rmSync(path.join(this.pendingDir, `${id}.json`), { force: true });
  }

  decline(id: string) {
    const all = this.proposals();
    const p = all.find((x) => x.id === id);
    if (p && p.status === "proposed") {
      p.status = "changes_requested";
      this.saveProposals(all);
    }
  }
}

/**
 * Parts matching a search, by name, kind, maker, model, SKU and id. Every
 * word must match somewhere, in any order and case. A kind narrows it further.
 */
export function searchParts(parts: LibraryPart[], query = "", kind = ""): LibraryPart[] {
  if (kind && !(PART_KINDS as readonly string[]).includes(kind)) throw new LibraryError(`kind "${kind}" isn't one of: ${PART_KINDS.join(", ")}`);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return parts
    .filter((p) => !kind || p.kind === kind)
    .filter((p) => {
      const hay = [p.name, p.kind, p.kind.replace(/_/g, " "), p.maker, p.model, p.sku, p.id].filter(Boolean).join("\n").toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
