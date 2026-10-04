// Every version of every design, in a local git repository inside the data
// folder. It tracks each design's design.json and nothing else: no chats,
// pictures or renders. Each change set you or Claude make is one commit,
// with who made it and what it was.
//
// The history is a convenience, so a git problem never stops the app. It's
// logged and the design still saves.

import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Design } from "@woodchuck/core";

export interface Version {
  sha: string;
  author: string;
  at: string;
  message: string;
}

const AUTHORS: Record<string, string> = {
  you: "You <you@example.com>",
  claude: "Claude <claude@example.com>",
  example: "Woodchuck <woodchuck@example.com>",
};

// Only each design's design.json is tracked.
const IGNORE = "/*/*\n!/*/design.json\n";

export class DesignHistory {
  private ok = true;

  constructor(private dir: string) {
    try {
      if (!existsSync(path.join(dir, ".git"))) {
        this.git(["init", "-q", "-b", "main"]);
        this.git(["config", "user.name", "Woodchuck"]);
        this.git(["config", "user.email", "woodchuck@example.com"]);
        this.git(["config", "commit.gpgsign", "false"]);
      }
      if (!existsSync(path.join(dir, ".gitignore"))) {
        writeFileSync(path.join(dir, ".gitignore"), IGNORE, { mode: 0o600 });
        this.git(["add", ".gitignore"]);
        this.git(["commit", "-q", "-m", "Start the design history"]);
      }
    } catch (e) {
      this.ok = false;
      console.error(`Design history is off: ${(e as Error).message}`);
    }
  }

  private git(args: string[]): string {
    return execFileSync("git", args, { cwd: this.dir, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
  }

  /** Records the design's current file as a version, if it changed. */
  commit(slug: string, message: string, author: keyof typeof AUTHORS) {
    if (!this.ok) return;
    try {
      this.git(["add", "-A", "--", slug]);
      const staged = this.git(["diff", "--cached", "--name-only", "--", slug]).trim();
      if (!staged) return;
      this.git(["commit", "-q", "--author", AUTHORS[author] ?? AUTHORS.you!, "-m", message.slice(0, 200) || "Change", "--", slug]);
    } catch (e) {
      console.error(`Couldn't record a version of ${slug}: ${(e as Error).message}`);
    }
  }

  /** Versions of one design, newest first. */
  log(slug: string, limit = 200): Version[] {
    if (!this.ok) return [];
    try {
      const out = this.git(["log", `-${limit}`, "--format=%H%x1f%an%x1f%aI%x1f%s", "--", `${slug}/design.json`]);
      return out
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [sha, author, at, message] = line.split("\x1f");
          return { sha: sha!, author: author!, at: at!, message: message ?? "" };
        });
    } catch {
      return [];
    }
  }

  /** The design as it was at a version, or the version before it. */
  show(slug: string, sha: string, parent = false): Design | null {
    if (!this.ok || !/^[0-9a-f]{7,40}$/.test(sha)) return null;
    try {
      return JSON.parse(this.git(["show", `${sha}${parent ? "^" : ""}:${slug}/design.json`])) as Design;
    } catch {
      return null;
    }
  }
}
